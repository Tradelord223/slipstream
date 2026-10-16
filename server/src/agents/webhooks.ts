import { createHmac } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { HttpError } from "../auth/users.ts";
import type { AppContext } from "../context.ts";
import type { ServerEvent } from "../events.ts";
import { newId, randomToken } from "../lib/crypto.ts";

/**
 * Outbound webhooks: agents that would rather be told than poll. Each delivery is signed:
 *   X-Slipstream-Signature: v1=<hex HMAC-SHA256(secret, `${timestamp}.${body}`)>
 * In team mode, targets must be public HTTPS hosts; the check runs at connect time, so DNS
 * rebinding can't point a delivery at the server's own network.
 */

export const WEBHOOK_EVENTS = ["threads", "drafts", "activity", "approval", "sync", "import"] as const;

interface WebhookRow {
  id: string;
  user_id: string;
  url: string;
  secret_enc: string;
  events: string;
  created_at: number;
  last_status: number | null;
  last_error: string | null;
  last_delivery_at: number | null;
}

const RETRY_DELAYS = [1_000, 5_000, 25_000];

export function sign(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Private, loopback, link-local, CGNAT and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  );
}

export class Webhooks {
  private ctx: AppContext;
  private stop: (() => void) | null = null;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  start() {
    this.stop = this.ctx.events.onAnyUser((userId, event) => this.dispatch(userId, event));
  }

  close() {
    this.stop?.();
  }

  list(userId: string) {
    return this.ctx.db
      .all<WebhookRow>("SELECT * FROM webhooks WHERE user_id = ? ORDER BY created_at", userId)
      .map((w) => ({
        id: w.id,
        url: w.url,
        events: JSON.parse(w.events) as string[],
        createdAt: w.created_at,
        lastStatus: w.last_status,
        lastError: w.last_error,
        lastDeliveryAt: w.last_delivery_at,
      }));
  }

  create(userId: string, url: string, events: string[]) {
    const parsed = new URL(url);
    if (this.ctx.config.mode === "team" && parsed.protocol !== "https:") throw new HttpError(400, "Webhook URLs must use https");
    if (!["http:", "https:"].includes(parsed.protocol)) throw new HttpError(400, "Webhook URLs must be http or https");
    const secret = `whsec_${randomToken(24)}`;
    const id = newId("whk");
    this.ctx.db.run(
      "INSERT INTO webhooks (id, user_id, url, secret_enc, events, created_at) VALUES (?,?,?,?,?,?)",
      id,
      userId,
      parsed.toString(),
      this.ctx.secrets.seal(secret),
      JSON.stringify(events.length ? events : ["*"]),
      Date.now(),
    );
    // The signing secret is shown once.
    return { id, secret };
  }

  remove(userId: string, id: string) {
    if (this.ctx.db.run("DELETE FROM webhooks WHERE id = ? AND user_id = ?", id, userId).changes === 0) throw new HttpError(404, "Webhook not found");
  }

  private dispatch(userId: string, event: ServerEvent) {
    const hooks = this.ctx.db.all<WebhookRow>("SELECT * FROM webhooks WHERE user_id = ?", userId);
    for (const h of hooks) {
      const wanted = JSON.parse(h.events) as string[];
      if (!wanted.includes("*") && !wanted.includes(event.type)) continue;
      this.deliver(h, event).catch((err) => console.error("[slipstream] webhook delivery:", err));
    }
  }

  /** Deliver one event, with retries. Returns the final HTTP status (or 0 when it never connected). */
  async deliver(h: WebhookRow, event: ServerEvent | { type: "ping" }): Promise<number> {
    const body = JSON.stringify({ id: newId("evt"), type: event.type, createdAt: new Date().toISOString(), data: event });
    const secret = this.ctx.secrets.open<string>(h.secret_enc);
    let status = 0;
    let error: string | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      try {
        status = await this.post(h.url, body, {
          "content-type": "application/json",
          "user-agent": "Slipstream-Webhooks/1",
          "x-slipstream-event": event.type,
          "x-slipstream-timestamp": timestamp,
          "x-slipstream-signature": sign(secret, timestamp, body),
        });
        error = status >= 200 && status < 300 ? null : `HTTP ${status}`;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        status = 0;
      }
      if (!error || (status >= 400 && status < 500 && status !== 429)) break;
      if (attempt < RETRY_DELAYS.length) await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]).unref());
    }
    this.ctx.db.run("UPDATE webhooks SET last_status = ?, last_error = ?, last_delivery_at = ? WHERE id = ?", status, error, Date.now(), h.id);
    return status;
  }

  async test(userId: string, id: string) {
    const h = this.ctx.db.get<WebhookRow>("SELECT * FROM webhooks WHERE id = ? AND user_id = ?", id, userId);
    if (!h) throw new HttpError(404, "Webhook not found");
    return { status: await this.deliver(h, { type: "ping" }) };
  }

  private post(url: string, body: string, headers: Record<string, string>): Promise<number> {
    const u = new URL(url);
    const guard = this.ctx.config.mode === "team";
    const lookup = (hostname: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return cb(err, "");
        const list = addresses as LookupAddress[];
        if (guard && list.some((a) => isPrivateAddress(a.address))) return cb(Object.assign(new Error("Webhook target resolves to a private address"), { code: "EBLOCKED" }), "");
        cb(null, list);
      });
    };
    if (guard && isIP(u.hostname) && isPrivateAddress(u.hostname)) return Promise.reject(new Error("Webhook target is a private address"));
    const send = u.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = send(u, { method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) }, lookup, timeout: 5_000 }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("timeout", () => req.destroy(new Error("Timed out")));
      req.on("error", reject);
      req.end(body);
    });
  }
}

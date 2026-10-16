import { Hono } from "hono";
import type { AppContext, Env } from "../context.ts";
import { DEMO_LOGOS } from "../mail/demo-logos.ts";
import { logoDomain, mailFromDomain } from "../mail/logos.ts";

/** Same hardening as downloads, plus inline styles because logos often style their shapes that way. */
const LOGO_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "cache-control": "private, max-age=604800",
  "content-disposition": "inline",
};

/** A miss is cached for an hour so a list of senders doesn't ask again on every render. */
const MISS_HEADERS = { "cache-control": "private, max-age=3600" };

export function logoRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  /**
   * A sender's logo, from the cache only. The route never fetches while you wait and never streams a remote
   * response: uncached domains answer 404 now and are fetched hours later (see SenderLogos.cached).
   */
  app.get("/logos/:domain", (c) => {
    const none = () => c.json({ error: "No logo" }, 404, MISS_HEADERS);
    const user = c.get("user");
    // A page on another site could load this as an image and learn, from success or failure, who writes to you.
    // Fail closed: browsers send Sec-Fetch-Site on every image load, so a missing header is refused like a foreign one.
    if (c.req.header("sec-fetch-site") !== "same-origin") return none();
    if (!ctx.config.senderLogos) return none();
    const setting = ctx.logos.userSetting(user.id);
    if (setting === false) return none();

    const domain = c.req.param("domain").toLowerCase();
    // Only a registrable domain, exactly as logoDomain would produce it from an address.
    if (logoDomain(`x@${domain}`) !== domain) return none();
    const mail = mailFromDomain(ctx.db, user.id, domain);
    if (!mail.any) return none();

    if (mail.allDemo) {
      // Demo mail never touches the network, and the bundled marks are not fetched, so they show without opting in.
      const svg = DEMO_LOGOS[domain];
      if (!svg) return none();
      return c.body(svg, 200, { ...LOGO_HEADERS, "content-type": "image/svg+xml" });
    }
    if (setting !== true) return none();

    const logo = ctx.logos.cached(domain, user.id);
    if (!logo) return none();
    return c.body(new Uint8Array(logo.bytes), 200, { ...LOGO_HEADERS, "content-type": logo.contentType });
  });

  return app;
}

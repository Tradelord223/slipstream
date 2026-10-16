import { Hono } from "hono";
import { HttpError } from "../auth/users.ts";
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

export function logoRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  /**
   * A sender's logo, from the cache only. The route never fetches while you wait and never streams a remote
   * response: uncached domains answer 404 now and are fetched hours later (see SenderLogos.cached).
   */
  app.get("/logos/:domain", (c) => {
    const user = c.get("user");
    // A page on another site could load this as an image and learn, from success or failure, who writes to you.
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") throw new HttpError(404, "No logo");
    if (!ctx.config.senderLogos) throw new HttpError(404, "No logo");
    const setting = ctx.logos.userSetting(user.id);
    if (setting === false) throw new HttpError(404, "No logo");

    const domain = c.req.param("domain").toLowerCase();
    // Only a registrable domain, exactly as logoDomain would produce it from an address.
    if (logoDomain(`x@${domain}`) !== domain) throw new HttpError(404, "No logo");
    const mail = mailFromDomain(ctx.db, user.id, domain);
    if (!mail.any) throw new HttpError(404, "No logo");

    if (mail.allDemo) {
      // Demo mail never touches the network, and the bundled marks are not fetched, so they show without opting in.
      const svg = DEMO_LOGOS[domain];
      if (!svg) throw new HttpError(404, "No logo");
      return c.body(svg, 200, { ...LOGO_HEADERS, "content-type": "image/svg+xml" });
    }
    if (setting !== true) throw new HttpError(404, "No logo");

    const logo = ctx.logos.cached(domain, user.id);
    if (!logo) throw new HttpError(404, "No logo");
    return c.body(new Uint8Array(logo.bytes), 200, { ...LOGO_HEADERS, "content-type": logo.contentType });
  });

  return app;
}

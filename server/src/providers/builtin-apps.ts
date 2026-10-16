/**
 * Slipstream's own public Microsoft app, so "Sign in with Microsoft" works on a local install without anyone
 * registering an app first. It is a public client (PKCE, no secret), so the id is safe to ship.
 * Empty until the app is registered (see "Register Slipstream's Microsoft app" in docs/connect-accounts.md); then
 * paste the Application (client) ID here. While it is empty, Microsoft sign-in needs MICROSOFT_CLIENT_ID.
 */
export const BUILT_IN_MICROSOFT_CLIENT_ID = "";

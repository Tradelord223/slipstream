# Security policy

Slipstream reads your email, holds your mail-account sign-ins and gives agents access to your inbox, so security reports get priority.

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue or pull request for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with it. Reports are usually acknowledged within a few days. Fixes ship as a new release with credit to you, unless you'd rather stay anonymous.

## Supported versions

Security fixes go into the latest release on npm (`slipstream-mail`) and the `main` branch.

## What's in scope

- Anything that lets an email, a sender's website or another person run code, read data or make network requests they shouldn't.
- Ways around agent scopes, the Review queue, approval policies or run limits.
- Leaks of mail, credentials, keys or one-time codes, including to AI models beyond what [docs/security.md](docs/security.md) describes.
- Server-side request forgery through sender logos, unsubscribe links or webhooks.

## How Slipstream protects you

The security model, including how hostile email is rendered and what is encrypted at rest, is written up in [docs/security.md](docs/security.md). `npm run test:render` renders a set of hostile emails in a real browser and fails if any of them run script or reach the network.

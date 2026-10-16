# Connecting your mail

Slipstream can work with mail in four ways. Pick whichever fits, and mix them freely: every account shows up in one unified inbox.

| You have | Fastest path | Setup |
|---|---|---|
| Gmail (personal) | IMAP with an app password | 2 minutes, no developer console |
| Gmail / Google Workspace | Google OAuth | ~10 minutes, once per Slipstream install |
| Outlook.com / Microsoft 365 | Microsoft OAuth | ~10 minutes, once per install |
| iCloud, Fastmail, Yahoo, Zoho, Proton (Bridge), any other server | IMAP + SMTP | 2 minutes |
| An export (Google Takeout, Thunderbird, Apple Mail) | Import `.mbox` / `.eml` | none |

Credentials are encrypted on your own disk (AES-256-GCM) and never leave your machine except to talk to your mail provider.

## Gmail with an app password (no OAuth app needed)

1. Turn on 2-Step Verification for your Google account.
2. Create an app password at <https://myaccount.google.com/apppasswords>.
3. In Slipstream: Settings → Accounts → **Connect another mail server** → preset **Gmail**, enter your address and the 16-character app password.

Slipstream uses Gmail's IMAP extensions, so labels and conversations behave like they do in Gmail. Google Workspace accounts and accounts with Advanced Protection can't use app passwords; use OAuth below.

## Gmail / Google Workspace with OAuth

Google treats full mailbox access as a *restricted* scope. A public, verified app needs a yearly security assessment, which an open-source project shouldn't ask every user to trust. So each Slipstream install brings its own Google OAuth client. It takes about ten minutes, once:

1. Open the Google Cloud console → create a project (any name).
2. **APIs & Services → Library** → enable the **Gmail API**.
3. **OAuth consent screen** (Google Auth Platform): user type **External** (or **Internal** for a Workspace org), add your email as a test user, add the scope `https://www.googleapis.com/auth/gmail.modify`.
4. **Credentials → Create credentials → OAuth client ID**:
   - Running locally: type **Desktop app**.
   - Self-hosted: type **Web application** with redirect URI `https://<your-host>/api/oauth/google/callback`.
5. Start Slipstream with the client:
   ```bash
   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… slipstream
   ```
6. Settings → Accounts → **Connect Gmail**.

While the app is in *Testing*, Google expires refresh tokens after 7 days and caps it at 100 test users; Slipstream will ask you to reconnect. Internal (Workspace) apps and personal-use apps don't have that limit. For a personal install you can publish the app to *In production* without verification; Google shows an "unverified app" screen you click through once.

## Outlook / Microsoft 365

1. Open the Microsoft Entra admin center → **App registrations → New registration**.
2. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts** (or just your org).
3. Redirect URI:
   - Running locally: platform **Mobile and desktop applications**, URI `http://localhost` (Microsoft ignores the port for localhost, so this covers Slipstream's `http://localhost:4380/api/oauth/microsoft/callback`).
   - Self-hosted: platform **Web**, URI `https://<your-host>/api/oauth/microsoft/callback`, and create a client secret.
4. **API permissions** → Microsoft Graph → Delegated: `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`.
5. Start Slipstream with `MICROSOFT_CLIENT_ID=…` (and `MICROSOFT_CLIENT_SECRET=…` for a Web client; `MICROSOFT_TENANT=<tenant-id>` to restrict to one org).
6. Settings → Accounts → **Connect Outlook**.

Some work tenants require an administrator to approve new apps; if you see "Need admin approval", send your admin the app's client ID.

Microsoft has turned off password sign-in for Outlook.com and Exchange Online IMAP, so OAuth is the way in for Microsoft accounts.

## Any IMAP server

Settings → Accounts → **Connect another mail server**. Presets fill in the server names for iCloud, Fastmail, Yahoo, Zoho and Proton Mail Bridge; choose **Other** to type your own IMAP and SMTP hosts. Most providers want an app-specific password rather than your main one.

## Send from an alias or your own domain

An account can send as more than one address, such as `help@fernpoint.co` or an old address you still use. In a draft, pick the address in the From field. When you reply to a message that was sent to one of your aliases, Slipstream replies from that same alias.

- **Gmail (signed in with Google):** aliases show up on their own once you've added and verified them in Gmail under Settings → See all settings → Accounts and Import → Send mail as. Slipstream checks again every few hours. Change or remove an alias in Gmail, not in Slipstream.
- **Outlook and other mail servers (IMAP):** add the address yourself in Settings → Accounts, under the account. You can give it a name, a reply-to address and a signature. Your mail provider has to allow sending from that address, or it may refuse the message or rewrite the From. For a custom domain, that usually means adding the address as an alias in your provider's settings first.
- **Gmail with an app password:** add aliases by hand, the same as for any other mail server.

If you remove an address that a queued message was going to use, that message fails with a plain note instead of going out from a different address.

## Importing an export

Settings → Accounts → **Import mail**, then drop one or more files:

- **Google Takeout** (`.mbox`): labels, stars, read state and conversations come across.
- **Thunderbird / Apple Mail / mutt** (`.mbox`, `mboxrd`): messages land in Done and are fully searchable.
- **Single messages** (`.eml`).

Imports stream from disk, so multi-gigabyte archives are fine. Imported mail lives only in Slipstream; it can't send, so pick another account in the From field when replying.

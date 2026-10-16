# Connecting your mail

Slipstream can work with mail in four ways. Pick whichever fits, and mix them freely: every account shows up in one unified inbox.

Slipstream asks for your email address the first time you open it. To add another account later, go to Settings → Accounts → **Add account**. Slipstream reads your address's domain to find out who hosts your mail, using only that domain's own DNS records, then shows the sign-in that fits.

| You have | Fastest path | Setup |
|---|---|---|
| Gmail (personal) | IMAP with an app password | 2 minutes, no developer console |
| Gmail / Google Workspace | Continue with Google (OAuth) | ~10 minutes, once per Slipstream install |
| Outlook.com / Microsoft 365 | Continue with Microsoft (no app passwords) | ~10 minutes, once per install, unless your copy already includes it |
| iCloud, Fastmail, Yahoo, Zoho, Proton (Bridge), any other server | IMAP + SMTP | 2 minutes |
| An export (Google Takeout, Thunderbird, Apple Mail) | **Import a mail file** (`.mbox` / `.eml`) | none |

Credentials are encrypted on your own disk (AES-256-GCM) and never leave your machine except to talk to your mail provider.

## Outlook and Microsoft 365

Microsoft's notice says Basic authentication, which means sending a username and password to the mail server, is no longer available to access any Outlook account after September 16, 2024 ([Microsoft: Modern Authentication Methods now needed to continue syncing Outlook email in non-Microsoft email apps](https://support.microsoft.com/en-US/Support/known-issues/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-ap)). An app password is sent that way, so a password of any kind won't get you in over IMAP any more. Outlook.com, Hotmail, Live and Microsoft 365 mail all connect with **Continue with Microsoft**, which needs a Microsoft app registered once (the steps are below). Slipstream doesn't ship its own Microsoft app yet, so until it does, the button works only once your install has one: register your own and start Slipstream with its ID.

## Gmail with an app password (no OAuth app needed)

1. Turn on 2-Step Verification for your Google account.
2. Create an app password at <https://myaccount.google.com/apppasswords>.
3. In Slipstream, enter your Gmail address (on the first screen, or under Settings → Accounts → **Add account**), choose **Use an app password instead** if you're offered Google sign-in, and paste the 16-letter app password.

Slipstream uses Gmail's IMAP extensions, so labels and conversations behave like they do in Gmail.

**Google Workspace (work or school) addresses** work the same way when Google offers app passwords for the account. Google's help says you need 2-Step Verification to create an app password, and that the option may be missing if you're signed in to a work, school or other organization account, if your 2-Step Verification is set up only for security keys, or if your account has Advanced Protection ([Google: Sign in with app passwords](https://support.google.com/accounts/answer/185833)). For Workspace, Google's admin help says users can sign in to legacy apps with an app password, and that enforcing security keys as the 2-Step Verification method disables them ([Google Workspace: How 2-Step Verification works with legacy apps](https://knowledge.workspace.google.com/admin/security/how-2-step-verification-works-with-legacy-apps)). If you don't see the app passwords page, ask your administrator, or use Google OAuth below.

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
6. Settings → Accounts → **Add account**, enter your Gmail or Workspace address and choose **Continue with Google**.

While the app is in *Testing*, Google expires refresh tokens after 7 days and caps it at 100 test users; Slipstream will ask you to reconnect. Internal (Workspace) apps and personal-use apps don't have that limit. For a personal install you can publish the app to *In production* without verification; Google shows an "unverified app" screen you click through once.

## Register Slipstream's Microsoft app

You only do this if "Continue with Microsoft" isn't available in your copy of Slipstream. Slipstream doesn't include its own Microsoft app yet, so for now that's every install. It is free and takes about ten minutes, once. The app holds no password or secret, so there is nothing to keep safe except its ID.

1. Open the Microsoft Entra admin center (or the Azure portal) → **App registrations → New registration**. Name it `Slipstream`.
2. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**. (Choose just your organization if only work accounts will use it.)
3. Redirect URI:
   - Running on your own computer: add the platform **Mobile and desktop applications** and a custom redirect URI of exactly `http://localhost/api/oauth/microsoft/callback`, with no port. Slipstream sends `http://localhost:4380/api/oauth/microsoft/callback`. For `localhost`, Microsoft ignores the port when it compares addresses but does compare the rest, so the path has to be in what you register. A bare `http://localhost` doesn't match and Microsoft stops with "AADSTS50011: The reply URL specified in the request does not match the reply URLs configured for the application".
   - Self-hosted for a team: add the platform **Web** with `https://<your-host>/api/oauth/microsoft/callback`, and create a client secret.
4. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**: `User.Read`, `Mail.ReadWrite`, `Mail.Send` and `offline_access`.
5. **Authentication → Advanced settings → Allow public client flows**: **Yes**. (For a Web client with a secret, leave this alone.)
6. On the app's **Overview** page, copy the **Application (client) ID**.

Then start Slipstream with it:

```bash
MICROSOFT_CLIENT_ID=… slipstream
```

For a Web client add `MICROSOFT_CLIENT_SECRET=…` as well. `MICROSOFT_TENANT=<tenant-id>` limits sign-in to one organization.

Some work tenants need an administrator to approve new apps. If you see "Need admin approval", send your admin the app's client ID.

Finally, Settings → Accounts → **Add account**, enter your Outlook, Hotmail, Live or Microsoft 365 address and choose **Continue with Microsoft**.

## Any IMAP server

Settings → Accounts → **Add account** and enter your address. For iCloud, Fastmail, Yahoo, Zoho and Proton Mail Bridge, Slipstream already knows the server names. For a custom domain it reads the domain's MX and server records to find the host (Zoho's regional servers in the EU, India and Australia included); if it can't, it asks you to type your IMAP and SMTP hosts. Most providers want an app-specific password rather than your main one.

## Send from an alias or your own domain

An account can send as more than one address, such as `help@fernpoint.co` or an old address you still use. In a draft, pick the address in the From field. When you reply to a message that was sent to one of your aliases, Slipstream replies from that same alias.

- **Gmail (signed in with Google):** aliases show up on their own once you've added and verified them in Gmail under Settings → See all settings → Accounts and Import → Send mail as. Slipstream checks again every few hours. Change or remove an alias in Gmail, not in Slipstream.
- **Outlook and other mail servers (IMAP):** add the address yourself in Settings → Accounts, under the account. You can give it a name, a reply-to address and a signature. Your mail provider has to allow sending from that address, or it may refuse the message or rewrite the From. For a custom domain, that usually means adding the address as an alias in your provider's settings first.
- **Gmail with an app password:** add aliases by hand, the same as for any other mail server.

If you remove an address that a queued message was going to use, that message fails with a plain note instead of going out from a different address.

## Importing an export

Choose **Import a mail file** on the first screen or under Settings → Accounts, then drop one or more files:

- **Google Takeout** (`.mbox`): labels, stars, read state and conversations come across.
- **Thunderbird / Apple Mail / mutt** (`.mbox`, `mboxrd`): messages land in Done and are fully searchable.
- **Single messages** (`.eml`).

Imports stream from disk, so multi-gigabyte archives are fine. Imported mail lives only in Slipstream; it can't send, so pick another account in the From field when replying.

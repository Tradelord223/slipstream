import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../../api.ts";
import { useSession } from "../../store/session.ts";
import type { Discovery } from "../../types.ts";
import { Icon, Logo, type IconName } from "../Icon.tsx";
import { EMAIL_RE, GUIDE_URL, KIND_NAME, kindFromDiscovery, kindFromDomain, nameFromEmail, type Kind } from "./hosts.ts";
import { ImportMail } from "./ImportMail.tsx";

export interface Connected {
  accountId: string;
  email: string;
  /** The account is an imported archive rather than a live mailbox. */
  archive?: boolean;
}

type Step = "email" | "signin" | "import";
type Preset = { id: string; label: string; help: string };

const TILES: { kind: Kind; label: string; icon: IconName }[] = [
  { kind: "gmail", label: "Gmail", icon: "mail" },
  { kind: "outlook", label: "Outlook", icon: "inbox" },
  { kind: "icloud", label: "iCloud", icon: "folder" },
  { kind: "yahoo", label: "Yahoo", icon: "send" },
  { kind: "fastmail", label: "Fastmail", icon: "zap" },
  { kind: "other", label: "Other", icon: "plus" },
];

interface GuideStep {
  title: string;
  detail?: string;
  link?: { href: string; label: string };
}

/** Where each provider hides its app passwords. Two steps to do, then the password goes in the field. */
const GUIDES: Partial<Record<Kind, [GuideStep, GuideStep]>> = {
  gmail: [
    { title: "Turn on 2-Step Verification", link: { href: "https://myaccount.google.com/signinoptions/twosv", label: "Open 2-Step Verification" } },
    { title: "Create an app password named Slipstream", link: { href: "https://myaccount.google.com/apppasswords", label: "Open app passwords" } },
  ],
  icloud: [
    { title: "Sign in to your Apple Account", link: { href: "https://account.apple.com", label: "Open Apple Account" } },
    { title: "Create a password named Slipstream" },
  ],
  yahoo: [
    { title: "Open your Yahoo account security page", link: { href: "https://login.yahoo.com/account/security", label: "Open account security" } },
    { title: "Generate an app password named Slipstream" },
  ],
  fastmail: [
    { title: "Open Fastmail's app password settings", link: { href: "https://app.fastmail.com/settings/security/apps", label: "Open app passwords" } },
    { title: "Create one named Slipstream with mail access" },
  ],
  zoho: [
    { title: "Turn on IMAP in Zoho Mail settings" },
    { title: "If you use two-factor sign-in, create an app password named Slipstream" },
  ],
  proton: [
    { title: "Install Proton Mail Bridge", detail: "Proton Mail only works through the Bridge app, which keeps a connection open on the computer that runs Slipstream.", link: { href: "https://proton.me/mail/bridge", label: "Get Proton Mail Bridge" } },
    { title: "Sign in to the Bridge and leave it running" },
  ],
};

const PORT_SECURE = { imap: { 993: true, 143: false }, smtp: { 465: true, 587: false, 25: false } } as const;

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });

/**
 * The steps that take an email address to a connected account: type it (or pick a provider), then sign in the way
 * that provider wants. First-run setup and Settings both use it; the caller decides what happens once it connects.
 */
export function ConnectFlow({
  variant,
  title,
  lead,
  brand = false,
  allowImport = false,
  initial,
  onConnected,
  onBeforeOAuth,
  onClose,
}: {
  variant: "page" | "dialog";
  title: string;
  lead?: ReactNode;
  brand?: boolean;
  allowImport?: boolean;
  /** Start on a provider's sign-in with a problem to show (Google or Microsoft sent the person back with an error). */
  initial?: { kind: Kind; error: string };
  onConnected: (c: Connected) => void | Promise<void>;
  /** Called just before the browser leaves for Google or Microsoft. */
  onBeforeOAuth?: () => void;
  onClose?: () => void;
}) {
  const features = useSession((s) => s.features);
  const mode = useSession((s) => s.mode);
  const root = useRef<HTMLDivElement>(null);

  const [step, setStep] = useState<Step>(initial ? "signin" : "email");
  const [kind, setKind] = useState<Kind>(initial?.kind ?? "gmail");
  const [email, setEmail] = useState("");
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [looking, setLooking] = useState(false);
  const [notice, setNotice] = useState("");
  const [presets, setPresets] = useState<Preset[]>([]);

  const [name, setName] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [serversOpen, setServersOpen] = useState(false);
  const [server, setServer] = useState({ imapHost: "", imapPort: "993", imapSecure: true, smtpHost: "", smtpPort: "465", smtpSecure: true });
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState<"google" | "microsoft" | null>(null);
  const [errors, setErrors] = useState<{ email?: string; password?: string; username?: string; servers?: string; general?: string }>(initial ? { general: initial.error } : {});

  useEffect(() => {
    api
      .presets()
      .then((r) => setPresets(r.presets))
      .catch(() => undefined);
  }, []);

  // Each step starts with the right thing focused: the first field that needs the person, or the heading.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const node = root.current?.querySelector<HTMLElement>(`[data-step="${step}"] [data-autofocus]`) ?? root.current?.querySelector<HTMLElement>("[data-heading]");
      node?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [step, kind]);

  const preset = presets.find((p) => p.id === kind);
  const serversFor = useCallback(
    (address: string, d: Discovery | null) => (d?.servers && address.trim().toLowerCase().split("@")[1] === d.domain ? d.servers : null),
    [],
  );

  const enter = (next: Kind, d: Discovery | null, address = email) => {
    setKind(next);
    setDiscovery(d);
    setErrors({});
    setPassword("");
    setReveal(false);
    setUsePassword(false);
    if (next === "other") {
      const found = serversFor(address, d);
      setServer(
        found
          ? { imapHost: found.imapHost, imapPort: String(found.imapPort), imapSecure: found.imapSecure, smtpHost: found.smtpHost, smtpPort: String(found.smtpPort), smtpSecure: found.smtpSecure }
          : { imapHost: "", imapPort: "993", imapSecure: true, smtpHost: "", smtpPort: "465", smtpSecure: true },
      );
      setServersOpen(!found);
    }
    setStep("signin");
  };

  const lookUp = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!EMAIL_RE.test(value)) {
      setErrors({ email: "Enter your full email address, like you@example.com" });
      document.getElementById("ob-email")?.focus();
      return;
    }
    setErrors({});
    setNotice("");
    setLooking(true);
    let found: Discovery | null = null;
    try {
      found = await withTimeout(api.discover(value), 8000);
    } catch {
      found = null; // the lookup is a convenience; the provider tiles always work
    }
    setLooking(false);
    if (found) return enter(kindFromDiscovery(found), found, value);
    const known = kindFromDomain(value);
    if (known) return enter(known, null, value);
    setNotice("We couldn't tell where this address's mail is kept. Choose your provider below.");
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".ob-tile")?.focus());
  };

  const back = () => {
    setStep("email");
    setErrors({});
    setNotice("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && step !== "email" && !busy) {
      e.preventDefault();
      e.stopPropagation(); // inside a dialog, Escape goes back a step first and only closes at the first one
      back();
    }
  };

  // The page has no dialog around it, so catch Escape when focus has drifted to the page itself.
  useEffect(() => {
    if (variant !== "page" || step === "email") return;
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !busy) back();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [variant, step, busy]);

  const googleReady = discovery?.oauth === "google" || features.google;
  const microsoftReady = discovery?.oauth === "microsoft" || features.microsoft;

  const leave = (provider: "google" | "microsoft") => {
    setLeaving(provider);
    onBeforeOAuth?.();
    window.location.href = `/api/oauth/${provider}/start`;
  };

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    const next: typeof errors = {};
    const secret = kind === "gmail" ? password.replace(/\s+/g, "") : password;
    if (!EMAIL_RE.test(address)) next.email = "Enter your full email address, like you@example.com";
    if (!secret) next.password = kind === "gmail" ? "Paste the app password from Google." : kind === "proton" ? "Enter the password the Bridge shows." : "Enter your password.";
    else if (kind === "gmail" && !/^[a-z]{16}$/i.test(secret)) next.password = "An app password is 16 letters. Copy it again from Google, spaces and all.";
    if (kind === "other" && (!server.imapHost.trim() || !server.smtpHost.trim())) {
      next.servers = "Add the incoming and outgoing server names your provider lists.";
      setServersOpen(true);
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      const target = next.email ? "ob-email" : next.password ? "ob-secret" : "ob-imap-host";
      requestAnimationFrame(() => document.getElementById(target)?.focus());
      return;
    }
    setBusy(true);
    setErrors({});
    const body: Record<string, unknown> = { email: address, name: (name ?? nameFromEmail(address)).trim(), password: secret };
    if (kind !== "other") body.preset = kind;
    if (kind === "proton" && (username ?? address).trim() !== address) body.username = (username ?? address).trim();
    if (kind === "other") {
      body.imapHost = server.imapHost.trim();
      body.imapPort = Number(server.imapPort) || 993;
      body.imapSecure = server.imapSecure;
      body.smtpHost = server.smtpHost.trim();
      body.smtpPort = Number(server.smtpPort) || 465;
      body.smtpSecure = server.smtpSecure;
    }
    let id: string;
    try {
      id = (await api.connectImap(body)).id;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't connect that account";
      // Say it next to the field it concerns: the address, the server names, or (usually) the password.
      let target = "ob-secret";
      if (err instanceof ApiError && err.status === 0) {
        setErrors({ general: message });
        target = "";
      } else if (/e-?mail|address/i.test(message) && !/sign in/i.test(message)) {
        setErrors({ email: message });
        target = "ob-email";
      } else if (kind === "other" && /host|server name|ENOTFOUND|getaddrinfo|ECONNREFUSED|timed out|timeout|port|certificate|TLS|SSL|reach/i.test(message)) {
        setErrors({ servers: message });
        setServersOpen(true);
        target = "ob-imap-host";
      } else setErrors({ password: message });
      setBusy(false);
      if (target) requestAnimationFrame(() => document.getElementById(target)?.focus());
      return;
    }
    await onConnected({ accountId: id, email: address });
    setBusy(false);
  };

  const heading = (text: string) => {
    const Tag = variant === "page" ? "h1" : "h3";
    return (
      <Tag className="ob-title" tabIndex={-1} data-heading>
        {text}
      </Tag>
    );
  };

  // ---- Step: email ------------------------------------------------------------------------

  const emailStep = (
    <div data-step="email" className="ob-step-pane">
      <header className="ob-head">
        {brand && (
          <div className="ob-brand">
            <Logo size={28} />
            <span>Slipstream</span>
          </div>
        )}
        <div className="ob-head-row">
          {heading(title)}
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          )}
        </div>
        {lead && <p className="ob-lead">{lead}</p>}
      </header>

      <form className="ob-form" onSubmit={lookUp} noValidate>
        <div className="ob-field">
          <label htmlFor="ob-email">Email address</label>
          <input
            id="ob-email"
            className="field ob-input"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => (setEmail(e.target.value), setErrors({}), setNotice(""))}
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? "ob-email-error" : undefined}
            data-autofocus
            spellCheck={false}
            autoCapitalize="none"
          />
          {errors.email && (
            <p id="ob-email-error" className="ob-error" role="alert">
              {errors.email}
            </p>
          )}
        </div>
        <button className="btn btn-primary btn-lg ob-wide" disabled={looking || !email.trim()}>
          {looking ? "Checking…" : "Continue"}
        </button>
        <p className="ob-status" role="status" aria-live="polite">
          {looking ? "Looking up your email…" : notice}
        </p>
      </form>

      <div className="ob-or">
        <span id="ob-providers">Or choose your provider</span>
      </div>
      <div className="ob-tiles" role="group" aria-labelledby="ob-providers">
        {TILES.map((t) => (
          <button key={t.kind} type="button" className="ob-tile" onClick={() => enter(t.kind, kindFromDomain(email) === t.kind ? discovery : null)}>
            <Icon name={t.icon} size={20} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {allowImport && (
        <div className="ob-aside">
          <button type="button" className="link-btn" onClick={() => setStep("import")}>
            Import a mail file instead
          </button>
          <p className="form-hint">An .mbox or .eml file from Thunderbird or Google Takeout.</p>
        </div>
      )}
    </div>
  );

  // ---- Step: import -----------------------------------------------------------------------

  const importStep = (
    <div data-step="import" className="ob-step-pane">
      <button type="button" className="btn btn-quiet btn-sm ob-back" onClick={back}>
        <Icon name="chevron-left" /> Back
      </button>
      <header className="ob-head">
        {heading("Import a mail file")}
        <p className="ob-lead">Bring in an archive from Thunderbird or Google Takeout. It stays {mode === "team" ? "on your team's server" : "on this computer"}.</p>
      </header>
      <ImportMail
        defaultOwner={EMAIL_RE.test(email.trim()) ? email.trim() : ""}
        autoFocus
        onStarted={async (accountId) => {
          await onConnected({ accountId, email: email.trim(), archive: true });
        }}
      />
    </div>
  );

  // ---- Step: sign in ----------------------------------------------------------------------

  const oauthKind = kind === "gmail" ? "google" : kind === "outlook" ? "microsoft" : null;
  const oauthReady = kind === "gmail" ? googleReady : kind === "outlook" ? microsoftReady : false;
  const showOAuth = oauthKind !== null && oauthReady && !usePassword;
  const passwordForm = kind !== "outlook" && !showOAuth;
  const guide = GUIDES[kind];
  const label = kind === "other" ? "Your email account" : KIND_NAME[kind];
  const effectiveName = name ?? nameFromEmail(email);
  const secretLabel = kind === "gmail" || kind === "icloud" || kind === "yahoo" || kind === "fastmail" || kind === "zoho" ? "App password" : kind === "proton" ? "Bridge password" : "Password";

  const generalError = errors.general && (
    <p className="form-error" role="alert">
      {errors.general}
    </p>
  );

  const signinStep = (
    <div data-step="signin" className="ob-step-pane">
      <button type="button" className="btn btn-quiet btn-sm ob-back" onClick={back} disabled={busy}>
        <Icon name="chevron-left" /> Back
      </button>
      <header className="ob-head">
        {heading(kind === "other" ? "Connect your email" : kind === "outlook" ? "Connect Outlook" : `Connect ${KIND_NAME[kind]}`)}
        {kind === "gmail" && showOAuth && <p className="ob-lead">Sign in with Google and Slipstream takes it from there. A Google Workspace address works too.</p>}
        {kind === "gmail" && !showOAuth && <p className="ob-lead">An app password lets Slipstream read and send your mail without your Google password. A Google Workspace address works the same.</p>}
        {kind === "outlook" && <p className="ob-lead">For Outlook.com, Hotmail and Microsoft 365 addresses.</p>}
        {kind === "other" && <p className="ob-lead">Enter your address and password. Most providers need nothing else.</p>}
        {(kind === "icloud" || kind === "yahoo" || kind === "fastmail" || kind === "zoho") && <p className="ob-lead">{label} asks for an app password: a separate password just for Slipstream.</p>}
        {kind === "proton" && <p className="ob-lead">Proton Mail encrypts everything, so it connects through its Bridge app rather than a password.</p>}
      </header>

      {generalError}

      {showOAuth && oauthKind && (
        <div className="ob-oauth">
          <button type="button" className="btn btn-primary btn-lg ob-wide" onClick={() => leave(oauthKind)} disabled={leaving !== null} data-autofocus>
            {leaving ? `Opening ${oauthKind === "google" ? "Google" : "Microsoft"}…` : oauthKind === "google" ? "Continue with Google" : "Continue with Microsoft"}
          </button>
          {kind === "gmail" && (
            <button type="button" className="link-btn" onClick={() => setUsePassword(true)}>
              Use an app password instead
            </button>
          )}
        </div>
      )}

      {kind === "outlook" && !showOAuth && (
        <div className="ob-note" role="note">
          <Icon name="alert" size={18} />
          <div>
            <p className="ob-note-title" tabIndex={-1} data-autofocus>
              Outlook sign-in isn't set up on this install yet.
            </p>
            <p>Microsoft no longer accepts app passwords, so Outlook needs a one-time setup by whoever runs Slipstream.</p>
            <a href={GUIDE_URL} target="_blank" rel="noopener noreferrer">
              Read the setup guide <Icon name="external" size={13} />
            </a>
          </div>
        </div>
      )}

      {passwordForm && (
        <form className="ob-form" onSubmit={connect} noValidate>
          <div className="ob-field">
            <label htmlFor="ob-email">Email address</label>
            <input
              id="ob-email"
              className="field ob-input"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => (setEmail(e.target.value), setErrors((x) => ({ ...x, email: undefined })))}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? "ob-email-error" : undefined}
              data-autofocus={email.trim() ? undefined : ""}
              spellCheck={false}
              autoCapitalize="none"
            />
            {errors.email && (
              <p id="ob-email-error" className="ob-error" role="alert">
                {errors.email}
              </p>
            )}
          </div>

          {guide ? (
            <ol className="ob-steps">
              {guide.map((s, i) => (
                <li className="ob-guide" key={s.title}>
                  <span className="ob-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div className="ob-guide-body">
                    <p className="ob-guide-title">{s.title}</p>
                    {s.detail && <p className="ob-guide-detail">{s.detail}</p>}
                    {s.link && (
                      <a className="ob-guide-link" href={s.link.href} target="_blank" rel="noopener noreferrer">
                        {s.link.label} <Icon name="external" size={13} />
                      </a>
                    )}
                  </div>
                </li>
              ))}
              <li className="ob-guide">
                <span className="ob-num" aria-hidden="true">
                  3
                </span>
                <div className="ob-guide-body">
                  <label className="ob-guide-title" htmlFor={kind === "proton" ? "ob-username" : "ob-secret"}>
                    {kind === "proton" ? "Enter the Bridge's username and password" : "Paste it here"}
                  </label>
                  {kind === "proton" && (
                    <input
                      id="ob-username"
                      className="field ob-input"
                      aria-label="Bridge username"
                      placeholder="Bridge username"
                      value={username ?? email}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      autoCapitalize="none"
                    />
                  )}
                  <Secret
                    label={kind === "proton" ? "Bridge password" : secretLabel}
                    value={password}
                    onChange={(v) => (setPassword(v), setErrors((x) => ({ ...x, password: undefined })))}
                    reveal={reveal}
                    onReveal={() => setReveal((r) => !r)}
                    error={errors.password}
                    placeholder={kind === "gmail" ? "abcd efgh ijkl mnop" : undefined}
                    autoFocus={Boolean(email.trim())}
                    hideLabel
                  />
                </div>
              </li>
            </ol>
          ) : (
            <Secret label="Password" value={password} onChange={(v) => (setPassword(v), setErrors((x) => ({ ...x, password: undefined })))} reveal={reveal} onReveal={() => setReveal((r) => !r)} error={errors.password} autoFocus={Boolean(email.trim())} />
          )}

          {kind !== "gmail" && preset?.help && guide && <p className="form-hint ob-help">{preset.help}</p>}

          <div className="ob-field">
            <label htmlFor="ob-name">Your name (optional)</label>
            <input id="ob-name" className="field ob-input" value={effectiveName} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            <small className="form-hint">Shown on the mail you send.</small>
          </div>

          {kind === "other" && (
            <div className="ob-disclosure">
              <button type="button" className="ob-disclose" aria-expanded={serversOpen} aria-controls="ob-servers" onClick={() => setServersOpen((o) => !o)}>
                <Icon name={serversOpen ? "chevron-down" : "chevron-right"} size={14} /> Server settings
              </button>
              {serversOpen && (
                <div id="ob-servers" className="ob-servers">
                  {!discovery?.servers && <p className="form-hint">We couldn't find these automatically. Your provider lists them in its help pages.</p>}
                  <div className="ob-server-row">
                    <div className="ob-field">
                      <label htmlFor="ob-imap-host">IMAP server</label>
                      <input id="ob-imap-host" className="field" value={server.imapHost} onChange={(e) => setServer({ ...server, imapHost: e.target.value })} placeholder="imap.example.com" autoComplete="off" spellCheck={false} autoCapitalize="none" />
                    </div>
                    <div className="ob-field">
                      <label htmlFor="ob-imap-port">Port</label>
                      <input
                        id="ob-imap-port"
                        className="field num"
                        value={server.imapPort}
                        inputMode="numeric"
                        onChange={(e) => {
                          const port = e.target.value.replace(/\D/g, "");
                          const known = PORT_SECURE.imap[Number(port) as keyof typeof PORT_SECURE.imap];
                          setServer({ ...server, imapPort: port, imapSecure: known ?? server.imapSecure });
                        }}
                      />
                    </div>
                  </div>
                  <div className="ob-server-row">
                    <div className="ob-field">
                      <label htmlFor="ob-smtp-host">SMTP server</label>
                      <input id="ob-smtp-host" className="field" value={server.smtpHost} onChange={(e) => setServer({ ...server, smtpHost: e.target.value })} placeholder="smtp.example.com" autoComplete="off" spellCheck={false} autoCapitalize="none" />
                    </div>
                    <div className="ob-field">
                      <label htmlFor="ob-smtp-port">Port</label>
                      <input
                        id="ob-smtp-port"
                        className="field num"
                        value={server.smtpPort}
                        inputMode="numeric"
                        onChange={(e) => {
                          const port = e.target.value.replace(/\D/g, "");
                          const known = PORT_SECURE.smtp[Number(port) as keyof typeof PORT_SECURE.smtp];
                          setServer({ ...server, smtpPort: port, smtpSecure: known ?? server.smtpSecure });
                        }}
                      />
                    </div>
                  </div>
                  {errors.servers && (
                    <p className="ob-error" role="alert">
                      {errors.servers}
                    </p>
                  )}
                </div>
              )}
              {!serversOpen && errors.servers && (
                <p className="ob-error" role="alert">
                  {errors.servers}
                </p>
              )}
            </div>
          )}

          <button className="btn btn-primary btn-lg ob-wide" disabled={busy}>
            {busy ? "Checking…" : "Connect"}
          </button>
          <p className="ob-status" role="status" aria-live="polite">
            {busy ? "Checking that it works…" : ""}
          </p>
        </form>
      )}
    </div>
  );

  return (
    <div className={`ob-flow ob-${variant}`} ref={root} onKeyDown={onKeyDown}>
      {step === "email" && emailStep}
      {step === "signin" && signinStep}
      {step === "import" && importStep}
    </div>
  );
}

function Secret({
  label,
  value,
  onChange,
  reveal,
  onReveal,
  error,
  placeholder,
  autoFocus,
  hideLabel = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  reveal: boolean;
  onReveal: () => void;
  error?: string;
  placeholder?: string;
  autoFocus?: boolean;
  hideLabel?: boolean;
}) {
  return (
    <div className="ob-field">
      {hideLabel ? <span className="sr-only" id="ob-secret-label">{label}</span> : <label htmlFor="ob-secret">{label}</label>}
      <div className="ob-secret">
        <input
          id="ob-secret"
          className="field ob-input"
          type={reveal ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          aria-labelledby={hideLabel ? "ob-secret-label" : undefined}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "ob-secret-error" : undefined}
          data-autofocus={autoFocus ? "" : undefined}
        />
        <button type="button" className="icon-btn ob-reveal" onClick={onReveal} aria-pressed={reveal} aria-label={reveal ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}>
          <Icon name="eye" />
        </button>
      </div>
      {error && (
        <p id="ob-secret-error" className="ob-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

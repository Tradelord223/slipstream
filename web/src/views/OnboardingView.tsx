import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { Snippet } from "../components/CopyBlock.tsx";
import { ConnectFlow, type Connected } from "../components/connect/ConnectFlow.tsx";
import { oauthErrorText, providerLabel, type Kind } from "../components/connect/hosts.ts";
import { Dialog } from "../components/Dialog.tsx";
import { Icon, Logo } from "../components/Icon.tsx";
import { claudeCodeCommand, cliCommand, stdioConfig } from "../lib/connect.ts";
import { connectEvents, disconnectEvents, useImportJob, useSyncFetched } from "../store/events.ts";
import { getRoute, navigate, useRoute } from "../store/route.ts";
import { finishOnboarding, markOnboarding, realAccounts, refreshSession, signOut, useSession } from "../store/session.ts";
import { toast } from "../store/toasts.ts";
import type { Account } from "../types.ts";

type Phase = "connect" | "progress" | "personalize";

/** What the address bar says when Google or Microsoft sends the person back. */
function returnTrip(): { connected: boolean; error: string | null; kind: Kind | null } {
  const q = new URLSearchParams(location.search);
  const error = q.get("error");
  // The server names the provider on every return; the guesses are for a server that doesn't.
  const provider = q.get("provider");
  const where = provider === "microsoft" ? "outlook" : provider === "google" ? "gmail" : error?.startsWith("microsoft") || q.get("connected") === "microsoft" ? "outlook" : "gmail";
  return { connected: Boolean(q.get("connected")), error, kind: error ? where : null };
}

/**
 * First run: nothing else in the app is reachable until a real mailbox is connected. Steps are connect, bring the
 * mail in, then an optional "make it yours". The app opens only when the person leaves from the last of them.
 */
export function OnboardingView() {
  const accounts = useSession((s) => s.accounts);
  const settings = useSession((s) => s.settings);
  const mode = useSession((s) => s.mode);
  const route = useRoute();
  const real = realAccounts(accounts);
  const [trip] = useState(returnTrip);
  // Back from Google with an account, or a reload partway through: pick up at the mailbox that is still arriving.
  const resume = real.find((a) => !a.firstSyncedAt) ?? real[real.length - 1] ?? null;
  const [phase, setPhase] = useState<Phase>(resume ? "progress" : "connect");
  const [accountId, setAccountId] = useState<string | null>(resume?.id ?? null);
  const heading = useRef<HTMLDivElement>(null);

  useEffect(() => {
    markOnboarding(true);
    connectEvents();
    if (route.name !== "join") navigate("/", { replace: true });
    // The app opens its own stream; one left over would stay bound to whoever signs out from here.
    return disconnectEvents;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.title = "Welcome · Slipstream";
    return () => {
      document.title = "Slipstream";
    };
  }, []);

  const connected = async (c: Connected) => {
    await refreshSession();
    setAccountId(c.accountId);
    setPhase("progress");
  };

  const leave = async (afterwards?: string): Promise<boolean> => {
    const saved = await finishOnboarding(afterwards === "assistant" ? { assistant: "on" } : {});
    if (saved && afterwards === "assistant" && getRoute().name !== "join") navigate("/settings/models");
    return saved;
  };

  const openInbox = () => {
    if (settings.onboarded) void leave();
    else setPhase("personalize");
  };

  // Team only: a person can look around before connecting a mailbox. On this computer there's nothing to look at without one.
  const [skipping, setSkipping] = useState(false);
  const skip = async () => {
    setSkipping(true);
    if (!(await leave())) setSkipping(false);
  };

  // Every step opens on its heading so a screen reader starts at the top.
  useEffect(() => {
    if (phase !== "connect") heading.current?.querySelector<HTMLElement>("[data-heading]")?.focus();
  }, [phase]);

  return (
    <main className="ob">
      <div className="ob-col" ref={heading}>
        {phase === "connect" && (
          <ConnectFlow
            variant="page"
            brand
            allowImport
            title="Connect your email to get started"
            lead={mode === "team" ? "Your mail stays on your team's server." : "Your mail stays on this computer."}
            initial={trip.error && trip.kind ? { kind: trip.kind, error: oauthErrorText(trip.error) } : undefined}
            onConnected={connected}
            onBeforeOAuth={() => markOnboarding(true)}
            footer={
              mode === "team" && (
                <div className="ob-aside">
                  <button type="button" className="btn btn-quiet" onClick={() => void skip()} disabled={skipping}>
                    {skipping ? "Opening…" : "Skip for now"}
                  </button>
                </div>
              )
            }
          />
        )}
        {phase === "progress" && accountId && <Arriving accountId={accountId} onOpen={openInbox} onStartOver={() => setPhase("connect")} />}
        {phase === "personalize" && <MakeItYours onFinish={leave} />}
        {mode === "team" && (
          <div className="ob-foot">
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                markOnboarding(false);
                void signOut();
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

// ---- Bringing in your mail ----------------------------------------------------------------------

/** The sr-only line changes only at milestones, so a screen reader isn't read every new message. */
function milestone(count: number, archive: boolean): string {
  if (count <= 0) return archive ? "Reading your archive." : "Connecting to your mailbox.";
  if (count < 100) return archive ? "Your first messages are in." : "Your first messages are arriving.";
  return `More than ${(Math.floor(count / 500) * 500 || 100).toLocaleString("en-US")} messages so far.`;
}

function Arriving({ accountId, onOpen, onStartOver }: { accountId: string; onOpen: () => void; onStartOver: () => void }) {
  const account = useSession((s) => s.accounts.find((a) => a.id === accountId));
  const fetched = useSyncFetched(accountId);
  const job = useImportJob();
  const [retrying, setRetrying] = useState(false);
  const [removing, setRemoving] = useState(false);

  const archive = account?.provider === "archive";
  const mine = job && job.accountId === accountId ? job : null;
  const problem = archive
    ? mine?.status === "failed"
      ? (mine.error ?? "The file couldn't be read.")
      : null
    : account?.syncStatus === "error"
      ? (account.syncError ?? "Slipstream couldn't read this mailbox.")
      : account?.syncStatus === "reauth"
        ? "Slipstream can't sign in to this account anymore."
        : null;
  // Done is the server's word that the whole first sync or import finished. A sync that merely went idle doesn't count:
  // a run can stop early (the page cap) with more mail still to come.
  const done = Boolean(account && (archive ? mine?.status === "done" || (account.firstSyncedAt && account.importing !== true) : account.firstSyncedAt));
  // The count is for this view's own run. After a reload there is no run to count, only an import's stored total.
  const running = !done && !problem && (archive ? mine?.status === "running" || account?.importing === true : account?.syncStatus === "syncing");
  const count = archive ? (mine?.imported ?? account?.imported ?? 0) : fetched;
  const shown = running ? count : 0;
  const ready = !problem && (done || count > 0);

  // The event stream is the fast path; asking now and then covers a stream that dropped.
  useEffect(() => {
    if (done || problem) return;
    const t = setInterval(() => void refreshSession(), 4000);
    return () => clearInterval(t);
  }, [done, problem]);

  const retry = async () => {
    setRetrying(true);
    try {
      if (!archive) await api.syncAccount(accountId);
      await refreshSession();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start a sync");
    } finally {
      setRetrying(false);
    }
  };
  // A mailbox that is stuck or failed is removed so the next try starts clean. One that finished stays; it's a
  // working account, and the person is only here to add another.
  const startOver = async () => {
    if (done) return onStartOver();
    setRemoving(true);
    try {
      await api.removeAccount(accountId);
      await refreshSession();
      onStartOver();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove that account");
      setRemoving(false);
    }
  };

  const differentAccount = (
    <button className="btn btn-quiet btn-lg" onClick={() => void startOver()} disabled={retrying || removing}>
      Use a different account
    </button>
  );

  return (
    <div className="ob-step-pane">
      <header className="ob-head">
        <div className="ob-brand">
          <Logo size={28} />
          <span>Slipstream</span>
        </div>
        <h1 className="ob-title" tabIndex={-1} data-heading>
          {problem ? "That didn't work" : done ? "Your mail is here" : archive ? "Importing your mail" : "Bringing in your mail"}
        </h1>
      </header>

      {account && (
        <div className="ob-account">
          <span className="dot dot-lg" style={{ background: account.color }} />
          <span className="ob-account-main">
            <span className="ob-account-email">{account.email}</span>
            <span className="ob-account-meta">{providerLabel(account)}</span>
          </span>
        </div>
      )}

      {problem ? (
        <>
          <p className="form-error" role="alert">
            {problem}
          </p>
          <div className="ob-actions">
            <button className="btn btn-primary btn-lg" onClick={() => void retry()} disabled={retrying || removing}>
              {retrying ? "Trying…" : "Try again"}
            </button>
            {differentAccount}
          </div>
        </>
      ) : (
        <>
          {!done && (
            <div className="ob-count" aria-hidden="true">
              {shown > 0 ? (
                <>
                  {archive && <span className="ob-count-label">Importing…</span>}
                  <span className="ob-count-num num">{shown.toLocaleString("en-US")}</span>
                  <span className="ob-count-label">{archive ? "messages" : "messages so far"}</span>
                </>
              ) : (
                <span className="ob-count-label">{archive ? "Importing…" : "Connecting to your mailbox…"}</span>
              )}
            </div>
          )}
          <p className="sr-only" role="status" aria-live="polite">
            {done ? "Your mail is here." : milestone(shown, archive)}
          </p>
          <p className="ob-lead">
            {done
              ? archive
                ? "Everything in the file is in."
                : "Everything is in. New mail will keep arriving on its own."
              : archive
                ? "You can start now; the rest keeps coming in as the file is read."
                : "Your newest mail comes first. You can start now; the rest keeps arriving in the background."}
          </p>
          <div className="ob-actions">
            <button className="btn btn-primary btn-lg" onClick={onOpen} disabled={!ready} data-autofocus>
              Open my inbox
            </button>
            {differentAccount}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Make it yours -------------------------------------------------------------------------------

type Ai = "none" | "agent" | "builtin";

function MakeItYours({ onFinish }: { onFinish: (afterwards?: string) => Promise<boolean> }) {
  const accounts = useSession((s) => s.accounts);
  const cli = useSession((s) => s.features.cli);
  const [choice, setChoice] = useState<Ai>("none");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const origin = location.origin;
  const real = realAccounts(accounts);

  const finish = async (skip: boolean) => {
    setBusy(true);
    if (!(await onFinish(!skip && choice === "builtin" ? "assistant" : undefined))) setBusy(false);
  };

  const options: { id: Ai; title: string; text: string; body?: React.ReactNode }[] = [
    { id: "none", title: "No AI", text: "Slipstream works fully on its own. Nothing reads your mail but you." },
    {
      id: "agent",
      title: "Use my own agent",
      text: "Let Claude, Cursor or another agent you already use work in your mailbox.",
      body: (
        <div className="ob-snips">
          <Snippet title="Claude Code" hint="Adds Slipstream as an MCP server." text={claudeCodeCommand(origin)} />
          <Snippet title="Claude Desktop, Cursor and other apps" text={stdioConfig(cli)} />
          <Snippet title="Command line" text={cliCommand(cli)} />
          <p className="form-hint">Create a token under Settings, Agents once you're in, then paste it where you see {"<token>"}.</p>
        </div>
      ),
    },
    {
      id: "builtin",
      title: "Built-in assistant",
      text: "Ask questions about your mail and let Autopilot sort what arrives.",
      body: <p className="form-hint">We'll turn it on and take you to Models &amp; accounts, where you choose what it thinks with.</p>,
    },
  ];

  return (
    <div className="ob-step-pane">
      <header className="ob-head">
        <div className="ob-brand">
          <Logo size={28} />
          <span>Slipstream</span>
        </div>
        <h1 className="ob-title" tabIndex={-1} data-heading>
          Make it yours
        </h1>
        <p className="ob-lead">Both are optional, and you can change them any time in Settings.</p>
      </header>

      <section className="ob-section" aria-labelledby="ob-accounts">
        <h2 id="ob-accounts" className="ob-subtitle">
          Your accounts
        </h2>
        <ul className="ob-accounts" role="list">
          {real.map((a: Account) => (
            <li key={a.id} className="ob-account">
              <span className="dot dot-lg" style={{ background: a.color }} />
              <span className="ob-account-main">
                <span className="ob-account-email">{a.email}</span>
                <span className="ob-account-meta">{providerLabel(a)}</span>
              </span>
            </li>
          ))}
        </ul>
        <button ref={addButton} type="button" className="btn ob-add" onClick={() => setAdding(true)}>
          <Icon name="plus" /> Add another account
        </button>
      </section>

      <fieldset className="ob-section ob-choices">
        <legend className="ob-subtitle">AI</legend>
        {options.map((o) => (
          <div key={o.id} className={`ob-opt ${choice === o.id ? "selected" : ""}`}>
            <label className="ob-opt-head">
              <input type="radio" name="ai" className="sr-only" checked={choice === o.id} onChange={() => setChoice(o.id)} />
              <span className="ob-radio" aria-hidden="true" />
              <span className="ob-opt-text">
                <span className="ob-opt-title">{o.title}</span>
                <span className="ob-opt-sub">{o.text}</span>
              </span>
            </label>
            {choice === o.id && o.body && <div className="ob-opt-body">{o.body}</div>}
          </div>
        ))}
      </fieldset>

      <div className="ob-actions ob-split">
        <button className="btn btn-primary btn-lg" onClick={() => void finish(false)} disabled={busy}>
          {busy ? "Opening…" : "Finish"}
        </button>
        <button className="btn btn-quiet btn-lg" onClick={() => void finish(true)} disabled={busy}>
          Skip
        </button>
      </div>

      {adding && (
        <Dialog label="Add another account" onClose={() => setAdding(false)} className="dialog-connect" lockScrim>
          <ConnectFlow
            variant="dialog"
            title="Add another account"
            onClose={() => setAdding(false)}
            onBeforeOAuth={() => markOnboarding(true)}
            onConnected={async (c) => {
              await refreshSession();
              setAdding(false);
              toast.info(`Connected ${c.email}`);
            }}
          />
        </Dialog>
      )}
    </div>
  );
}

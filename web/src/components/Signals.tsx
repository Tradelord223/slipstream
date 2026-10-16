import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { api } from "../api.ts";
import { copyCode } from "../lib/code.ts";
import { copyText } from "../lib/clipboard.ts";
import { ago } from "../lib/format.ts";
import { useNow } from "../lib/hooks.ts";
import { codeFreshFor, deliveryLabel, pickSignal, threadSignals } from "../lib/signals.ts";
import { useSession } from "../store/session.ts";
import { toast } from "../store/toasts.ts";
import type { Message, Signal, Thread } from "../types.ts";
import { Icon } from "./Icon.tsx";
import { Keys } from "./Keycap.tsx";

/** True while a code is still worth offering; flips on its own when the 15 minutes run out. */
export function useCodeFresh(at: number | null | undefined): boolean {
  const [, tick] = useState(0);
  const left = codeFreshFor(at);
  const fresh = left > 0;
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.min(left + 50, 2 ** 31 - 1));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, fresh]);
  return fresh;
}

/** The chip a list row shows for what a rule spotted in the latest message. `where` picks the row layout that shows it. */
export function RowSignal({ thread, where }: { thread: Thread; where: "wide" | "narrow" }) {
  const helpers = useSession((s) => s.settings.helpers);
  const fresh = useCodeFresh(thread.signalAt);
  const sig = pickSignal(threadSignals(thread), helpers, fresh);
  if (!sig) return null;
  const cls = `sig-${where}`;
  if (sig.kind === "code") return <CodeChip thread={thread} className={cls} />;
  if (sig.kind === "delivery") {
    return (
      <span className={`sig sig-delivery ${cls}`}>
        <Icon name="package" size={12} />
        <span className="sig-text">{deliveryLabel(sig.status)}</span>
      </span>
    );
  }
  if (sig.kind === "security") {
    return (
      <span className={`sig sig-security ${cls}`}>
        <Icon name="shield-alert" size={12} />
        <span className="sig-text">Sign-in alert</span>
      </span>
    );
  }
  const reason = sig.reason || "Urgent";
  return (
    <span className={`sig sig-urgent ${cls}`} title={reason}>
      <Icon name="alert" size={12} />
      <span className="sig-text">{reason}</span>
    </span>
  );
}

function CodeChip({ thread, className }: { thread: Thread; className: string }) {
  const [state, setState] = useState<"idle" | "busy" | "copied">("idle");
  useEffect(() => {
    if (state !== "copied") return;
    const t = setTimeout(() => setState("idle"), 1800);
    return () => clearTimeout(t);
  }, [state]);
  const copy = async (e: MouseEvent) => {
    e.stopPropagation();
    if (state === "busy") return;
    setState("busy");
    setState((await copyCode(() => api.threadCode(thread.id))) ? "copied" : "idle");
  };
  return (
    <button
      type="button"
      className={`sig sig-code ${className}`}
      tabIndex={-1}
      aria-label={state === "copied" ? "Code copied" : "Copy one-time code"}
      aria-busy={state === "busy"}
      title="Copy code (Shift+C)"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => void copy(e)}
    >
      <Icon name={state === "copied" ? "check" : "key"} size={12} />
      <span className="sig-text">{state === "copied" ? "Copied" : "Code"}</span>
      {state !== "copied" && <Icon name="copy" size={11} className="sig-copy" />}
    </button>
  );
}

// ---- Thread view: the card above a message body ---------------------------------------------------

/** A compact card for the signal a message carries. Codes are read from the server only when the card is on screen. */
export function SignalCard({ message, signal, shortcut }: { message: Message; signal: Signal; shortcut: boolean }) {
  if (signal.kind === "code") return <CodeCard message={message} shortcut={shortcut} />;
  if (signal.kind === "delivery") return <DeliveryCard signal={signal} />;
  if (signal.kind === "security") {
    return (
      <div className="sig-card sig-card-security" role="note">
        <Icon name="shield-alert" size={16} className="sig-card-icon" />
        <p className="sig-card-line">
          Sign-in alert{signal.service ? ` from ${signal.service}` : ""}. If it wasn't you, change your password on the service's own site, not from a link in an email.
        </p>
      </div>
    );
  }
  return (
    <div className="sig-card sig-card-urgent" role="note">
      <Icon name="alert" size={16} className="sig-card-icon" />
      <p className="sig-card-line">
        <strong>{signal.reason}</strong>
      </p>
    </div>
  );
}

type CodeState = { status: "loading" } | { status: "ready"; code: string } | { status: "error"; text: string };

function CodeCard({ message, shortcut }: { message: Message; shortcut: boolean }) {
  const [state, setState] = useState<CodeState>({ status: "loading" });
  const [copied, setCopied] = useState(false);
  const now = useNow();

  const load = useCallback(() => {
    let live = true;
    setState({ status: "loading" });
    api
      .messageCode(message.id)
      .then((r) => live && setState({ status: "ready", code: r.code }))
      .catch((err: Error) => live && setState({ status: "error", text: err.message }));
    return () => {
      live = false;
    };
  }, [message.id]);
  useEffect(() => load(), [load]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    if (state.status !== "ready") return;
    if (await copyText(state.code)) setCopied(true);
    else toast.error("Couldn't copy to the clipboard", 3500);
  };

  return (
    <div className="sig-card sig-card-code" role="group" aria-label="One-time code">
      <Icon name="key" size={16} className="sig-card-icon" />
      <div className="sig-card-main">
        {state.status === "error" ? (
          <>
            <span className="sig-card-line">We couldn't read the code from this message.</span>
            <span className="sig-card-sub">{state.text}</span>
          </>
        ) : (
          <>
            <span className="sig-code-digits num" aria-label={state.status === "ready" ? state.code.split("").join(" ") : "Loading the code"} aria-busy={state.status === "loading"}>
              {state.status === "ready" ? state.code : "••••••"}
            </span>
            <span className="sig-card-sub">
              One-time code · {ago(message.sentAt, now)}
            </span>
          </>
        )}
      </div>
      {state.status === "error" ? (
        <button className="btn btn-sm" onClick={load}>
          Try again
        </button>
      ) : (
        <button className="btn btn-sm" onClick={() => void copy()} disabled={state.status !== "ready"}>
          <Icon name={copied ? "check" : "copy"} />
          {copied ? "Copied" : "Copy"}
          {shortcut && !copied && <Keys binding="shift+c" />}
          <span className="sr-only" role="status">
            {copied ? "Code copied" : ""}
          </span>
        </button>
      )}
    </div>
  );
}

function DeliveryCard({ signal }: { signal: Extract<Signal, { kind: "delivery" }> }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="sig-card sig-card-delivery" role="group" aria-label="Delivery update">
      <Icon name="package" size={16} className="sig-card-icon" />
      <div className="sig-card-main">
        <span className="sig-card-line">
          <strong>{deliveryLabel(signal.status)}</strong>
          {signal.carrier ? <span className="sig-card-sub"> · {signal.carrier}</span> : null}
        </span>
        {signal.tracking && <code className="sig-track">{signal.tracking}</code>}
      </div>
      {signal.tracking && (
        <button
          className="btn btn-sm"
          onClick={async () => {
            if (await copyText(signal.tracking!)) setCopied(true);
            else toast.error("Couldn't copy to the clipboard", 3500);
          }}
        >
          <Icon name={copied ? "check" : "copy"} />
          {copied ? "Copied" : "Copy tracking number"}
          <span className="sr-only" role="status">
            {copied ? "Tracking number copied" : ""}
          </span>
        </button>
      )}
    </div>
  );
}

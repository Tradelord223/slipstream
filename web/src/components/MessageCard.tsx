import { useState } from "react";
import { bytes, displayName, firstName, listTime, longTime, ownAddresses } from "../lib/format.ts";
import { cardSignal } from "../lib/signals.ts";
import { useSession } from "../store/session.ts";
import type { Account, Address, Message } from "../types.ts";
import { EmailBody } from "./EmailBody.tsx";
import { Icon } from "./Icon.tsx";
import { SenderAvatar } from "./SenderMark.tsx";
import { SignalCard } from "./Signals.tsx";

function recipientsLine(m: Message, mine: Set<string>): string {
  const names = (list: Address[]) => list.map((a) => (mine.has(a.email.toLowerCase()) ? "me" : firstName(a)));
  const to = names(m.to);
  const cc = names(m.cc);
  const head = to.slice(0, 3).join(", ") + (to.length > 3 ? ` +${to.length - 3}` : "");
  return `to ${head || "undisclosed recipients"}${cc.length ? ` · cc ${cc.slice(0, 2).join(", ")}${cc.length > 2 ? ` +${cc.length - 2}` : ""}` : ""}`;
}

export function MessageCard({
  message,
  expanded,
  focused,
  accounts,
  logos = false,
  codeShortcut = false,
  onToggle,
  onReply,
}: {
  message: Message;
  expanded: boolean;
  focused: boolean;
  accounts: Account[];
  /** Company logos are on for this conversation's account. */
  logos?: boolean;
  /** This is the message Shift+C copies from. */
  codeShortcut?: boolean;
  onToggle: () => void;
  onReply: (kind: "reply" | "replyAll" | "forward") => void;
}) {
  const [details, setDetails] = useState(false);
  const mine = ownAddresses(accounts);
  const helpers = useSession((x) => x.settings.helpers);
  const signal = cardSignal(message.signals ?? [], helpers);
  const logoDomain = logos ? message.logoDomain : null;
  const sender = mine.has(message.from.email.toLowerCase()) ? "me" : displayName(message.from);
  const files = message.attachments.filter((a) => !a.inline || !a.contentId);

  if (!expanded) {
    return (
      <article className={`msg msg-collapsed ${focused ? "msg-focus" : ""}`} data-message-id={message.id} aria-label={`Message from ${sender}`}>
        <button className="msg-line" onClick={onToggle} aria-expanded="false">
          <SenderAvatar name={message.from.name} email={message.from.email} size={22} domain={logoDomain} />
          <span className="msg-line-name">{sender}</span>
          <span className="msg-line-snippet">{message.snippet}</span>
          {files.length > 0 && <Icon name="paperclip" size={14} />}
          <span className="msg-line-time num">{listTime(message.sentAt)}</span>
        </button>
      </article>
    );
  }

  return (
    <article className={`msg ${focused ? "msg-focus" : ""}`} data-message-id={message.id} aria-label={`Message from ${sender}`}>
      <header className="msg-head">
        <button className="msg-head-main" onClick={onToggle} aria-expanded="true" aria-label={`Collapse message from ${sender}`}>
          <SenderAvatar name={message.from.name} email={message.from.email} size={32} domain={logoDomain} />
          <span className="msg-who">
            <span className="msg-name">{displayName(message.from)}</span>
            <span className="msg-to">{recipientsLine(message, mine)}</span>
          </span>
        </button>
        <span className="msg-head-side">
          <time className="msg-time num" dateTime={new Date(message.sentAt).toISOString()} title={longTime(message.sentAt)}>
            {longTime(message.sentAt)}
          </time>
          <span className="msg-tools">
            <button className="icon-btn" aria-label="Reply" title="Reply (R)" onClick={() => onReply("reply")}>
              <Icon name="reply" />
            </button>
            <button className="icon-btn" aria-label="Reply all" title="Reply all (Enter)" onClick={() => onReply("replyAll")}>
              <Icon name="reply-all" />
            </button>
            <button className="icon-btn" aria-label="Forward" title="Forward (F)" onClick={() => onReply("forward")}>
              <Icon name="forward" />
            </button>
            <button className="icon-btn" aria-label={details ? "Hide details" : "Show details"} aria-pressed={details} onClick={() => setDetails((d) => !d)}>
              <Icon name="chevron-down" />
            </button>
          </span>
        </span>
      </header>
      {details && (
        <dl className="msg-details">
          <dt>From</dt>
          <dd>
            {displayName(message.from)} &lt;{message.from.email}&gt;
          </dd>
          <dt>To</dt>
          <dd>{message.to.map((a) => a.email).join(", ") || "none"}</dd>
          {message.cc.length > 0 && (
            <>
              <dt>Cc</dt>
              <dd>{message.cc.map((a) => a.email).join(", ")}</dd>
            </>
          )}
          <dt>Date</dt>
          <dd>{longTime(message.sentAt)}</dd>
        </dl>
      )}
      {signal && <SignalCard message={message} signal={signal} shortcut={codeShortcut} />}
      <EmailBody message={message} />
      {files.length > 0 && (
        <ul className="attachments" aria-label="Attachments">
          {files.map((a) => (
            <li key={a.id}>
              <a className="attachment" href={`/api/attachments/${a.id}`} download={a.filename} rel="noopener">
                <Icon name="paperclip" size={14} />
                <span className="attachment-name">{a.filename}</span>
                <span className="attachment-size num">{bytes(a.size)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

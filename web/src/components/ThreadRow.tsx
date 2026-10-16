import { LabelChip } from "./labels/LabelChip.tsx";
import { memo, type MouseEvent } from "react";
import { listTime, senderLine } from "../lib/format.ts";
import { formatDue } from "../lib/when.ts";
import type { Account, Thread } from "../types.ts";
import { Icon } from "./Icon.tsx";
import { RowMark } from "./SenderMark.tsx";
import { RowSignal } from "./Signals.tsx";

interface Props {
  thread: Thread;
  top: number;
  height: number;
  focused: boolean;
  selected: boolean;
  selecting: boolean;
  accounts: Account[];
  showAccount: boolean;
  /** Company logos are on for this row's account. */
  logos: boolean;
  onOpen: (id: string, e: MouseEvent) => void;
  onToggle: (id: string) => void;
  onDone: (id: string) => void;
  onRemind: (id: string) => void;
  onStar: (id: string) => void;
}

export const ThreadRow = memo(function ThreadRow(p: Props) {
  const { thread: t } = p;
  const account = p.showAccount ? p.accounts.find((a) => a.id === t.accountId) : undefined;
  const sender = senderLine(t.participants, p.accounts, t.messageCount);
  const reminder = t.remindedAt && !t.snoozedUntil;
  const due = t.snoozedUntil ? formatDue(t.snoozedUntil) : null;

  return (
    <div
      id={`row-${t.id}`}
      role="option"
      aria-selected={p.selected || p.focused}
      className={`row ${t.unread ? "unread" : ""} ${p.focused ? "focused" : ""} ${p.selected ? "selected" : ""} ${p.selecting ? "selecting" : ""}`}
      style={{ transform: `translateY(${p.top}px)`, height: p.height }}
      onClick={(e) => p.onOpen(t.id, e)}
      data-thread-id={t.id}
    >
      <span className="row-lead">
        <span className="unread-dot" aria-label={t.unread ? "Unread" : undefined} />
        <button
          className="row-check"
          role="checkbox"
          aria-checked={p.selected}
          aria-label={`Select conversation: ${t.subject}`}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            p.onToggle(t.id);
          }}
        >
          {p.selected && <Icon name="check" size={12} />}
        </button>
      </span>
      <span className="row-sender">
        {p.logos && <RowMark domain={t.logoDomain} />}
        {account && <span className="dot" style={{ background: account.color }} title={account.email} />}
        <span className="ellipsis">{sender}</span>
        <RowSignal thread={t} where="narrow" />
      </span>
      <span className="row-body">
        <span className="row-subject">{t.subject || "(no subject)"}</span>
        <span className="row-snippet">
          {t.snippet ? (
            <>
              <span className="row-sep" aria-hidden="true">
                {" — "}
              </span>
              {t.snippet}
            </>
          ) : null}
        </span>
      </span>
      <span className="row-meta">
        <RowSignal thread={t} where="wide" />
        {t.labels.slice(0, 2).map((l) => (
          <LabelChip key={l} name={l} />
        ))}
        {t.starred && <Icon name="star" size={13} className="row-star" />}
        {t.hasAttachments && <Icon name="paperclip" size={14} className="row-clip" />}
        {reminder && (
          <span className="row-remind">
            <Icon name="clock" size={13} />
            Reminder
          </span>
        )}
      </span>
      <span className="row-time num">
        {due ? (
          <span className="row-remind">
            <Icon name="clock" size={13} />
            {due}
          </span>
        ) : (
          listTime(t.lastMessageAt)
        )}
      </span>
      <span className="row-actions" role="group" aria-label="Quick actions">
        <button className="icon-btn" tabIndex={-1} aria-label="Done" title="Done (E)" onClick={(e) => (e.stopPropagation(), p.onDone(t.id))}>
          <Icon name="check" />
        </button>
        <button className="icon-btn" tabIndex={-1} aria-label="Remind me" title="Remind me (H)" onClick={(e) => (e.stopPropagation(), p.onRemind(t.id))}>
          <Icon name="clock" />
        </button>
        <button className="icon-btn star-btn" tabIndex={-1} aria-label={t.starred ? "Remove star" : "Star"} title="Star (S)" aria-pressed={t.starred} onClick={(e) => (e.stopPropagation(), p.onStar(t.id))}>
          <Icon name="star" />
        </button>
      </span>
    </div>
  );
});

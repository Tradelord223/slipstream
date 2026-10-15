import type { Db } from "../db/index.ts";
import { randomToken } from "../lib/crypto.ts";
import type { MailStore } from "./store.ts";
import type { RemoteAction } from "./types.ts";

export type TriageKind =
  | "done"
  | "undone"
  | "trash"
  | "untrash"
  | "spam"
  | "unspam"
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "snooze"
  | "unsnooze"
  | "mute"
  | "unmute"
  | "addLabel"
  | "removeLabel";

export interface TriageRequest {
  kind: TriageKind;
  threadIds: string[];
  /** snooze: wake time (ms) */
  until?: number;
  /** addLabel/removeLabel */
  label?: string;
}

interface ThreadState {
  id: string;
  in_inbox: number;
  in_trash: number;
  in_spam: number;
  starred: number;
  muted: number;
  unread_count: number;
  snoozed_until: number | null;
  reminded_at: number | null;
  done_at: number | null;
  sort_at: number;
}

interface UndoEntry {
  userId: string;
  before: ThreadState[];
  messageFlags: { id: string; unread: number; starred: number; in_inbox: number; in_trash: number; in_spam: number }[];
  labels: { threadId: string; labelIds: string[] }[];
  expires: number;
}

/** How long triage writes wait before reaching the provider. Undo inside this window never touches the network. */
export const UNDO_WINDOW_MS = 8_000;

/**
 * Triage happens locally first. The UI's view changes in the same request; the provider hears
 * about it after the undo window, through pending_actions.
 */
export class Triage {
  private undo = new Map<string, UndoEntry>();

  private db: Db;
  private store: MailStore;

  constructor(db: Db, store: MailStore) {
    this.db = db;
    this.store = store;
  }

  apply(userId: string, req: TriageRequest, now = Date.now()): { undoToken: string; threadIds: string[] } {
    const owned = this.ownedThreads(userId, req.threadIds);
    const undoToken = randomToken(12);
    const entry: UndoEntry = { userId, before: [], messageFlags: [], labels: [], expires: now + 60_000 };

    this.db.tx(() => {
      for (const id of owned) {
        entry.before.push(this.db.get<ThreadState>("SELECT * FROM threads WHERE id = ?", id)!);
        entry.messageFlags.push(
          ...this.db.all<UndoEntry["messageFlags"][number]>(
            "SELECT id, unread, starred, in_inbox, in_trash, in_spam FROM messages WHERE thread_id = ?",
            id,
          ),
        );
        entry.labels.push({
          threadId: id,
          labelIds: this.db.all<{ label_id: string }>("SELECT label_id FROM thread_labels WHERE thread_id = ?", id).map(
            (r) => r.label_id,
          ),
        });
        const remote = this.applyLocal(id, req, now);
        for (const action of remote) this.enqueue(id, action, undoToken, now + UNDO_WINDOW_MS);
      }
    });

    this.undo.set(undoToken, entry);
    this.gc(now);
    return { undoToken, threadIds: owned };
  }

  /** Revert a triage action. Cancels provider writes that haven't run; reverses ones that have. */
  revert(userId: string, undoToken: string): string[] {
    const entry = this.undo.get(undoToken);
    if (!entry || entry.userId !== userId) return [];
    this.undo.delete(undoToken);
    const now = Date.now();

    this.db.tx(() => {
      const ran = this.db.all<{ id: number; account_id: string; payload: string }>(
        "SELECT id, account_id, payload FROM pending_actions WHERE undo_group = ? AND status IN ('done','running')",
        undoToken,
      );
      this.db.run("UPDATE pending_actions SET status = 'cancelled' WHERE undo_group = ? AND status = 'queued'", undoToken);

      for (const t of entry.before) {
        this.db.run(
          `UPDATE threads SET in_inbox=?, in_trash=?, in_spam=?, starred=?, muted=?, unread_count=?, snoozed_until=?,
             reminded_at=?, done_at=?, sort_at=?, updated_at=? WHERE id=?`,
          t.in_inbox, t.in_trash, t.in_spam, t.starred, t.muted, t.unread_count, t.snoozed_until,
          t.reminded_at, t.done_at, t.sort_at, now, t.id,
        );
      }
      for (const m of entry.messageFlags) {
        this.db.run(
          "UPDATE messages SET unread=?, starred=?, in_inbox=?, in_trash=?, in_spam=? WHERE id=?",
          m.unread, m.starred, m.in_inbox, m.in_trash, m.in_spam, m.id,
        );
      }
      for (const l of entry.labels) {
        this.db.run("DELETE FROM thread_labels WHERE thread_id = ?", l.threadId);
        for (const lid of l.labelIds) this.db.run("INSERT INTO thread_labels (thread_id, label_id) VALUES (?,?)", l.threadId, lid);
      }
      // Anything the provider already did gets the opposite action, without delay.
      for (const r of ran) {
        const p = JSON.parse(r.payload) as { threadId: string; action: RemoteAction };
        const inverse = invert(p.action);
        if (inverse) this.enqueue(p.threadId, inverse, null, now);
      }
    });
    return entry.before.map((t) => t.id);
  }

  private ownedThreads(userId: string, ids: string[]): string[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .all<{ id: string }>(
        `SELECT t.id FROM threads t JOIN accounts a ON a.id = t.account_id WHERE a.user_id = ? AND t.id IN (${placeholders})`,
        userId,
        ...ids,
      )
      .map((r) => r.id);
  }

  /** Mutates local state for one thread and returns the provider actions it implies. */
  private applyLocal(threadId: string, req: TriageRequest, now: number): RemoteAction[] {
    const ref = this.store.threadRef(threadId);
    const thread = { threadRemoteId: ref.threadRemoteId, messages: ref.messages };
    const setThread = (sql: string, ...p: (string | number | null)[]) =>
      this.db.run(`UPDATE threads SET ${sql}, updated_at = ? WHERE id = ?`, ...p, now, threadId);
    const setMessages = (sql: string) => this.db.run(`UPDATE messages SET ${sql} WHERE thread_id = ?`, threadId);

    switch (req.kind) {
      case "done":
        setThread("in_inbox = 0, done_at = ?, reminded_at = NULL", now);
        setMessages("in_inbox = 0");
        return [{ kind: "archive", ...thread }];
      case "undone":
        setThread("in_inbox = 1, in_trash = 0, in_spam = 0, done_at = NULL, snoozed_until = NULL");
        setMessages("in_inbox = 1, in_trash = 0, in_spam = 0");
        return [{ kind: "unarchive", ...thread }];
      case "trash":
        setThread("in_inbox = 0, in_trash = 1, snoozed_until = NULL");
        setMessages("in_inbox = 0, in_trash = 1");
        return [{ kind: "trash", ...thread }];
      case "untrash":
        setThread("in_trash = 0, in_inbox = 1");
        setMessages("in_trash = 0, in_inbox = 1");
        return [{ kind: "untrash", ...thread }];
      case "spam":
        setThread("in_inbox = 0, in_spam = 1, snoozed_until = NULL");
        setMessages("in_inbox = 0, in_spam = 1");
        return [{ kind: "spam", ...thread }];
      case "unspam":
        setThread("in_spam = 0, in_inbox = 1");
        setMessages("in_spam = 0, in_inbox = 1");
        return [{ kind: "unspam", ...thread }];
      case "read":
        setThread("unread_count = 0");
        setMessages("unread = 0");
        return [{ kind: "markRead", ...thread }];
      case "unread": {
        // Gmail-style: marks the latest message unread, not the whole thread.
        const last = this.db.get<{ id: string }>(
          "SELECT id FROM messages WHERE thread_id = ? ORDER BY sent_at DESC LIMIT 1",
          threadId,
        );
        if (last) this.db.run("UPDATE messages SET unread = 1 WHERE id = ?", last.id);
        setThread("unread_count = MAX(unread_count, 1)");
        return [{ kind: "markUnread", ...thread }];
      }
      case "star":
        setThread("starred = 1");
        setMessages("starred = 1");
        return [{ kind: "star", ...thread }];
      case "unstar":
        setThread("starred = 0");
        setMessages("starred = 0");
        return [{ kind: "unstar", ...thread }];
      case "snooze": {
        if (!req.until || req.until <= now) throw new Error("Remind time must be in the future");
        setThread("in_inbox = 0, snoozed_until = ?, reminded_at = NULL", req.until);
        setMessages("in_inbox = 0");
        return [{ kind: "archive", ...thread }];
      }
      case "unsnooze":
        setThread("in_inbox = 1, snoozed_until = NULL");
        setMessages("in_inbox = 1");
        return [{ kind: "unarchive", ...thread }];
      case "mute":
        setThread("muted = 1, in_inbox = 0, done_at = ?", now);
        setMessages("in_inbox = 0");
        return [{ kind: "archive", ...thread }];
      case "unmute":
        setThread("muted = 0");
        return [];
      case "addLabel":
      case "removeLabel": {
        const name = (req.label ?? "").trim();
        if (!name) throw new Error("Label name required");
        let label = this.db.get<{ id: string; remote_id: string; name: string }>(
          "SELECT id, remote_id, name FROM labels WHERE account_id = ? AND lower(name) = lower(?)",
          ref.accountId,
          name,
        );
        if (!label && req.kind === "removeLabel") return [];
        if (!label) {
          const id = `lbl_${randomToken(9)}`;
          // remote_id is provisional; providers resolve or create the label by name.
          this.db.run(
            "INSERT INTO labels (id, account_id, remote_id, name) VALUES (?,?,?,?)",
            id,
            ref.accountId,
            `name:${name}`,
            name,
          );
          label = { id, remote_id: `name:${name}`, name };
        }
        if (req.kind === "addLabel")
          this.db.run("INSERT OR IGNORE INTO thread_labels (thread_id, label_id) VALUES (?,?)", threadId, label.id);
        else this.db.run("DELETE FROM thread_labels WHERE thread_id = ? AND label_id = ?", threadId, label.id);
        setThread("updated_at = updated_at");
        return [{ kind: req.kind, label: { remoteId: label.remote_id, name: label.name }, ...thread }];
      }
    }
  }

  private enqueue(threadId: string, action: RemoteAction, undoGroup: string | null, runAfter: number) {
    const accountId = this.db.get<{ account_id: string }>("SELECT account_id FROM threads WHERE id = ?", threadId)!.account_id;
    this.db.run(
      "INSERT INTO pending_actions (account_id, kind, payload, undo_group, run_after, created_at) VALUES (?,?,?,?,?,?)",
      accountId,
      action.kind,
      JSON.stringify({ threadId, action }),
      undoGroup,
      runAfter,
      Date.now(),
    );
  }

  private gc(now: number) {
    for (const [k, v] of this.undo) if (v.expires < now) this.undo.delete(k);
  }
}

export function invert(a: RemoteAction): RemoteAction | null {
  const swap: Partial<Record<RemoteAction["kind"], RemoteAction["kind"]>> = {
    archive: "unarchive",
    unarchive: "archive",
    trash: "untrash",
    untrash: "trash",
    spam: "unspam",
    unspam: "spam",
    markRead: "markUnread",
    markUnread: "markRead",
    star: "unstar",
    unstar: "star",
    addLabel: "removeLabel",
    removeLabel: "addLabel",
  };
  const k = swap[a.kind];
  return k ? ({ ...a, kind: k } as RemoteAction) : null;
}

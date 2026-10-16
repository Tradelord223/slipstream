/**
 * The contract between Slipstream's local store and a mail provider.
 *
 * Providers translate their world (Gmail labels, Graph folders, IMAP mailboxes)
 * into IncomingMessage on the way in, and RemoteAction on the way out.
 * Everything above this layer only ever talks to SQLite.
 */

export type ProviderKind = "gmail" | "outlook" | "imap" | "demo" | "archive";

export interface Address {
  name: string;
  email: string;
}

export interface Folders {
  inbox: boolean;
  sent: boolean;
  trash: boolean;
  spam: boolean;
}

export interface IncomingAttachment {
  filename: string;
  mimeType: string;
  size: number;
  contentId?: string;
  inline: boolean;
  /** Provider handle for lazy download (Gmail attachmentId, Graph attachment id, IMAP part). */
  remoteId?: string;
  /** Bytes, when the provider already has them (mbox/eml import, IMAP full fetch). */
  content?: Buffer;
}

export interface IncomingMessage {
  /** Stable per account. Gmail message id, Graph immutable id, IMAP "<mailbox>:<uidvalidity>:<uid>" or Message-ID. */
  remoteId: string;
  /** Provider conversation id when one exists (Gmail threadId, Graph conversationId, X-GM-THRID). */
  remoteThreadId?: string;
  messageIdHeader?: string;
  inReplyTo?: string;
  references?: string[];
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo?: string;
  subject: string;
  sentAt: number;
  snippet?: string;
  bodyText: string;
  bodyHtml?: string;
  unread: boolean;
  starred: boolean;
  folders: Folders;
  /** User labels/categories. System folders belong in `folders`. */
  labels?: { remoteId: string; name: string; color?: string }[];
  listUnsubscribe?: string;
  /** Sent by a mailing list or automated system (List-Id, Precedence: bulk, Auto-Submitted). */
  bulk?: boolean;
  /** True when the account owner sent it. */
  outgoing?: boolean;
  attachments: IncomingAttachment[];
}

/** A change to an already-synced message that doesn't need the body again. */
export interface FlagUpdate {
  remoteId: string;
  unread?: boolean;
  starred?: boolean;
  folders?: Partial<Folders>;
  labels?: { remoteId: string; name: string }[];
}

export interface SyncPage {
  messages: IncomingMessage[];
  flagUpdates?: FlagUpdate[];
  deletedRemoteIds?: string[];
  /** Opaque provider cursor to persist (Gmail historyId, Graph deltaLink, IMAP modseq map). */
  cursor: string | null;
  /** False when the provider wants to be called again right away with the new cursor. */
  done: boolean;
}

export interface ThreadRef {
  threadRemoteId: string;
  messages: { remoteId: string; messageIdHeader?: string | null }[];
}

export type RemoteAction =
  | ({ kind: "archive" | "unarchive" | "trash" | "untrash" | "spam" | "unspam" } & ThreadRef)
  | ({ kind: "markRead" | "markUnread" | "star" | "unstar" } & ThreadRef)
  | ({ kind: "addLabel" | "removeLabel"; label: { remoteId: string; name: string } } & ThreadRef)
  | { kind: "send"; message: OutgoingMessage };

export interface OutgoingMessage {
  from: Address;
  /** Where replies should go, when it isn't the From address. */
  replyTo?: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  threadRemoteId?: string;
  attachments?: { filename: string; mimeType: string; content: Buffer }[];
  /** Pre-built RFC 5322 bytes; providers that accept raw MIME use this. */
  raw: Buffer;
  messageIdHeader: string;
}

export interface ProviderContext {
  accountId: string;
  email: string;
  /** Decrypted credentials. */
  auth: unknown;
  /** Persist refreshed credentials (OAuth token rotation). */
  saveAuth(auth: unknown): void;
  /** How far back the first sync reaches. */
  initialSyncDays: number;
  signal?: AbortSignal;
}

/** An extra address the account can send as, as the provider lists it. */
export interface ProviderIdentity {
  email: string;
  name: string;
  replyTo?: string;
  /** Sanitized HTML. */
  signatureHtml?: string;
}

export interface MailProvider {
  readonly kind: ProviderKind;
  /** Pull one page of changes. `cursor` is null for the first sync. */
  sync(cursor: string | null): Promise<SyncPage>;
  apply(action: RemoteAction): Promise<{ remoteId?: string } | void>;
  fetchAttachment?(messageRemoteId: string, attachmentRemoteId: string): Promise<Buffer>;
  /** The account's send-as aliases (Gmail). Throws when the provider can't say; callers keep what they have. */
  listIdentities?(): Promise<ProviderIdentity[]>;
  /** Rename a label at the provider (labels whose remoteId is still a local "name:" placeholder are skipped). */
  renameLabel?(label: { remoteId: string; name: string }, newName: string): Promise<void>;
  /** Delete a label at the provider; messages keep existing, they just lose the label. */
  deleteLabel?(label: { remoteId: string; name: string }): Promise<void>;
  close?(): Promise<void>;
}

export class ProviderAuthError extends Error {
  override name = "ProviderAuthError";
}

/** Thrown by a provider when it can't do an action, so the queue stops retrying it. */
export class PermanentProviderError extends Error {
  override name = "PermanentProviderError";
}

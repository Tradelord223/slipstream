// Shapes returned by the Slipstream API (server/src/http/*.ts).

export interface Address {
  name: string;
  email: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Workspace {
  id: string;
  name: string;
  role: "owner" | "member";
}

export interface Account {
  id: string;
  provider: "demo" | "gmail" | "outlook" | "imap" | "archive" | string;
  email: string;
  name: string;
  color: string;
  syncStatus: "idle" | "syncing" | "error" | "reauth" | string;
  syncError: string | null;
  lastSyncedAt: number | null;
}

export interface Split {
  id: string;
  name: string;
  query: string;
  builtin: boolean;
}

export interface Settings {
  theme: "system" | "dark" | "light";
  density: "comfortable" | "compact";
  remoteImages: "ask" | "always";
  autoAdvance: "next" | "previous" | "list";
  signature: string;
  keymap: Record<string, string>;
  instantIntro: string;
  defaultRemindHour: number;
  showTips: boolean;
  unifiedInbox: boolean;
}

export interface Features {
  ai: boolean;
  google: boolean;
  microsoft: boolean;
  undoSendSeconds: number;
}

export interface Bootstrap {
  mode: "local" | "team";
  user: User;
  workspace: Workspace | null;
  accounts: Account[];
  splits: Split[];
  labels: string[];
  settings: Partial<Settings>;
  features: Features;
}

export interface Thread {
  id: string;
  accountId: string;
  subject: string;
  snippet: string;
  participants: Address[];
  lastMessageAt: number;
  sortAt: number;
  messageCount: number;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  snoozedUntil: number | null;
  remindedAt: number | null;
  followUpAt: number | null;
  category: string;
  inInbox: boolean;
  inTrash: boolean;
  labels: string[];
}

export interface ThreadPage {
  threads: Thread[];
  next: string | null;
}

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
}

export interface Message {
  id: string;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: string | null;
  subject: string;
  sentAt: number;
  snippet: string;
  text: string;
  html: string | null;
  unread: boolean;
  outgoing: boolean;
  canUnsubscribe: boolean;
  attachments: Attachment[];
}

export interface ThreadDetail {
  thread: Thread;
  messages: Message[];
  draftId: string | null;
  sharedId: string | null;
}

export interface Counts {
  splits: Record<string, { total: number; unread: number }>;
  inbox: { total: number; unread: number };
  reminders: number;
  doneToday: number;
}

export interface Contact {
  email: string;
  name: string;
  vip: boolean;
}

export interface ContactInfo extends Contact {
  sent: number;
  received: number;
  lastSeenAt: number | null;
  recent: Thread[];
}

export interface DraftAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface Draft {
  id: string;
  accountId: string;
  threadId: string | null;
  replyToMessageId: string | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  bodyHtml: string;
  sendAt: number | null;
  status: "draft" | "scheduled" | "sending" | "sent" | "failed" | string;
  error: string | null;
  updatedAt: number;
  attachments: DraftAttachment[];
}

export interface Snippet {
  id: string;
  name: string;
  subject: string | null;
  bodyHtml: string;
  shared: boolean;
  mine: boolean;
  author: string;
  useCount: number;
}

export interface TriageResult {
  undoToken: string;
  threadIds: string[];
}

export type TriageKind =
  | "done" | "undone" | "trash" | "untrash" | "spam" | "unspam" | "read" | "unread" | "star" | "unstar"
  | "snooze" | "unsnooze" | "mute" | "unmute" | "addLabel" | "removeLabel";

export interface SharedSummary {
  id: string;
  subject: string;
  status: "open" | "resolved";
  sharedBy: string;
  assignee: { id: string; name: string } | null;
  updatedAt: number;
  commentCount: number;
  lastComment: string | null;
}

export interface SharedComment {
  id: string;
  author: { id: string; name: string };
  body: string;
  createdAt: number;
}

export interface SharedDetail {
  id: string;
  subject: string;
  status: "open" | "resolved";
  assigneeId: string | null;
  sharedBy: User | null;
  ownThreadId: string | null;
  messages: { from: Address; to: Address[]; cc: Address[]; sentAt: number; subject: string; text: string; html: string | null }[];
  comments: SharedComment[];
}

export interface TeamInfo {
  workspace: Workspace | null;
  members: { id: string; name: string; email: string; role: string }[];
  invites: { email: string | null; expiresAt: number }[];
}

export type ServerEvent =
  | { type: "threads"; accountId: string; threadIds: string[] }
  | { type: "sync"; accountId: string; status: string; error?: string | null }
  | { type: "drafts"; draftId: string; status: string; error?: string | null }
  | { type: "team"; workspaceId: string; sharedThreadId: string }
  | { type: "import"; jobId: string; accountId: string; status: "running" | "done" | "failed"; imported: number; error?: string };

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
  /** Where this server's source is (AGPL-3.0). */
  sourceUrl?: string;
  /** How to run this install's CLI from another program, with absolute paths (local mode). */
  cli?: { command: string; args: string[] } | null;
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
  | { type: "activity"; activityId: string }
  | { type: "approval"; approvalId: string; status: string }
  | { type: "cloud"; runId: string }
  | { type: "autopilot" }
  | { type: "import"; jobId: string; accountId: string; status: "running" | "done" | "failed"; imported: number; error?: string };

// ---- Agents ----------------------------------------------------------------

export type AgentScope = "read" | "triage" | "draft" | "send" | "settings";

export interface AgentPolicy {
  send: "always" | "external" | "never";
  bulkThreshold: number;
  settings: "approve" | "allow";
}

export interface AgentInfo {
  id: string;
  name: string;
  scopes: AgentScope[];
  policy: AgentPolicy;
  tokenHint: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface AgentInput {
  name: string;
  scopes: AgentScope[];
  policy: Partial<AgentPolicy>;
}

export interface Approval {
  id: string;
  agent: { id: string; name: string };
  command: string;
  title: string;
  preview: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "failed" | string;
  error: string | null;
  createdAt: number;
  decidedAt: number | null;
  /** The conversations it touches. */
  threadIds: string[];
  /** What the agent asked for (for drafts.send, input.draftId). */
  input: Record<string, unknown>;
  /** The agent run that asked, when it came from one. */
  runId: string | null;
}

export type ActivityActor = { kind: "agent"; id: string; name: string } | { kind: "human"; name: string };

export interface ActivityItem {
  id: string;
  actor: ActivityActor;
  command: string;
  summary: string;
  threadIds: string[];
  status: "done" | "pending" | "rejected" | "failed" | "undone" | string;
  canUndo: boolean;
  approvalId: string | null;
  error: string | null;
  createdAt: number;
}

export interface ExecuteResult {
  status: "done" | "pending_approval";
  result?: unknown;
  activityId?: string | null;
  approvalId?: string;
  reason?: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  createdAt: number;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveryAt: number | null;
}

export type RemoteMode = "serve" | "funnel" | "off";

export interface RemoteStatus {
  tailscale: {
    installed: boolean;
    running: boolean;
    dnsName: string | null;
    serve: { url: string } | null;
    funnel: { url: string } | null;
    error?: string;
  };
  publicListener: { port: number };
}

// ---- Cloud agent ---------------------------------------------------------------

export type RunStatus = "starting" | "running" | "done" | "failed" | "budget" | "stopped";

export interface TranscriptEntry {
  kind: "user" | "agent" | "tool" | "note";
  text: string;
  at: number;
}

export interface CloudRun {
  id: string;
  sessionId: string | null;
  routineId: string | null;
  /** Who started it: the sidebar, a routine, or Autopilot (those belong to the Autopilot page). */
  origin: "assistant" | "routine" | "autopilot";
  /** The engine and model it ran on. */
  engine: EngineId | null;
  model: string | null;
  /** The agent that acted, so Review and Activity can be matched to this run. */
  agentId: string | null;
  /** Tokens used, for engines that report them. */
  tokens?: { input: number; output: number };
  instruction: string;
  status: RunStatus;
  transcript: TranscriptEntry[];
  toolCalls: number;
  /** US cents; null until Anthropic reports it. */
  costCents: number | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export type RoutineTrigger =
  | { type: "schedule"; days: number[]; time: string; timezone: string }
  | { type: "mail"; query: string };

export interface Routine {
  id: string;
  name: string;
  instruction: string;
  trigger: RoutineTrigger;
  enabled: boolean;
  /** null follows the default engine. */
  engine: EngineId | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
}

export interface RoutineInput {
  name: string;
  instruction: string;
  trigger: RoutineTrigger;
  enabled: boolean;
  engine?: EngineId | null;
}

export interface CloudStatus {
  connected: boolean;
  hasKey: boolean;
  model: string;
  agent: { id: string; name: string; scopes: AgentScope[]; policy: AgentPolicy } | null;
  runBudgetCents: number;
  monthlyBudgetCents: number;
  spentThisMonthCents: number;
  routines: Routine[];
  runs: CloudRun[];
}

export interface CloudConnectInput {
  apiKey?: string;
  scopes: AgentScope[];
  policy?: Partial<AgentPolicy>;
  runBudgetCents?: number;
  monthlyBudgetCents?: number;
}

// ---- Labels ----------------------------------------------------------------------

export interface LabelInfo {
  name: string;
  color: string | null;
  count: number;
  unread: number;
  parent: string | null;
}

export interface LabelRule {
  id: string;
  label: string;
  query: string;
  enabled: boolean;
  createdAt: number;
}

// ---- Models & accounts -----------------------------------------------------------------

export type EngineId =
  | "managed:anthropic"
  | "loop:chatgpt"
  | "loop:anthropic"
  | "loop:openai"
  | "loop:gemini"
  | "loop:openrouter"
  | "cli:claude-code"
  | "cli:codex";

export type KeyProvider = "openai" | "anthropic" | "gemini" | "openrouter";

export interface EngineStatus {
  id: EngineId;
  label: string;
  kind: "managed" | "loop" | "cli";
  /** Can start a run right now. */
  ready: boolean;
  /** One line for people: "Signed in as ana@…", "Add an API key". */
  detail: string;
  needs?: "key" | "signin" | "install" | "login";
  models?: string[];
  /** The model runs will use. */
  model?: string | null;
  /** API keys report a dollar cost; plans and CLIs use their own limits. */
  billing: "api" | "plan";
  /** Terms, billing and sandboxing words a person should read before choosing it. */
  note?: string;
  /** Sign-in is waiting for the person to finish in their browser. */
  pending?: boolean;
  account?: { email?: string; plan?: string };
}

export interface EnginesOverview {
  engines: EngineStatus[];
  defaultEngine: EngineId | null;
  /** The engine a new run would use right now. */
  resolvedEngine: EngineId | null;
  keys: Record<KeyProvider, "saved" | "environment" | null>;
  budgets: { runBudgetCents: number; monthlyBudgetCents: number };
  mode: "local" | "team";
}

export interface ChatGPTSignIn {
  authorizeUrl: string;
  mode: "loopback" | "paste";
}

// ---- Autopilot ------------------------------------------------------------------------------

export type AutopilotAction = "keep" | "done" | "remind";
export type AutopilotPriority = "urgent" | "normal" | "low";

export interface AutopilotSettings {
  enabled: boolean;
  mode: "suggest" | "auto";
  engine: EngineId | null;
  playbook: string;
  draftReplies: boolean;
  since: number;
  /** Where a backfill reaches back to, when one was asked for. */
  backfillFrom: number | null;
  voice: string;
}

export interface AutopilotDecision {
  action: AutopilotAction;
  remindAt?: string;
  labels: string[];
  priority: AutopilotPriority;
  needsReply: boolean;
  summary: string;
  reason: string;
  confidence: number;
  warnings?: string[];
}

export interface AutopilotItem {
  id: string;
  threadId: string;
  subject: string;
  from: Address;
  stage: "queued" | "deciding" | "decided" | "failed";
  source: "model" | "sender";
  decision: AutopilotDecision | null;
  applied: boolean;
  status: "open" | "accepted" | "dismissed" | "corrected";
  correction: unknown;
  draftId: string | null;
  draftSent: boolean;
  inInbox: boolean;
  createdAt: number;
  decidedAt: number | null;
}

export interface SenderRuleAction {
  action: "keep" | "done";
  labels: string[];
  priority: AutopilotPriority;
}

export interface SenderRule {
  id: string;
  pattern: string;
  action: SenderRuleAction;
}

export interface SenderSuggestion {
  pattern: string;
  action: SenderRuleAction;
  times: number;
}

export interface AutopilotMetrics {
  decided: number;
  corrected: number;
  accepted: number;
  dismissed: number;
  outOfInbox: number;
  draftsWritten: number;
  draftsSent: number;
  draftsSentAsWritten: number;
  /** Mail your own sender rules handled (the other numbers count model decisions only). */
  bySenderRules: number;
  averageEdit: number | null;
}

export interface AutopilotOverview {
  settings: AutopilotSettings;
  engine: { id: EngineId; label: string } | null;
  problem: string | null;
  running: boolean;
  labels: string[];
  items: AutopilotItem[];
  senderRules: SenderRule[];
  suggestions: SenderSuggestion[];
  metrics: AutopilotMetrics;
}

export type AutopilotPatch = Partial<Pick<AutopilotSettings, "enabled" | "mode" | "engine" | "playbook" | "draftReplies" | "voice">>;

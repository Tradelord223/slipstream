import type {
  ActivityItem, AgentInfo, AgentInput, Approval, ExecuteResult, RemoteMode, RemoteStatus, Webhook,
  Address, Bootstrap, ContactInfo, Contact, Counts, Discovery, Draft, Identity, SharedDetail, SharedSummary, Snippet, TeamInfo, ThreadDetail,
  ThreadPage, TriageKind, TriageResult, SharedComment,
  CloudConnectInput, CloudRun, CloudStatus, LabelInfo, LabelRule, Routine, RoutineInput,
  AutopilotOverview, AutopilotPatch, ChatGPTSignIn, EngineId, EnginesOverview, KeyProvider, SenderRuleAction, MessageBodies,
} from "./types.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Fired when the server asks for a sign-in (team mode). */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, opts: { quiet401?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { "x-slipstream": "1" };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, signal: opts.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "Can't reach Slipstream. Check that it's still running.");
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = (await res.json()) as { error?: string; issues?: { message?: string }[] };
      if (data.error) message = data.error;
      // Validation failures say "Invalid request"; the first issue says what to fix.
      if (data.issues?.[0]?.message) message = data.issues[0].message;
    } catch {
      /* not JSON */
    }
    if (res.status === 401 && !opts.quiet401) onUnauthorized?.();
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

const patch = <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {});
const get = <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, { signal });
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
const put = <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {});
const del = <T>(path: string) => request<T>("DELETE", path);

const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** Run a Slipstream command the way an agent would; people and agents share one registry. */
function command<T>(name: string, input: unknown = {}) {
  return post<{ status: string; result: T; activityId?: string | null }>(`/api/v1/${name}`, input);
}

export interface ListParams {
  view: "inbox" | "split" | "search";
  split?: string;
  q?: string;
  account?: string;
  before?: string | null;
  limit?: number;
}

export const api = {
  bootstrap: () => request<Bootstrap>("GET", "/api/bootstrap", undefined, { quiet401: true }),
  authState: () => request<{ mode: "local" | "team"; needsSetup: boolean; openSignup: boolean }>("GET", "/api/auth/state", undefined, { quiet401: true }),
  login: (email: string, password: string) => request<{ user: unknown }>("POST", "/api/auth/login", { email, password }, { quiet401: true }),
  signup: (body: { email: string; name: string; password: string; workspaceName?: string; invite?: string }) =>
    request<{ user: unknown }>("POST", "/api/auth/signup", body, { quiet401: true }),
  invite: (token: string) => request<{ workspace: string; email: string | null }>("GET", `/api/auth/invite${qs({ token })}`, undefined, { quiet401: true }),
  logout: () => post<{ ok: true }>("/api/auth/logout"),
  joinWorkspace: (invite: string) => post<{ workspace: unknown }>("/api/auth/join", { invite }),

  threads: (p: ListParams, signal?: AbortSignal) =>
    get<ThreadPage>(`/api/threads${qs({ view: p.view, split: p.split, q: p.q, account: p.account, before: p.before, limit: p.limit })}`, signal),
  thread: (id: string, signal?: AbortSignal) => get<ThreadDetail>(`/api/threads/${encodeURIComponent(id)}`, signal),
  /** Full text for messages that were synced as previews. */
  threadBodies: (id: string, messageIds: string[]) => get<MessageBodies>(`/api/threads/${encodeURIComponent(id)}/bodies${qs({ ids: messageIds.join(",") })}`),
  /** A one-time code, read from the message only when asked. */
  messageCode: (id: string) => get<{ code: string }>(`/api/messages/${encodeURIComponent(id)}/code`),
  threadCode: (id: string) => get<{ code: string }>(`/api/threads/${encodeURIComponent(id)}/code`),
  counts: () => get<Counts>("/api/counts"),
  triage: (kind: TriageKind, threadIds: string[], extra: { until?: number; label?: string } = {}) =>
    post<TriageResult>("/api/triage", { kind, threadIds, ...extra }),
  undo: (undoToken: string) => post<{ threadIds: string[] }>("/api/undo", { undoToken }),
  zero: (body: { olderThanDays: number; keepStarred: boolean; keepUnread: boolean }) =>
    post<{ undoToken: string | null; threadIds: string[] }>("/api/zero", body),
  unsubscribe: (threadId: string) =>
    post<{ method: "web" | "email"; url?: string | null; undoToken: string }>(`/api/threads/${encodeURIComponent(threadId)}/unsubscribe`),

  contacts: (q: string, signal?: AbortSignal) => get<{ contacts: Contact[] }>(`/api/contacts${qs({ q })}`, signal),
  contact: (email: string) => get<ContactInfo>(`/api/contacts/${encodeURIComponent(email)}`),
  setVip: (email: string, vip: boolean) => post<{ ok: true }>(`/api/contacts/${encodeURIComponent(email)}/vip`, { vip }),

  drafts: () => get<{ drafts: Draft[] }>("/api/drafts"),
  draft: (id: string) => get<Draft>(`/api/drafts/${id}`),
  createDraft: (d: DraftInput) => post<Draft>("/api/drafts", d),
  saveDraft: (id: string, d: DraftInput) => put<Draft>(`/api/drafts/${id}`, d),
  deleteDraft: (id: string) => del<{ ok: true }>(`/api/drafts/${id}`),
  sendDraft: (id: string, o: { sendAt?: number; instant?: boolean; followUpDays?: number; markDone?: boolean }) =>
    post<{ id: string; sendAt: number; undoToken: string | null }>(`/api/drafts/${id}/send`, o),
  cancelDraft: (id: string) => post<Draft>(`/api/drafts/${id}/cancel`),
  attachToDraft: (id: string, files: File[]) => {
    const f = new FormData();
    for (const file of files) f.append("file", file);
    return request<Draft>("POST", `/api/drafts/${id}/attachments`, f);
  },
  removeDraftAttachment: (id: string, att: string) => del<Draft>(`/api/drafts/${id}/attachments/${att}`),

  snippets: () => get<{ snippets: Snippet[] }>("/api/snippets"),
  createSnippet: (s: SnippetInput) => post<{ id: string }>("/api/snippets", s),
  updateSnippet: (id: string, s: SnippetInput) => put<{ ok: true }>(`/api/snippets/${id}`, s),
  deleteSnippet: (id: string) => del<{ ok: true }>(`/api/snippets/${id}`),
  snippetUsed: (id: string) => post<{ ok: true }>(`/api/snippets/${id}/used`),

  saveSettings: (s: Record<string, unknown>) => put<{ ok: true }>("/api/settings", s),
  summarize: (threadId: string) => post<{ summary: string }>("/api/ai/summarize", { threadId }),
  aiDraft: (body: { threadId?: string; instruction: string; currentDraft?: string }) => post<{ text: string }>("/api/ai/draft", body),
  saveAiKey: (apiKey: string) => put<{ ok: true }>("/api/settings/ai-key", { apiKey }),
  createSplit: (name: string, query: string) => post<{ id: string; name: string; query: string; builtin: boolean }>("/api/splits", { name, query }),
  updateSplit: (id: string, name: string, query: string) => put<{ ok: true }>(`/api/splits/${id}`, { name, query }),
  deleteSplit: (id: string) => del<{ ok: true }>(`/api/splits/${id}`),
  orderSplits: (ids: string[]) => put<{ ok: true }>("/api/splits-order", { ids }),

  presets: () => get<{ presets: { id: string; label: string; help: string }[] }>("/api/accounts/presets"),
  connectImap: (body: Record<string, unknown>) => post<{ id: string }>("/api/accounts/imap", body),
  discover: (email: string) => get<Discovery>(`/api/accounts/discover?email=${encodeURIComponent(email)}`),
  syncAccount: (id: string) => post<{ ok: true }>(`/api/accounts/${id}/sync`),
  removeAccount: (id: string) => del<{ ok: true }>(`/api/accounts/${id}`),
  addIdentity: (accountId: string, body: IdentityInput) => post<Identity>(`/api/accounts/${accountId}/identities`, body),
  updateIdentity: (accountId: string, id: string, body: Partial<IdentityInput>) =>
    patch<Identity>(`/api/accounts/${accountId}/identities/${encodeURIComponent(id)}`, body),
  removeIdentity: (accountId: string, id: string) => del<{ ok: true }>(`/api/accounts/${accountId}/identities/${encodeURIComponent(id)}`),
  importMail: (file: File, email: string) => {
    const f = new FormData();
    f.append("file", file);
    if (email) f.append("email", email);
    return request<{ jobId: string; accountId: string }>("POST", "/api/import", f);
  },

  team: () => get<TeamInfo>("/api/team"),
  createInvite: (email?: string) => post<{ url: string; expiresInDays: number }>("/api/team/invites", email ? { email } : {}),
  removeMember: (id: string) => del<{ ok: true }>(`/api/team/members/${id}`),
  shareThread: (id: string) => post<{ id: string }>(`/api/threads/${encodeURIComponent(id)}/share`),
  shared: (status: "open" | "resolved" = "open") => get<{ shared: SharedSummary[] }>(`/api/shared${qs({ status })}`),
  sharedThread: (id: string) => get<SharedDetail>(`/api/shared/${id}`),
  comment: (id: string, body: string) => post<SharedComment>(`/api/shared/${id}/comments`, { body }),
  updateShared: (id: string, body: { assigneeId?: string | null; status?: "open" | "resolved" }) =>
    request<{ ok: true }>("PATCH", `/api/shared/${id}`, body),

  // Agents: the Review queue, activity, tokens, webhooks and remote access.
  approvals: (status: "pending" | "decided", signal?: AbortSignal) => get<{ approvals: Approval[] }>(`/api/v1/approvals${qs({ status })}`, signal),
  approve: (id: string) => post<ExecuteResult>(`/api/v1/approvals/${encodeURIComponent(id)}/approve`),
  reject: (id: string) => post<{ ok: true }>(`/api/v1/approvals/${encodeURIComponent(id)}/reject`),
  activity: (p: { limit?: number; agentId?: string; threadId?: string }, signal?: AbortSignal) =>
    get<{ activity: ActivityItem[] }>(`/api/v1/activity${qs({ limit: p.limit, agentId: p.agentId, threadId: p.threadId })}`, signal),
  undoActivity: (id: string) => post<{ threadIds: string[] }>(`/api/v1/activity/${encodeURIComponent(id)}/undo`),
  agents: () => get<{ agents: AgentInfo[] }>("/api/agents"),
  createAgent: (body: AgentInput) => post<{ agent: AgentInfo; token: string }>("/api/agents", body),
  updateAgent: (id: string, body: Partial<AgentInput>) => patch<{ agent: AgentInfo }>(`/api/agents/${encodeURIComponent(id)}`, body),
  revokeAgent: (id: string) => del<{ ok: true }>(`/api/agents/${encodeURIComponent(id)}`),
  webhooks: () => get<{ webhooks: Webhook[]; events: string[] }>("/api/webhooks"),
  createWebhook: (url: string, events: string[]) => post<{ id: string; secret: string }>("/api/webhooks", { url, events }),
  testWebhook: (id: string) => post<{ status: number }>(`/api/webhooks/${encodeURIComponent(id)}/test`),
  deleteWebhook: (id: string) => del<{ ok: true }>(`/api/webhooks/${encodeURIComponent(id)}`),
  remote: () => get<RemoteStatus>("/api/remote"),
  setRemote: (mode: RemoteMode) => post<RemoteStatus>("/api/remote/tailscale", { mode }),

  // The cloud agent: Claude on Anthropic's Managed Agents, answered through Slipstream's own commands.
  cloud: () => get<CloudStatus>("/api/cloud"),
  cloudConnect: (body: CloudConnectInput) => post<CloudStatus>("/api/cloud/connect", body),
  cloudDisconnect: () => post<CloudStatus>("/api/cloud/disconnect"),
  cloudRuns: () => get<{ runs: CloudRun[] }>("/api/cloud/runs"),
  cloudRun: (id: string, signal?: AbortSignal) => get<CloudRun>(`/api/cloud/runs/${encodeURIComponent(id)}`, signal),
  startRun: (instruction: string, context?: { threadIds: string[] }, engine?: EngineId | null) =>
    post<CloudRun>("/api/cloud/runs", { instruction, ...(context ? { context } : {}), ...(engine ? { engine } : {}) }),
  replyRun: (id: string, text: string) => post<CloudRun>(`/api/cloud/runs/${encodeURIComponent(id)}/messages`, { text }),
  stopRun: (id: string) => post<CloudRun>(`/api/cloud/runs/${encodeURIComponent(id)}/stop`),
  saveRoutine: (body: RoutineInput, id?: string) => (id ? put<Routine>(`/api/cloud/routines/${encodeURIComponent(id)}`, body) : post<Routine>("/api/cloud/routines", body)),
  deleteRoutine: (id: string) => del<{ ok: true }>(`/api/cloud/routines/${encodeURIComponent(id)}`),
  runRoutine: (id: string) => post<CloudRun>(`/api/cloud/routines/${encodeURIComponent(id)}/run`),

  // Models & accounts: which engines can run agents, and the keys, sign-ins, models and budgets behind them.
  engines: () => get<EnginesOverview>("/api/engines"),
  setDefaultEngine: (engine: EngineId) => put<EnginesOverview>("/api/engines/default", { engine }),
  setEngineModel: (id: EngineId, model: string | null) => put<EnginesOverview>(`/api/engines/${encodeURIComponent(id)}/model`, { model }),
  saveEngineKey: (provider: KeyProvider, apiKey: string) => put<EnginesOverview>(`/api/engines/keys/${provider}`, { apiKey }),
  removeEngineKey: (provider: KeyProvider) => del<EnginesOverview>(`/api/engines/keys/${provider}`),
  saveBudgets: (b: { runBudgetCents?: number; monthlyBudgetCents?: number }) => put<EnginesOverview>("/api/engines/budgets", b),
  chatgptSignIn: () => post<ChatGPTSignIn>("/api/engines/chatgpt/signin"),
  chatgptComplete: (url: string) => post<EnginesOverview>("/api/engines/chatgpt/complete", { url }),
  chatgptSignOut: () => post<EnginesOverview & { revoked: boolean }>("/api/engines/chatgpt/signout"),

  // Autopilot: new mail sorted as it arrives. Every write answers with the fresh overview.
  autopilot: (signal?: AbortSignal) => get<AutopilotOverview>("/api/autopilot", signal),
  updateAutopilot: (patch: AutopilotPatch) => put<AutopilotOverview>("/api/autopilot", patch),
  autopilotBackfill: (days: number) => post<AutopilotOverview>("/api/autopilot/backfill", { days }),
  autopilotRun: () => post<AutopilotOverview>("/api/autopilot/run"),
  autopilotLearnVoice: () => post<CloudRun>("/api/autopilot/voice"),
  autopilotAccept: (id: string) => post<AutopilotOverview>(`/api/autopilot/items/${encodeURIComponent(id)}/accept`),
  autopilotDismiss: (id: string) => post<AutopilotOverview>(`/api/autopilot/items/${encodeURIComponent(id)}/dismiss`),
  autopilotUndo: (id: string) => post<AutopilotOverview>(`/api/autopilot/items/${encodeURIComponent(id)}/undo`),
  autopilotAcceptAll: () => post<AutopilotOverview & { accepted: number }>("/api/autopilot/accept-all"),
  saveSenderRule: (pattern: string, action: SenderRuleAction) => post<AutopilotOverview>("/api/autopilot/senders", { pattern, action }),
  deleteSenderRule: (id: string) => del<AutopilotOverview>(`/api/autopilot/senders/${encodeURIComponent(id)}`),

  // Commands, called the way an agent would (people use the same registry).
  command,
  labels: () => command<LabelInfo[]>("labels.list").then((r) => r.result),
  labelRules: () => command<LabelRule[]>("labelRules.list").then((r) => r.result),
};

export interface DraftInput {
  accountId: string;
  /** One of the account's identities; leave out to keep the draft's current address (new drafts use the account's own). */
  fromEmail?: string | null;
  threadId?: string | null;
  replyToMessageId?: string | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  bodyHtml: string;
}

/** What Settings sends to add or change a send-as address. Names default to the account's; signatures are sanitized by the server. */
export interface IdentityInput {
  email: string;
  name?: string;
  replyTo?: string | null;
  signatureHtml?: string | null;
}

export interface SnippetInput {
  name: string;
  subject?: string | null;
  bodyHtml: string;
  shared: boolean;
}

import { api, type DraftInput } from "../api.ts";
import { buildSeed, dedupe, fillSnippet, newBody, type ComposeKind } from "../lib/compose.ts";
import { firstName } from "../lib/format.ts";
import { formatWhen } from "../lib/when.ts";
import type { Address, Draft, DraftAttachment, Snippet, ThreadDetail } from "../types.ts";
import { createStore, useStore } from "./createStore.ts";
import { removeLocally, undo as undoTriage } from "./actions.ts";
import { reload } from "./list.ts";
import { getRoute, navigate } from "./route.ts";
import { myEmails, session } from "./session.ts";
import { cachedThread, loadThread } from "./threads.ts";
import { settleSending, toast } from "./toasts.ts";
import { openRemind } from "./ui.ts";

export interface ComposeState {
  open: boolean;
  /** dock: bottom-right panel. modal: centred and larger. */
  mode: "dock" | "modal";
  /** A reply started in a conversation docks at the bottom of that conversation. */
  inline: boolean;
  kind: ComposeKind;
  draftId: string | null;
  accountId: string;
  threadId: string | null;
  replyToMessageId: string | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  showCc: boolean;
  showBcc: boolean;
  subject: string;
  /** What the editor is initialised with when it mounts. */
  initialBody: string;
  bodyHtml: string;
  attachments: DraftAttachment[];
  dirty: boolean;
  save: "idle" | "saving" | "saved" | "error";
  followUpDays: number | null;
  sending: boolean;
  /** Bumped to force the editor to start over with `initialBody`. */
  editorKey: number;
}

const empty: ComposeState = {
  open: false,
  mode: "dock",
  inline: false,
  kind: "new",
  draftId: null,
  accountId: "",
  threadId: null,
  replyToMessageId: null,
  to: [],
  cc: [],
  bcc: [],
  showCc: false,
  showBcc: false,
  subject: "",
  initialBody: "",
  bodyHtml: "",
  attachments: [],
  dirty: false,
  save: "idle",
  followUpDays: null,
  sending: false,
  editorKey: 0,
};

export const compose = createStore<ComposeState>(empty);
export const useCompose = <S,>(selector: (s: ComposeState) => S) => useStore(compose, selector);

/** The editor registers itself so commands (snippets, intros) can write into it. */
export interface EditorHandle {
  insertHtml(html: string, replaceRange?: Range): void;
  focus(): void;
  prependHtml(html: string): void;
}
let editor: EditorHandle | null = null;
export const registerEditor = (e: EditorHandle | null) => {
  editor = e;
};
export const getEditor = () => editor;

function defaultAccount(): string {
  const s = session.get();
  return s.accountFilter ?? s.accounts[0]?.id ?? "";
}

let editorKeyCounter = 1;

function start(patch: Partial<ComposeState>) {
  compose.set({ ...empty, open: true, editorKey: editorKeyCounter++, bodyHtml: patch.initialBody ?? "", ...patch });
}

export function startNew(seed: { to?: Address[]; subject?: string } = {}) {
  if (compose.get().open) {
    focusCompose();
    return;
  }
  if (session.get().accounts.length === 0) {
    toast.action("Connect an account before writing a message", "Add account", () => navigate("/settings/accounts"));
    return;
  }
  const signature = session.get().settings.signature;
  const body = newBody(signature);
  start({ kind: "new", accountId: defaultAccount(), to: seed.to ?? [], subject: seed.subject ?? "", initialBody: body });
}

export function startReply(detail: ThreadDetail, kind: Exclude<ComposeKind, "new">, inline: boolean) {
  const st = compose.get();
  if (st.open && st.threadId === detail.thread.id && st.kind === kind) {
    focusCompose();
    return;
  }
  if (st.open) void closeCompose();
  const seed = buildSeed(detail, kind, myEmails(), session.get().settings.signature);
  start({
    kind,
    inline,
    accountId: detail.thread.accountId,
    threadId: detail.thread.id,
    replyToMessageId: seed.replyToMessageId,
    to: seed.to,
    cc: seed.cc,
    showCc: seed.cc.length > 0,
    subject: seed.subject,
    initialBody: seed.bodyHtml,
  });
}

export async function openDraft(id: string) {
  try {
    const d = await api.draft(id);
    openDraftObject(d);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Couldn't open that draft");
  }
}

export function openDraftObject(d: Draft) {
  const route = getRoute();
  start({
    kind: d.threadId ? "reply" : "new",
    inline: Boolean(d.threadId) && route.name === "thread" && route.id === d.threadId,
    draftId: d.id,
    accountId: d.accountId,
    threadId: d.threadId,
    replyToMessageId: d.replyToMessageId,
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    showCc: d.cc.length > 0,
    showBcc: d.bcc.length > 0,
    subject: d.subject,
    initialBody: d.bodyHtml,
    attachments: d.attachments,
    save: "saved",
  });
}

export function focusCompose() {
  document.querySelector<HTMLElement>("[data-compose-focus]")?.focus();
}

// ---- Saving -----------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | undefined;
let chain: Promise<unknown> = Promise.resolve();
let creating: Promise<string> | null = null;

function snapshot(): DraftInput {
  const s = compose.get();
  return {
    accountId: s.accountId,
    threadId: s.threadId,
    replyToMessageId: s.replyToMessageId,
    to: s.to,
    cc: s.cc,
    bcc: s.bcc,
    subject: s.subject,
    bodyHtml: s.bodyHtml,
  };
}

async function ensureDraft(): Promise<string> {
  const s = compose.get();
  if (s.draftId) return s.draftId;
  if (!s.accountId) throw new Error("Connect an account before writing a message");
  creating ??= api
    .createDraft(snapshot())
    .then((d) => {
      compose.set({ draftId: d.id, save: "saved" });
      return d.id;
    })
    .finally(() => {
      creating = null;
    });
  return creating;
}

function runSave(): Promise<void> {
  chain = chain
    .catch(() => undefined)
    .then(async () => {
      const s = compose.get();
      if (!s.open || !s.dirty) return;
      compose.set({ save: "saving" });
      try {
        if (!s.draftId) await ensureDraft();
        else await api.saveDraft(s.draftId, snapshot());
        // Edits that landed while this request was in flight keep the draft dirty.
        const now = compose.get();
        const same = now.bodyHtml === s.bodyHtml && now.subject === s.subject && now.to === s.to && now.cc === s.cc && now.bcc === s.bcc;
        compose.set({ save: "saved", dirty: !same });
        if (!same) scheduleSave();
      } catch (err) {
        compose.set({ save: "error" });
        throw err;
      }
    });
  return chain as Promise<void>;
}

function scheduleSave() {
  clearTimeout(timer);
  const s = compose.get();
  if (!s.draftId) {
    // First keystroke: make the draft now, then save changes after a pause.
    void runSave().catch(() => undefined);
    return;
  }
  timer = setTimeout(() => void runSave().catch(() => undefined), 700);
}

export function edit(patch: Partial<Pick<ComposeState, "to" | "cc" | "bcc" | "subject" | "bodyHtml" | "accountId" | "showCc" | "showBcc" | "followUpDays">>) {
  const persists = Object.keys(patch).some((k) => !["showCc", "showBcc", "followUpDays"].includes(k));
  compose.set({ ...patch, ...(persists ? { dirty: true } : {}) });
  if (persists) scheduleSave();
}

export async function flushDraft(): Promise<void> {
  clearTimeout(timer);
  if (compose.get().dirty) await runSave();
}

// ---- Closing, discarding, attachments -------------------------------------

export async function closeCompose() {
  const s = compose.get();
  if (!s.open) return;
  try {
    await flushDraft();
  } catch {
    toast.error("Couldn't save your draft");
  }
  const after = compose.get();
  compose.set({ ...empty, editorKey: after.editorKey });
  if (after.draftId) toast.info("Draft saved");
}

export async function discardDraft() {
  const s = compose.get();
  clearTimeout(timer);
  compose.set({ ...empty, editorKey: s.editorKey });
  if (s.draftId) {
    try {
      await api.deleteDraft(s.draftId);
      toast.info("Draft discarded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't discard the draft");
    }
  }
}

export async function attachFiles(files: File[]) {
  if (files.length === 0) return;
  try {
    const id = await ensureDraft();
    if (compose.get().dirty) await flushDraft();
    const d = await api.attachToDraft(id, files);
    compose.set({ attachments: d.attachments });
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Couldn't attach that file");
  }
}

export async function removeAttachment(id: string) {
  const draftId = compose.get().draftId;
  if (!draftId) return;
  try {
    const d = await api.removeDraftAttachment(draftId, id);
    compose.set({ attachments: d.attachments });
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Couldn't remove that file");
  }
}

// ---- Sending ----------------------------------------------------------------

export interface SendOptions {
  instant?: boolean;
  sendAt?: number;
  markDone?: boolean;
}

let pendingSend: { draftId: string } | null = null;

export async function sendCompose(opts: SendOptions = {}) {
  const s = compose.get();
  if (!s.open || s.sending) return;
  if (s.to.length + s.cc.length + s.bcc.length === 0) {
    toast.error("Add at least one recipient");
    document.querySelector<HTMLElement>("[data-recipient-input]")?.focus();
    return;
  }
  compose.set({ sending: true });
  try {
    compose.set({ dirty: true });
    const id = await ensureDraft();
    await flushDraft();
    const res = await api.sendDraft(id, {
      sendAt: opts.sendAt,
      instant: opts.instant,
      followUpDays: s.followUpDays ?? undefined,
      markDone: opts.markDone && Boolean(s.threadId),
    });
    const closing = compose.get();
    compose.set({ ...empty, editorKey: closing.editorKey });
    pendingSend = { draftId: id };

    if (opts.markDone && s.threadId) {
      removeLocally([s.threadId]);
      reload(true);
    }
    const cancel = () => void cancelSend(id, res.undoToken, s.threadId ? [s.threadId] : []);
    const delay = res.sendAt - Date.now();
    if (opts.sendAt && delay > 15_000) toast.undoable(`Scheduled · ${formatWhen(new Date(res.sendAt))}`, cancel, 10_000);
    else if (opts.instant) toast.info("Sending…");
    else toast.sending("Sending…", res.sendAt, cancel);
  } catch (err) {
    compose.set({ sending: false });
    toast.error(err instanceof Error ? err.message : "That message didn't send");
  }
}

async function cancelSend(draftId: string, undoToken: string | null, threadIds: string[]) {
  try {
    const d = await api.cancelDraft(draftId);
    pendingSend = null;
    if (undoToken) await undoTriage(undoToken, threadIds);
    if (!compose.get().open) openDraftObject(d);
    toast.info("Back to your draft");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Too late. That message already left.");
  }
}

/** Server events about drafts: sent, failed. */
export function onDraftEvent(e: { draftId: string; status: string; error?: string | null }) {
  if (!pendingSend || pendingSend.draftId !== e.draftId) return;
  if (e.status === "sent") {
    pendingSend = null;
    settleSending("Sent");
    reload();
  } else if (e.status === "failed") {
    pendingSend = null;
    settleSending(e.error ? `Couldn't send: ${e.error}` : "Couldn't send that message", "error");
  }
}

export function sendLater() {
  const s = compose.get();
  if (!s.open) return;
  openRemind({ title: "Send later", onPick: (at) => void sendCompose({ sendAt: at.getTime() }) });
}

// ---- Snippets, intros ------------------------------------------------------------

export function insertSnippet(snippet: Snippet, replaceRange?: Range) {
  const s = compose.get();
  const html = fillSnippet(snippet.bodyHtml, s.to[0]);
  editor?.insertHtml(html, replaceRange);
  if (snippet.subject && !s.subject.trim()) edit({ subject: fillSnippet(snippet.subject, s.to[0]).replace(/<[^>]+>/g, "") });
  void api.snippetUsed(snippet.id).catch(() => undefined);
}

/** Instant Intro: the introducer moves to Bcc and the thanks goes in the body. */
export async function instantIntro() {
  const s = compose.get();
  if (!s.open || !s.threadId) {
    toast.info("Instant Intro works in a reply to an introduction");
    return;
  }
  await loadThread(s.threadId);
  const detail = cachedThread(s.threadId);
  if (!detail) return;
  const mine = myEmails();
  const target = detail.messages.filter((m) => !mine.has(m.from.email.toLowerCase())).at(-1);
  if (!target) return;
  const intro = target.from;
  const everyone = dedupe([...s.to, ...target.to, ...s.cc, ...target.cc], new Set([...mine, intro.email.toLowerCase()]));
  const bcc = dedupe([...s.bcc, intro], mine);
  edit({ to: everyone, cc: [], bcc, showBcc: true, showCc: false });
  const text = session.get().settings.instantIntro.replace(/\{first_name\}/g, firstName(intro));
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  editor?.prependHtml(`<div>${safe}</div>`);
}

// ---- Commands that need the composer UI (link prompt, pickers, file chooser) -----------

export const composeBus = new EventTarget();
export const emitCompose = (name: "link" | "snippets" | "attach" | "from") => composeBus.dispatchEvent(new CustomEvent("compose", { detail: name }));

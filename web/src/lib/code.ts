import { api, ApiError } from "../api.ts";
import { list } from "../store/list.ts";
import { getRoute } from "../store/route.ts";
import { session } from "../store/session.ts";
import { cachedThread } from "../store/threads.ts";
import { toast } from "../store/toasts.ts";
import type { Message } from "../types.ts";
import { copyPending } from "./clipboard.ts";
import { codeFreshFor } from "./signals.ts";

/** Copy a one-time code the server reads out of the message when asked. Resolves to whether it ended up on the clipboard. */
export async function copyCode(load: () => Promise<{ code: string }>): Promise<boolean> {
  try {
    const ok = await copyPending(load().then((r) => r.code));
    if (!ok) toast.error("Couldn't copy to the clipboard", 3500);
    return ok;
  } catch (err) {
    toast.error(err instanceof ApiError && err.status === 404 ? "That code isn't in the message anymore" : err instanceof Error ? err.message : "Couldn't read the code", 3500);
    return false;
  }
}

/** The newest incoming message in an open conversation that carries a code. */
export function codeMessage(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!m.outgoing && m.signals.some((s) => s.kind === "code")) return m;
  }
  return null;
}

type Target = { kind: "thread" | "message"; id: string };

/** What Shift+C would copy right now: the code in the open conversation, or the focused row's code while it's fresh. */
export function codeTarget(): Target | null {
  if (!session.get().settings.helpers.codes) return null;
  const route = getRoute();
  if (route.name === "thread") {
    const m = codeMessage(cachedThread(route.id)?.messages ?? []);
    return m ? { kind: "message", id: m.id } : null;
  }
  if (route.name !== "mail") return null;
  const s = list.get();
  const t = s.visible.find((x) => x.id === s.focusedId);
  return t && t.signal === "code" && codeFreshFor(t.signalAt) > 0 ? { kind: "thread", id: t.id } : null;
}

export async function copyFocusedCode(): Promise<void> {
  const target = codeTarget();
  if (!target) return;
  const ok = await copyCode(() => (target.kind === "message" ? api.messageCode(target.id) : api.threadCode(target.id)));
  if (ok) toast.info("Code copied", 2000);
}

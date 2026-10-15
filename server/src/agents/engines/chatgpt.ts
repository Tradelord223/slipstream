import { responsesAdapter, type ResponsesState } from "./adapters/openai-responses.ts";
import type { EngineAccounts } from "./accounts.ts";
import type { ChatGPTAuth } from "./chatgpt-auth.ts";
import { EngineError, runLoop, type ModelAdapter } from "./loop.ts";
import type { Engine, EngineStatus } from "./types.ts";

/**
 * ChatGPT: agents run on the person's ChatGPT Plus or Pro plan through OpenAI's open-source
 * "Sign in with ChatGPT" flow. Same Responses API as an OpenAI key, in its ChatGPT mode.
 */

const PREFER = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
const FALLBACK = "gpt-6.1-sol";
const MODELS_TTL_MS = 10 * 60_000;

const base = () => (process.env.SLIPSTREAM_OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");

export function chatgptEngine(auth: ChatGPTAuth, accounts: EngineAccounts): Engine {
  const cache = new Map<string, { at: number; models: string[] | null }>();

  async function models(userId: string): Promise<string[] | null> {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < MODELS_TTL_MS) return hit.models;
    let list: string[] | null = null;
    try {
      const res = await fetch(`${base()}/models`, { headers: { authorization: `Bearer ${await auth.accessToken(userId)}` }, signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        const body = (await res.json()) as { data?: { id?: string; slug?: string; visibility?: string }[] };
        list = (body.data ?? []).filter((m) => !m.visibility || m.visibility === "list").map((m) => m.slug ?? m.id ?? "").filter(Boolean);
      }
    } catch {
      list = null;
    }
    cache.set(userId, { at: Date.now(), models: list?.length ? list : null });
    return list?.length ? list : null;
  }

  async function defaultModel(userId: string): Promise<string> {
    const saved = accounts.model(userId, "loop:chatgpt");
    if (saved) return saved;
    const list = await models(userId);
    return PREFER.find((m) => list?.includes(m)) ?? list?.[0] ?? FALLBACK;
  }

  return {
    id: "loop:chatgpt",
    label: "ChatGPT",
    kind: "loop",
    async status(userId) {
      const s = auth.status(userId);
      const common = {
        id: "loop:chatgpt",
        label: "ChatGPT",
        kind: "loop",
        billing: "plan",
        note: "Uses your ChatGPT plan's allowance. Choose how much Slipstream may use in ChatGPT Settings → Usage. Sign in with ChatGPT is a preview from OpenAI.",
      } as const;
      if (!s.signedIn)
        return {
          ...common,
          ready: false,
          needs: "signin",
          pending: s.pending,
          detail: s.pending ? "Finish signing in in your browser" : (s.lastError ?? "Sign in with your ChatGPT Plus or Pro plan"),
        } satisfies EngineStatus;
      const list = await models(userId);
      return {
        ...common,
        ready: true,
        detail: `Signed in${s.email ? ` as ${s.email}` : ""}${s.plan ? ` (${s.plan})` : ""}`,
        account: { email: s.email, plan: s.plan },
        ...(list ? { models: list } : {}),
        model: await defaultModel(userId),
      } satisfies EngineStatus;
    },
    async turn(io, message) {
      const model = io.model ?? (await defaultModel(io.userId));
      let lastToken = "";
      const inner = responsesAdapter({
        baseUrl: base(),
        token: async () => (lastToken = await auth.accessToken(io.userId)),
        model,
        chatgpt: true,
      });
      // A token can be revoked or rotated mid-run: refresh once and retry the step.
      const adapter: ModelAdapter<ResponsesState> = {
        ...inner,
        async step(state, runIo) {
          try {
            return await inner.step(state, runIo);
          } catch (err) {
            if (!(err instanceof EngineError && err.kind === "auth")) throw err;
            await auth.refreshNow(io.userId, lastToken);
            return inner.step(state, runIo);
          }
        },
      };
      return runLoop(io, adapter, message);
    },
  };
}

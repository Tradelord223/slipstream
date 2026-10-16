import { EventEmitter } from "node:events";

export type ServerEvent =
  | { type: "threads"; accountId: string; threadIds: string[] }
  /** `fetched`: messages stored so far in this sync run, sent with each page while syncing. */
  | {
      type: "sync";
      accountId: string;
      status: string;
      error?: string | null;
      fetched?: number;
      /** Exact progress of the current stage (see web/src/types.ts SyncProgress). */
      progress?: { stage: "signin" | "inbox" | "recent" | "history" | "done"; done: number; total: number | null };
    }
  | { type: "drafts"; draftId: string; status: string; error?: string | null }
  | { type: "team"; workspaceId: string; sharedThreadId: string }
  | { type: "activity"; activityId: string }
  | { type: "cloud"; runId: string }
  | { type: "autopilot" }
  | { type: "approval"; approvalId: string; status: string }
  | { type: "import"; jobId: string; accountId: string; status: "running" | "done" | "failed"; imported: number; error?: string };

/** In-process pub/sub. Events are scoped per user; the SSE route filters by subscriber. */
export class Events {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emitToUser(userId: string, event: ServerEvent): void {
    this.emitter.emit(`user:${userId}`, event);
    this.emitter.emit("any-user", userId, event);
  }

  /** Every per-user event, for outbound webhooks. */
  onAnyUser(fn: (userId: string, e: ServerEvent) => void): () => void {
    this.emitter.on("any-user", fn);
    return () => this.emitter.off("any-user", fn);
  }

  emitToWorkspace(workspaceId: string, event: ServerEvent): void {
    this.emitter.emit(`ws:${workspaceId}`, event);
  }

  subscribe(channels: string[], fn: (e: ServerEvent) => void): () => void {
    for (const c of channels) this.emitter.on(c, fn);
    return () => {
      for (const c of channels) this.emitter.off(c, fn);
    };
  }
}

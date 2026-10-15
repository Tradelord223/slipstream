import { EventEmitter } from "node:events";

export type ServerEvent =
  | { type: "threads"; accountId: string; threadIds: string[] }
  | { type: "sync"; accountId: string; status: string; error?: string | null }
  | { type: "drafts"; draftId: string; status: string; error?: string | null }
  | { type: "team"; workspaceId: string; sharedThreadId: string }
  | { type: "import"; jobId: string; accountId: string; status: "running" | "done" | "failed"; imported: number; error?: string };

/** In-process pub/sub. Events are scoped per user; the SSE route filters by subscriber. */
export class Events {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emitToUser(userId: string, event: ServerEvent): void {
    this.emitter.emit(`user:${userId}`, event);
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

import type { Config } from "../config.ts";
import type { MailProvider, ProviderContext, RemoteAction, SyncPage } from "../mail/types.ts";

/** Placeholder until the outlook connector lands. */
export class GraphProvider implements MailProvider {
  readonly kind = "outlook" as const;

  private ctx: ProviderContext;
  private config?: Config;

  constructor(ctx: ProviderContext, config?: Config) {
    this.ctx = ctx;
    this.config = config;
  }

  async sync(_cursor: string | null): Promise<SyncPage> {
    throw new Error("outlook sync is not implemented yet");
  }

  async apply(_action: RemoteAction): Promise<void> {
    throw new Error("outlook actions are not implemented yet");
  }
}

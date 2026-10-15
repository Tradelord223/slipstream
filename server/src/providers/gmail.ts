import type { Config } from "../config.ts";
import type { MailProvider, ProviderContext, RemoteAction, SyncPage } from "../mail/types.ts";

/** Placeholder until the gmail connector lands. */
export class GmailProvider implements MailProvider {
  readonly kind = "gmail" as const;

  private ctx: ProviderContext;
  private config?: Config;

  constructor(ctx: ProviderContext, config?: Config) {
    this.ctx = ctx;
    this.config = config;
  }

  async sync(_cursor: string | null): Promise<SyncPage> {
    throw new Error("gmail sync is not implemented yet");
  }

  async apply(_action: RemoteAction): Promise<void> {
    throw new Error("gmail actions are not implemented yet");
  }
}

import type { Config } from "../config.ts";
import type { MailProvider, ProviderContext, RemoteAction, SyncPage } from "../mail/types.ts";

/** Placeholder until the imap connector lands. */
export class ImapProvider implements MailProvider {
  readonly kind = "imap" as const;

  private ctx: ProviderContext;
  private config?: Config;

  constructor(ctx: ProviderContext, config?: Config) {
    this.ctx = ctx;
    this.config = config;
  }

  async sync(_cursor: string | null): Promise<SyncPage> {
    throw new Error("imap sync is not implemented yet");
  }

  async apply(_action: RemoteAction): Promise<void> {
    throw new Error("imap actions are not implemented yet");
  }
}

export interface ImapSettings {
  username: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

export const IMAP_PRESETS: Record<string, Omit<ImapSettings, "username" | "password"> & { label: string; help: string }> = {};

export async function verifyImap(_settings: ImapSettings): Promise<void> {
  throw new Error("IMAP is not implemented yet");
}

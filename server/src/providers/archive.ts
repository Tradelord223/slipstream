import type { MailProvider, SyncPage } from "../mail/types.ts";

/**
 * Mail imported from files (mbox, eml). It lives only in Slipstream: nothing to sync,
 * triage is local, and it can't send.
 */
export class ArchiveProvider implements MailProvider {
  readonly kind = "archive" as const;

  async sync(): Promise<SyncPage> {
    return { messages: [], cursor: "archive", done: true };
  }

  async apply(action: { kind: string }): Promise<void> {
    if (action.kind === "send") throw new Error("Imported archives can't send mail. Pick another From address.");
  }
}

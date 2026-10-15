import type { Config } from "../config.ts";
import type { MailProvider, ProviderContext, ProviderKind } from "../mail/types.ts";
import { ArchiveProvider } from "./archive.ts";
import { DemoProvider } from "./demo.ts";
import { GmailProvider } from "./gmail.ts";
import { GraphProvider } from "./graph.ts";
import { ImapProvider } from "./imap.ts";

export type ProviderFactory = (ctx: ProviderContext, config: Config) => MailProvider;

const factories: Record<ProviderKind, ProviderFactory> = {
  demo: (ctx) => new DemoProvider(ctx),
  archive: () => new ArchiveProvider(),
  gmail: (ctx, config) => new GmailProvider(ctx, config),
  outlook: (ctx, config) => new GraphProvider(ctx, config),
  imap: (ctx) => new ImapProvider(ctx),
};

export function createProvider(kind: ProviderKind, ctx: ProviderContext, config: Config): MailProvider {
  const f = factories[kind];
  if (!f) throw new Error(`No provider for ${kind}`);
  return f(ctx, config);
}

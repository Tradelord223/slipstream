import type { Config } from "./config.ts";
import type { Db } from "./db/index.ts";
import type { Events } from "./events.ts";
import type { SecretBox } from "./lib/crypto.ts";
import type { Triage } from "./mail/actions.ts";
import type { MailStore } from "./mail/store.ts";
import type { SyncEngine } from "./mail/sync.ts";
import type { Users, User } from "./auth/users.ts";
import type { Agents } from "./agents/agents.ts";
import type { Commands } from "./commands/service.ts";
import type { Webhooks } from "./agents/webhooks.ts";
import type { CloudAgent } from "./agents/cloud.ts";
import type { Autopilot } from "./agents/autopilot.ts";
import type { SenderLogos } from "./mail/logos.ts";
import type { Resorter } from "./mail/resort.ts";
import type { Actor } from "./commands/registry.ts";

/** A mail-file import that is running now, so a reloaded client can tell the account is still filling. */
export interface ImportProgress {
  accountId: string;
  imported: number;
}

/** Where an account's imports stand: filling while any of its jobs runs, with the messages stored so far across them. */
export function importStatus(imports: AppContext["imports"], accountId: string): { importing: boolean; imported: number } {
  let importing = false;
  let imported = 0;
  for (const job of imports.values()) {
    if (job.accountId !== accountId) continue;
    importing = true;
    imported += job.imported;
  }
  return { importing, imported };
}

/** Everything a request handler might need, built once at boot. */
export interface AppContext {
  config: Config;
  db: Db;
  store: MailStore;
  triage: Triage;
  sync: SyncEngine;
  events: Events;
  users: Users;
  secrets: SecretBox;
  agents: Agents;
  commands: Commands;
  webhooks: Webhooks;
  cloud: CloudAgent;
  autopilot: Autopilot;
  logos: SenderLogos;
  /** The one-time re-sort of mail stored before 0.5.0. */
  resort: Resorter;
  /** Running imports by job id (several can fill one account); an entry exists only while its job does. */
  imports: Map<string, ImportProgress>;
}

/** `actor` is the person, or the agent acting for them (bearer-token requests). */
export type Env = { Variables: { user: User; actor: Actor } };

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
import type { Actor } from "./commands/registry.ts";

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
}

/** `actor` is the person, or the agent acting for them (bearer-token requests). */
export type Env = { Variables: { user: User; actor: Actor } };

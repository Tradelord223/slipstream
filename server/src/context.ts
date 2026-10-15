import type { Config } from "./config.ts";
import type { Db } from "./db/index.ts";
import type { Events } from "./events.ts";
import type { SecretBox } from "./lib/crypto.ts";
import type { Triage } from "./mail/actions.ts";
import type { MailStore } from "./mail/store.ts";
import type { SyncEngine } from "./mail/sync.ts";
import type { Users, User } from "./auth/users.ts";

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
}

export type Env = { Variables: { user: User } };

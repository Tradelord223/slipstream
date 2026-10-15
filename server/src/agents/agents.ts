import { z } from "zod";
import type { Db } from "../db/index.ts";
import { newId, randomToken, sha256 } from "../lib/crypto.ts";

/**
 * Agents are principals, like people: each has a name, a token, scopes and an approval policy.
 * Tokens are shown once and stored hashed.
 */

export const SCOPES = ["read", "triage", "draft", "send", "settings"] as const;
export type Scope = (typeof SCOPES)[number];

export const policySchema = z.object({
  /** "always": every send waits for a person. "external": only sends outside the account's own domain wait. "never": sends go out (still with Undo Send). */
  send: z.enum(["always", "external", "never"]).default("always"),
  /** Trash or spam on more than this many conversations at once waits for approval. */
  bulkThreshold: z.number().int().min(1).max(10_000).default(10),
  /** Settings changes (splits, snippets) wait for approval. */
  settings: z.enum(["approve", "allow"]).default("approve"),
});
export type Policy = z.infer<typeof policySchema>;

export const TOKEN_PREFIX = "ss_agent_";
/** Short-lived OAuth access tokens (remote MCP clients); see remote/oauth.ts. */
export const OAUTH_ACCESS_PREFIX = "ss_oat_";

export interface Agent {
  id: string;
  userId: string;
  name: string;
  /** "oauth" agents were connected by a remote assistant (claude.ai, ChatGPT) and use short-lived tokens. */
  kind: "token" | "oauth";
  scopes: Scope[];
  policy: Policy;
  tokenHint: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface AgentRow {
  id: string;
  user_id: string;
  name: string;
  token_hint: string;
  scopes: string;
  policy: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  status: string;
  oauth_client_id: string | null;
}

const shape = (r: AgentRow): Agent => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  kind: r.oauth_client_id ? "oauth" : "token",
  scopes: JSON.parse(r.scopes) as Scope[],
  policy: policySchema.parse(JSON.parse(r.policy)),
  tokenHint: r.token_hint,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

export class Agents {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(userId: string, name: string, scopes: Scope[], policy: Partial<Policy> = {}): { agent: Agent; token: string } {
    const token = `${TOKEN_PREFIX}${randomToken(32)}`;
    const id = newId("agt");
    this.db.run(
      "INSERT INTO agents (id, user_id, name, token_hash, token_hint, scopes, policy, created_at) VALUES (?,?,?,?,?,?,?,?)",
      id,
      userId,
      name,
      sha256(token),
      token.slice(-4),
      JSON.stringify([...new Set(scopes)]),
      JSON.stringify(policySchema.parse(policy)),
      Date.now(),
    );
    return { agent: this.get(userId, id)!, token };
  }

  list(userId: string): Agent[] {
    return this.db
      .all<AgentRow>("SELECT * FROM agents WHERE user_id = ? AND revoked_at IS NULL AND status = 'active' ORDER BY created_at", userId)
      .map(shape);
  }

  get(userId: string, id: string): Agent | null {
    const r = this.db.get<AgentRow>("SELECT * FROM agents WHERE id = ? AND user_id = ? AND revoked_at IS NULL", id, userId);
    return r ? shape(r) : null;
  }

  update(userId: string, id: string, patch: { name?: string; scopes?: Scope[]; policy?: Partial<Policy> }): Agent | null {
    const current = this.get(userId, id);
    if (!current) return null;
    this.db.run(
      "UPDATE agents SET name = ?, scopes = ?, policy = ? WHERE id = ?",
      patch.name ?? current.name,
      JSON.stringify(patch.scopes ? [...new Set(patch.scopes)] : current.scopes),
      JSON.stringify(policySchema.parse({ ...current.policy, ...patch.policy })),
      id,
    );
    return this.get(userId, id);
  }

  revoke(userId: string, id: string): boolean {
    return this.db.run("UPDATE agents SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL", Date.now(), id, userId).changes > 0;
  }

  /** Resolve a bearer token (agent token or OAuth access token) to its active agent. One indexed lookup. */
  authenticate(token: string): Agent | null {
    let r: AgentRow | undefined;
    if (token.startsWith(TOKEN_PREFIX)) {
      r = this.db.get<AgentRow>("SELECT * FROM agents WHERE token_hash = ? AND revoked_at IS NULL AND status = 'active'", sha256(token));
    } else if (token.startsWith(OAUTH_ACCESS_PREFIX)) {
      r = this.db.get<AgentRow>(
        `SELECT a.* FROM oauth_tokens t JOIN agents a ON a.id = t.agent_id
         WHERE t.access_hash = ? AND t.revoked_at IS NULL AND t.access_expires_at > ? AND a.revoked_at IS NULL AND a.status = 'active'`,
        sha256(token),
        Date.now(),
      );
    }
    if (!r) return null;
    // Coarse last-used tracking (one write a minute at most).
    if (!r.last_used_at || Date.now() - r.last_used_at > 60_000) this.db.run("UPDATE agents SET last_used_at = ? WHERE id = ?", Date.now(), r.id);
    return shape(r);
  }
}

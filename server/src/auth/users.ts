import type { Db } from "../db/index.ts";
import { hashPassword, newId, randomToken, sha256, verifyPassword } from "../lib/crypto.ts";

export const LOCAL_USER_ID = "usr_local";
const SESSION_DAYS = 30;

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Workspace {
  id: string;
  name: string;
  role: "owner" | "member";
}

/** The built-in tabs: name, search, hide when empty. Forums shows only while it holds mail; every tab can be renamed, hidden or reordered, none deleted. */
const DEFAULT_SPLITS: [string, string, boolean][] = [
  ["Important", "category:people", false],
  ["Updates", "category:updates", false],
  ["Promotions", "category:promotions", false],
  ["Social", "category:social", false],
  ["Forums", "category:forums", true],
];

export class Users {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Local mode: one implicit owner, no password. */
  ensureLocalUser(): User {
    const existing = this.db.get<User>("SELECT id, email, name FROM users WHERE id = ?", LOCAL_USER_ID);
    if (existing) return existing;
    this.db.tx(() => {
      this.db.run(
        "INSERT INTO users (id, email, name, created_at) VALUES (?,?,?,?)",
        LOCAL_USER_ID,
        "you@localhost",
        "You",
        Date.now(),
      );
      this.seedSplits(LOCAL_USER_ID);
    });
    return this.db.get<User>("SELECT id, email, name FROM users WHERE id = ?", LOCAL_USER_ID)!;
  }

  count(): number {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM users")!.n;
  }

  async create(email: string, name: string, password: string): Promise<User> {
    if (password.length < 10) throw new HttpError(400, "Use at least 10 characters for your password.");
    if (this.db.get("SELECT 1 AS x FROM users WHERE email = ?", email)) throw new HttpError(409, "That email already has an account.");
    const id = newId("usr");
    const hash = await hashPassword(password);
    this.db.tx(() => {
      this.db.run(
        "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)",
        id,
        email.trim().toLowerCase(),
        name.trim(),
        hash,
        Date.now(),
      );
      this.seedSplits(id);
    });
    return { id, email: email.trim().toLowerCase(), name: name.trim() };
  }

  async verify(email: string, password: string): Promise<User | null> {
    const row = this.db.get<User & { password_hash: string | null }>(
      "SELECT id, email, name, password_hash FROM users WHERE email = ?",
      email.trim(),
    );
    // Compare against a dummy hash when the user doesn't exist so timing doesn't reveal accounts.
    const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
    return row?.password_hash && ok ? { id: row.id, email: row.email, name: row.name } : null;
  }

  createSession(userId: string): string {
    const token = randomToken(32);
    this.db.run(
      "INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)",
      sha256(token),
      userId,
      Date.now() + SESSION_DAYS * 86_400_000,
      Date.now(),
    );
    return token;
  }

  userForSession(token: string | undefined): User | null {
    if (!token) return null;
    return (
      this.db.get<User>(
        `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id_hash = ? AND s.expires_at > ?`,
        sha256(token),
        Date.now(),
      ) ?? null
    );
  }

  destroySession(token: string): void {
    this.db.run("DELETE FROM sessions WHERE id_hash = ?", sha256(token));
  }

  get(userId: string): User | null {
    return this.db.get<User>("SELECT id, email, name FROM users WHERE id = ?", userId) ?? null;
  }

  workspaceOf(userId: string): Workspace | null {
    return (
      this.db.get<Workspace>(
        `SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = ? ORDER BY m.created_at LIMIT 1`,
        userId,
      ) ?? null
    );
  }

  createWorkspace(ownerId: string, name: string): Workspace {
    const id = newId("ws");
    this.db.tx(() => {
      this.db.run("INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)", id, name, Date.now());
      this.db.run(
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)",
        id,
        ownerId,
        "owner",
        Date.now(),
      );
    });
    return { id, name, role: "owner" };
  }

  createInvite(workspaceId: string, createdBy: string, email: string | null): string {
    const token = randomToken(24);
    this.db.run(
      "INSERT INTO invites (token_hash, workspace_id, email, created_by, expires_at) VALUES (?,?,?,?,?)",
      sha256(token),
      workspaceId,
      email,
      createdBy,
      Date.now() + 14 * 86_400_000,
    );
    return token;
  }

  inviteInfo(token: string): { workspace_id: string; workspace_name: string; email: string | null } | null {
    return (
      this.db.get<{ workspace_id: string; workspace_name: string; email: string | null }>(
        `SELECT i.workspace_id, w.name AS workspace_name, i.email FROM invites i JOIN workspaces w ON w.id = i.workspace_id
         WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ?`,
        sha256(token),
        Date.now(),
      ) ?? null
    );
  }

  acceptInvite(token: string, userId: string, email: string): void {
    const info = this.inviteInfo(token);
    if (!info) throw new HttpError(400, "This invite link has expired or was already used.");
    if (info.email && info.email.toLowerCase() !== email.toLowerCase())
      throw new HttpError(403, "This invite was sent to a different email address.");
    this.db.tx(() => {
      this.db.run("UPDATE invites SET accepted_at = ? WHERE token_hash = ?", Date.now(), sha256(token));
      this.db.run(
        "INSERT OR IGNORE INTO memberships (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)",
        info.workspace_id,
        userId,
        "member",
        Date.now(),
      );
    });
  }

  private seedSplits(userId: string) {
    DEFAULT_SPLITS.forEach(([name, query, hideWhenEmpty], i) =>
      this.db.run(
        "INSERT INTO splits (id, user_id, name, query, position, builtin, hide_when_empty) VALUES (?,?,?,?,?,1,?)",
        newId("spl"),
        userId,
        name,
        query,
        i,
        hideWhenEmpty ? 1 : 0,
      ),
    );
  }
}

const DUMMY_HASH = "scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

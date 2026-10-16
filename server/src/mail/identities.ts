import { HttpError } from "../auth/users.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/crypto.ts";
import { sanitizeOutgoingHtml } from "../lib/sanitize.ts";
import type { ProviderIdentity } from "./types.ts";

/**
 * Send-as identities: extra addresses an account can send from (Gmail send-as aliases, or addresses added by hand).
 * The account's own address isn't a row; everything here treats it as always allowed.
 */

export interface IdentityRow {
  id: string;
  account_id: string;
  email: string;
  name: string;
  reply_to: string | null;
  signature_html: string | null;
  source: "provider" | "manual";
  created_at: number;
}

export interface Identity {
  id: string;
  email: string;
  name: string;
  replyTo: string | null;
  signatureHtml: string | null;
  source: "provider" | "manual";
}

export interface IdentityInput {
  email: string;
  name?: string;
  replyTo?: string | null;
  signatureHtml?: string | null;
}

export const NOT_YOURS = "You can't send from that address on this account";
export const FROM_PROVIDER = "This address comes from your Gmail settings. Change it in Gmail and it updates here.";

export const shapeIdentity = (r: IdentityRow): Identity => ({
  id: r.id,
  email: r.email,
  name: r.name,
  replyTo: r.reply_to,
  signatureHtml: r.signature_html,
  source: r.source,
});

export function listIdentities(db: Db, accountId: string): Identity[] {
  return db
    .all<IdentityRow>("SELECT * FROM identities WHERE account_id = ? ORDER BY created_at, email", accountId)
    .map(shapeIdentity);
}

/** The account's own address plus its identities, lowercased. Read from the database each time, so it can't go stale. */
export function ownAddresses(db: Db, accountId: string): Set<string> {
  return new Set(
    db
      .all<{ email: string }>(
        "SELECT email FROM accounts WHERE id = ? UNION SELECT email FROM identities WHERE account_id = ?",
        accountId,
        accountId,
      )
      .map((r) => r.email.toLowerCase()),
  );
}

interface Sender {
  name: string;
  email: string;
  replyTo: string | null;
}

/** Who a message from this account goes out as. Throws unless `fromEmail` is the account's own address or one of its identities. */
export function resolveFrom(db: Db, accountId: string, fromEmail?: string | null): Sender {
  const account = db.get<{ name: string; email: string }>("SELECT name, email FROM accounts WHERE id = ?", accountId);
  if (!account) throw new HttpError(400, "Unknown sending account");
  const want = fromEmail?.trim().toLowerCase();
  if (!want || want === account.email.toLowerCase()) return { name: account.name, email: account.email, replyTo: null };
  const id = db.get<IdentityRow>("SELECT * FROM identities WHERE account_id = ? AND email = ?", accountId, want);
  if (!id) throw new HttpError(400, NOT_YOURS);
  return { name: id.name || account.name, email: id.email, replyTo: id.reply_to };
}

/**
 * The identity a message was addressed to, for reply defaults. `addressedTo` is the original's To and Cc in
 * order; the first one that is an identity wins. Null when it was sent to the account's own address or to no identity.
 */
export function replyIdentity(db: Db, accountId: string, addressedTo: string[]): string | null {
  const wanted = addressedTo.map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return null;
  const rows = db.all<{ email: string }>("SELECT email FROM identities WHERE account_id = ?", accountId);
  for (const a of wanted) {
    const hit = rows.find((r) => r.email.toLowerCase() === a);
    if (hit) return hit.email;
  }
  return null;
}

// ---- Settings → Accounts (people) ------------------------------------------

function ownedAccount(db: Db, userId: string, accountId: string) {
  const acc = db.get<{ id: string; email: string; provider: string }>(
    "SELECT id, email, provider FROM accounts WHERE id = ? AND user_id = ?",
    accountId,
    userId,
  );
  if (!acc) throw new HttpError(404, "Account not found");
  return acc;
}

function ownedIdentity(db: Db, userId: string, accountId: string, identityId: string) {
  const account = ownedAccount(db, userId, accountId);
  const row = db.get<IdentityRow>("SELECT * FROM identities WHERE id = ? AND account_id = ?", identityId, accountId);
  if (!row) throw new HttpError(404, "Address not found");
  return { account, row };
}

const cleanSignature = (html: string | null | undefined) => {
  const clean = html ? sanitizeOutgoingHtml(html).trim() : "";
  return clean || null;
};

function assertFree(db: Db, account: { id: string; email: string }, email: string, exceptId?: string) {
  if (email === account.email.toLowerCase()) throw new HttpError(400, "That is already this account's own address");
  const dup = db.get<{ id: string }>("SELECT id FROM identities WHERE account_id = ? AND email = ?", account.id, email);
  if (dup && dup.id !== exceptId) throw new HttpError(409, "That address is already added");
}

export function addIdentity(db: Db, userId: string, accountId: string, input: IdentityInput): Identity {
  const account = ownedAccount(db, userId, accountId);
  if (account.provider === "archive") throw new HttpError(400, "Imported archives can't send mail");
  const email = input.email.trim().toLowerCase();
  assertFree(db, account, email);
  const id = newId("idn");
  db.run(
    "INSERT INTO identities (id, account_id, email, name, reply_to, signature_html, source, created_at) VALUES (?,?,?,?,?,?,'manual',?)",
    id, account.id, email, input.name?.trim() ?? "", input.replyTo?.trim().toLowerCase() || null, cleanSignature(input.signatureHtml), Date.now(),
  );
  return shapeIdentity(db.get<IdentityRow>("SELECT * FROM identities WHERE id = ?", id)!);
}

export function updateIdentity(db: Db, userId: string, accountId: string, identityId: string, patch: Partial<IdentityInput>): Identity {
  const { account, row } = ownedIdentity(db, userId, accountId, identityId);
  if (row.source === "provider") throw new HttpError(409, FROM_PROVIDER);
  const email = patch.email === undefined ? row.email : patch.email.trim().toLowerCase();
  if (email !== row.email.toLowerCase()) assertFree(db, account, email, row.id);
  db.run(
    "UPDATE identities SET email = ?, name = ?, reply_to = ?, signature_html = ? WHERE id = ?",
    email,
    patch.name === undefined ? row.name : patch.name.trim(),
    patch.replyTo === undefined ? row.reply_to : patch.replyTo?.trim().toLowerCase() || null,
    patch.signatureHtml === undefined ? row.signature_html : cleanSignature(patch.signatureHtml),
    row.id,
  );
  return shapeIdentity(db.get<IdentityRow>("SELECT * FROM identities WHERE id = ?", row.id)!);
}

export function removeIdentity(db: Db, userId: string, accountId: string, identityId: string): void {
  const { row } = ownedIdentity(db, userId, accountId, identityId);
  if (row.source === "provider") throw new HttpError(409, FROM_PROVIDER);
  db.run("DELETE FROM identities WHERE id = ?", row.id);
}

// ---- Provider import ---------------------------------------------------------

/** Make the account's provider-sourced rows match what the provider lists now. Hand-added rows are never touched. */
export function syncProviderIdentities(db: Db, accountId: string, listed: ProviderIdentity[]): void {
  const own = db.get<{ email: string }>("SELECT email FROM accounts WHERE id = ?", accountId)?.email.toLowerCase();
  if (own === undefined) return;
  db.tx(() => {
    const keep = new Set<string>();
    for (const l of listed) {
      const email = l.email.trim().toLowerCase();
      if (!email || email === own) continue;
      keep.add(email);
      db.run(
        `INSERT INTO identities (id, account_id, email, name, reply_to, signature_html, source, created_at) VALUES (?,?,?,?,?,?,'provider',?)
         ON CONFLICT (account_id, email) DO UPDATE SET name = excluded.name, reply_to = excluded.reply_to, signature_html = excluded.signature_html
         WHERE identities.source = 'provider'`,
        newId("idn"), accountId, email, l.name, l.replyTo?.trim().toLowerCase() || null, cleanSignature(l.signatureHtml), Date.now(),
      );
    }
    for (const r of db.all<{ id: string; email: string }>("SELECT id, email FROM identities WHERE account_id = ? AND source = 'provider'", accountId)) {
      if (!keep.has(r.email.toLowerCase())) db.run("DELETE FROM identities WHERE id = ?", r.id);
    }
  });
}

// Writes the schema migrations as plain .sql files (db/migrations/NNNN.sql) for other runtimes,
// such as the Rust crates. server/src/db/schema.ts stays the source; a test fails if these drift.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrations } from "../server/src/db/schema.ts";

export function migrationFiles(): { name: string; sql: string }[] {
  return migrations.map((sql, i) => ({
    name: `${String(i + 1).padStart(4, "0")}.sql`,
    sql: `-- Generated from server/src/db/schema.ts (migration ${i + 1}). Edit there, then run: npm run schema:export\n${sql.trim()}\n`,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = join(import.meta.dirname, "..", "db", "migrations");
  mkdirSync(dir, { recursive: true });
  for (const f of migrationFiles()) writeFileSync(join(dir, f.name), f.sql);
  console.log(`Wrote ${migrations.length} migrations to db/migrations/`);
}

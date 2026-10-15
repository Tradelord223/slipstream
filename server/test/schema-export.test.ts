import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { migrationFiles } from "../../scripts/export-schema.ts";

test("db/migrations/*.sql match server/src/db/schema.ts (run npm run schema:export)", () => {
  for (const f of migrationFiles()) {
    const onDisk = readFileSync(join(import.meta.dirname, "..", "..", "db", "migrations", f.name), "utf8");
    assert.equal(onDisk, f.sql, `${f.name} is out of date`);
  }
});

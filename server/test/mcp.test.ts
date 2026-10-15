import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../src/config.ts";
import { createContext } from "../src/main.ts";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import type { AccountRow } from "../src/mail/store.ts";
import { addAccount, msg } from "./helpers.ts";

describe("Mail MCP server", () => {
  const dir = mkdtempSync(join(tmpdir(), "slipstream-mcp-"));
  const client = new Client({ name: "test", version: "1.0.0" });
  let threadId = "";

  before(async () => {
    const ctx = createContext(loadConfig({ dataDir: dir, dbPath: join(dir, "slipstream.db"), demo: false }));
    ctx.users.ensureLocalUser();
    const account = ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", addAccount(ctx, LOCAL_USER_ID))!;
    ctx.store.ingest(account, {
      messages: [msg({ from: { name: "Priya", email: "priya@kettleby.test" }, subject: "Lane grouping", bodyText: "Night shift loves the lane grouping.", remoteThreadId: "mcp1" })],
      cursor: null,
      done: true,
    });
    threadId = ctx.db.get<{ id: string }>("SELECT id FROM threads WHERE remote_id = 'mcp1'")!.id;
    ctx.db.close();
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: ["server/src/mcp.ts"], env: { ...process.env, SLIPSTREAM_DATA_DIR: dir } as Record<string, string> }),
    );
  });
  after(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

  test("offers read, search and draft tools only", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["create_draft", "list_inbox", "read_conversation", "search_mail"]);
  });

  test("searches and reads local mail", async () => {
    assert.match(text(await client.callTool({ name: "search_mail", arguments: { query: "from:priya lane" } })), /Lane grouping/);
    assert.match(text(await client.callTool({ name: "read_conversation", arguments: { conversationId: threadId } })), /Night shift loves/);
  });

  test("drafts a reply without sending it", async () => {
    const r = text(await client.callTool({ name: "create_draft", arguments: { conversationId: threadId, to: ["priya@kettleby.test"], body: "Thanks Priya!" } }));
    assert.match(r, /Draft saved/);
    const ctx = createContext(loadConfig({ dataDir: dir, dbPath: join(dir, "slipstream.db"), demo: false }));
    const d = ctx.db.get<{ status: string; subject: string }>("SELECT status, subject FROM drafts")!;
    ctx.db.close();
    assert.equal(d.status, "draft");
    assert.equal(d.subject, "Re: Lane grouping");
  });
});

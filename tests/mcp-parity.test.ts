import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resetStoreForTesting } from "../src/lib/server/app";
import { HUMAN_CAPABILITIES } from "../src/lib/server/mcp/parity";
import { handleMcp, resetSessionsForTesting } from "../src/lib/server/mcp/server";
import { SETTING_KEYS, toolByName } from "../src/lib/server/mcp/tools";
import { baseConfig, defaultConfigFor } from "../src/templates";
import { POLL_TYPES } from "../src/types";
import type { Store } from "../src/db";

/**
 * Guards the rule in AGENTS.md: whatever people can do in the web app, agents
 * can do over MCP. A failure here means a human-side capability was added or
 * changed without its MCP counterpart; see .claude/skills/mcp-parity/SKILL.md.
 */

const ROUTES = join(import.meta.dir, "../src/routes");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "+page.server.ts" || name === "+server.ts" ? [path] : [];
  });
}

/** `<path>#load`, `<path>#<action>` and `<path>#<METHOD>` for every server entry point people can reach. */
function humanCapabilities(): string[] {
  const found: string[] = [];
  for (const path of routeFiles(ROUTES)) {
    const file = relative(ROUTES, path);
    const source = readFileSync(path, "utf8");
    if (/^export (const|async function|function) load\b/m.test(source)) found.push(`${file}#load`);
    const actions = /^export const actions = \{([\s\S]*?)^\}/m.exec(source)?.[1] ?? "";
    for (const match of actions.matchAll(/^ {2}(\w+)\s*:/gm)) found.push(`${file}#${match[1]}`);
    for (const match of source.matchAll(/^export (?:const|async function|function) (GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|fallback)\b/gm)) found.push(`${file}#${match[1]}`);
  }
  return found.sort();
}

describe("MCP parity with the web app", () => {
  test("every page load, form action and HTTP handler has an MCP counterpart", () => {
    const found = humanCapabilities();
    expect(found.length).toBeGreaterThan(20);
    const unmapped = found.filter((key) => !(key in HUMAN_CAPABILITIES));
    if (unmapped.length) {
      throw new Error(`Human-side capabilities without an MCP counterpart:\n  ${unmapped.join("\n  ")}\nAdd an MCP tool (or extend one) and map it in src/lib/server/mcp/parity.ts. See .claude/skills/mcp-parity/SKILL.md.`);
    }
    const stale = Object.keys(HUMAN_CAPABILITIES).filter((key) => !found.includes(key));
    expect(stale).toEqual([]);
  });

  test("mapped tools exist and exclusions give a reason", () => {
    for (const [key, counterpart] of Object.entries(HUMAN_CAPABILITIES)) {
      if ("excluded" in counterpart) {
        expect(counterpart.excluded.trim().length, key).toBeGreaterThan(5);
        continue;
      }
      expect(counterpart.tools.length, key).toBeGreaterThan(0);
      for (const tool of counterpart.tools) expect(toolByName.has(tool), `${key} -> ${tool}`).toBe(true);
    }
  });

  test("every poll setting can be set through MCP", () => {
    const keys = new Set([...Object.keys(baseConfig), ...POLL_TYPES.flatMap((type) => Object.keys(defaultConfigFor(type)))]);
    // voterMode is set by giving (or clearing) `invitees`.
    keys.delete("voterMode");
    expect([...keys].filter((key) => !SETTING_KEYS.includes(key))).toEqual([]);
  });

  describe("every poll type can be run end to end", () => {
    let dir = "";
    let store: Store;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "poll-parity-"));
      store = resetStoreForTesting(join(dir, "test.sqlite"));
      resetSessionsForTesting();
    });
    afterEach(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const call = (sessionId: string | null, name: string, args: Record<string, unknown>) => {
      const body = handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), { origin: "https://poll.test", sessionId, bearer: "", limit: null }).body as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent: Record<string, any> } };
      if (body.result.isError) throw new Error(`${name}: ${body.result.content[0]?.text}`);
      return body.result.structuredContent;
    };

    for (const type of POLL_TYPES) {
      test(type, () => {
        const poll = call(null, "create_poll", { type, title: `A ${type} poll`, open: true });
        // The example ballot get_poll hands to agents must be a valid vote.
        const { howToVote } = call(null, "get_poll", { poll: poll.id });
        expect(howToVote.summary.length).toBeGreaterThan(20);
        const voted = call(null, "cast_vote", { poll: poll.id, ...howToVote.example });
        expect(voted.voted).toBe(true);
        const closed = call(null, "close_poll", { poll: poll.id, adminToken: poll.adminToken });
        expect(closed.results.castVotes).toBe(1);
      });
    }
  });
});

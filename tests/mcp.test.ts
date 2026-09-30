import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetStoreForTesting } from "../src/lib/server/app";
import { handleMcp, resetSessionsForTesting, type McpRequestContext } from "../src/lib/server/mcp/server";
import { tools } from "../src/lib/server/mcp/tools";
import { classifyRequest } from "../src/lib/server/ratelimit";
import { POST as mcpRoute } from "../src/routes/mcp/+server";
import type { Store } from "../src/db";

const ORIGIN = "https://poll.test";
let dir = "";
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poll-mcp-"));
  store = resetStoreForTesting(join(dir, "test.sqlite"));
  resetSessionsForTesting();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.OPERATOR_TOKEN;
});

type Json = Record<string, any>;

function rpc(body: unknown, overrides: Partial<McpRequestContext> = {}) {
  return handleMcp(JSON.stringify(body), { origin: ORIGIN, sessionId: null, bearer: "", limit: null, ...overrides });
}

/** An MCP client session, as an agent would hold one. */
function connect(overrides: Partial<McpRequestContext> = {}) {
  const init = rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, overrides);
  const sessionId = init.sessionId ?? null;
  expect(sessionId).toBeTruthy();
  let nextId = 2;
  const raw = (name: string, args: Json = {}) => {
    const response = rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, { ...overrides, sessionId });
    return (response.body as Json).result as Json;
  };
  return {
    sessionId,
    init: init.body as Json,
    raw,
    /** Calls a tool and returns its structured output, failing the test on a tool error. */
    call(name: string, args: Json = {}): Json {
      const result = raw(name, args);
      if (result.isError) throw new Error(`${name} failed: ${result.content[0].text}`);
      return result.structuredContent;
    },
    /** Calls a tool that should fail and returns its error message. */
    fail(name: string, args: Json = {}): string {
      const result = raw(name, args);
      expect(result.isError).toBe(true);
      return result.content[0].text as string;
    }
  };
}

describe("MCP protocol", () => {
  test("initialize negotiates a version, starts a session and explains the app", () => {
    const init = rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.status).toBe(200);
    expect(init.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const result = (init.body as Json).result;
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe("poll");
    expect(result.instructions).toContain("adminToken");

    const unknownVersion = rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect((unknownVersion.body as Json).result.protocolVersion).toBe("2025-11-25");
  });

  test("tools/list describes every tool with a schema and hints", () => {
    const body = rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }).body as Json;
    const names = body.result.tools.map((tool: Json) => tool.name);
    expect(names).toEqual(tools.map((tool) => tool.name));
    expect(names).toEqual(expect.arrayContaining(["create_poll", "get_poll", "cast_vote", "close_poll", "export_results", "add_invitees"]));
    for (const tool of body.result.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(40);
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
    }
    const deleteTool = body.result.tools.find((tool: Json) => tool.name === "delete_poll");
    expect(deleteTool.annotations.destructiveHint).toBe(true);
  });

  test("notifications get 202, bad JSON 400, unknown methods and tools JSON-RPC errors, ping works", () => {
    expect(rpc({ jsonrpc: "2.0", method: "notifications/initialized" }).status).toBe(202);
    expect(handleMcp("{nope", { origin: ORIGIN, sessionId: null, bearer: "", limit: null }).status).toBe(400);
    expect((rpc({ jsonrpc: "2.0", id: 7, method: "resources/list" }).body as Json).error.code).toBe(-32601);
    expect((rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "nope" } }).body as Json).error.code).toBe(-32602);
    expect((rpc({ jsonrpc: "2.0", id: 9, method: "ping" }).body as Json).result).toEqual({});
    const batch = rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "ping" }]);
    expect((batch.body as Json[]).map((reply) => reply.id)).toEqual([1, 2]);
  });

  test("the route serves POST with a session header and 405 for GET", async () => {
    const response = await mcpRoute({
      request: new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) }),
      url: new URL(`${ORIGIN}/mcp`),
      getClientAddress: () => "203.0.113.1"
    } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    expect(((await response.json()) as Json).result.serverInfo.name).toBe("poll");
  });

  test("/mcp is limited per tool call, not per request", () => {
    expect(classifyRequest("POST", "/mcp")).toBeNull();
    let calls = 0;
    const agent = connect({ limit: (bucket) => ({ allowed: bucket !== "create" || ++calls <= 1, remaining: 0, retryAfter: 30 }) });
    agent.call("create_poll", { type: "majority", title: "One" });
    expect(agent.fail("create_poll", { type: "majority", title: "Two" })).toContain("Too many requests");
    agent.call("list_poll_types");
  });
});

describe("MCP decision flows", () => {
  test("list_poll_types explains every method", () => {
    const { pollTypes } = connect().call("list_poll_types");
    expect(pollTypes.map((type: Json) => type.type)).toContain("stv");
    const consent = pollTypes.find((type: Json) => type.type === "consent");
    expect(consent.fixedOptions).toBe(true);
    expect(consent.defaultOptions.map((option: Json) => option.label)).toEqual(["Consent", "Objection"]);
    expect(consent.whenToUse).toBeTruthy();
  });

  test("a consent proposal from draft to exported result, across agents", () => {
    const admin = connect();
    const created = admin.call("create_poll", { type: "consent", title: "Rotate hosts monthly?", details: "Trial for a month.", settings: { reasonMode: "required" } });
    expect(created.status).toBe("draft");
    expect(created.id).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(created.url).toBe(`${ORIGIN}/poll/${created.id}`);
    expect(created.adminLink).toBe(`${ORIGIN}/poll/${created.id}?admin=${created.adminToken}`);
    expect(created.you.role).toBe("admin");
    expect(created.options.map((option: Json) => option.label)).toEqual(["Consent", "Objection"]);
    expect(created.adminActions).toContain("open_poll");

    const early = connect();
    expect(early.fail("cast_vote", { poll: created.id, voterName: "Ada", choice: "Consent", reason: "ok" })).toContain("draft");
    expect(early.fail("open_poll", { poll: created.id })).toContain("Only the poll's admin");

    expect(admin.call("open_poll", { poll: created.id }).status).toBe("open");

    const ada = connect();
    const view = ada.call("get_poll", { poll: created.url });
    expect(view.you).toMatchObject({ role: "visitor", canVote: true });
    expect(view.howToVote.summary).toContain("`choice`");
    expect(view.howToVote.summary).toContain("`reason` is required");
    expect(view.results).toBeNull();
    expect(view.resultsNote).toContain("after they vote");
    expect(view.adminToken).toBeUndefined();

    expect(ada.fail("cast_vote", { poll: created.id, voterName: "Ada", choice: "Consent" })).toContain("reason is required");
    expect(ada.fail("cast_vote", { poll: created.id, voterName: "Ada", choice: "Maybe", reason: "x" })).toContain("Unknown option");
    expect(ada.fail("cast_vote", { poll: created.id, voterName: "Ada", ranking: ["Consent"], reason: "x" })).toContain("takes `choice`");
    const voted = ada.call("cast_vote", { poll: created.id, voterName: "Ada", choice: "consent", reason: "Safe to try." });
    expect(voted.yourVote).toMatchObject({ choice: "Consent", reason: "Safe to try." });
    expect(voted.voteToken).toBeTruthy();
    expect(voted.canChangeVote).toBe(false);
    expect(voted.poll.results.castVotes).toBe(1);
    expect(ada.fail("cast_vote", { poll: created.id, voterName: "Ada 2", choice: "Objection", reason: "x" })).toContain("can't be changed");

    const bo = connect();
    bo.call("cast_vote", { poll: created.id, voterName: "Bo", choice: created.options[1].id, reason: "Too soon." });

    // A later session picks the ballot back up with its vote token.
    const adaLater = connect();
    expect(adaLater.call("get_poll", { poll: created.id, voteToken: voted.voteToken }).you).toMatchObject({ role: "voter", votingAs: "Ada", yourVote: { choice: "Consent" } });
    expect(adaLater.fail("get_poll", { poll: created.id, voteToken: "forged" })).toContain("vote token");

    // The admin can act from a fresh session with the token, or the admin link.
    const adminLater = connect();
    expect(adminLater.fail("close_poll", { poll: created.id, adminToken: "wrong" })).toContain("not valid");
    expect(adminLater.fail("export_results", { poll: created.adminLink })).toContain("only after this poll closes");
    const closed = adminLater.call("close_poll", { poll: created.id, adminToken: created.adminToken });
    expect(closed.status).toBe("closed");
    expect(closed.results.outcome).toBeTruthy();
    expect(closed.results.rows.find((row: Json) => row.label === "Objection").count).toBe(1);
    expect(closed.results.voteDetails.map((detail: Json) => detail.voterName).sort()).toEqual(["Ada", "Bo"]);
    expect(closed.results.voteDetails[0].ballot).toBeUndefined();

    expect(connect().call("get_results", { poll: created.id }).results.castVotes).toBe(2);

    const exported = adminLater.call("export_results", { poll: created.id });
    expect(exported.poll.id).toBe(created.id);
    expect(exported.votes.map((vote: Json) => vote.ballot.choice).sort()).toEqual(["Consent", "Objection"]);
    expect(connect().fail("export_results", { poll: created.id })).toContain("Only the poll's admin");

    expect(admin.call("list_my_polls").closed.map((poll: Json) => poll.id)).toEqual([created.id]);
    expect(ada.call("list_my_polls").closed[0].role).toBe("voter");
    expect(connect().call("list_my_polls")).toEqual({ drafts: [], active: [], closed: [] });

    expect(admin.call("delete_poll", { poll: created.id }).deleted).toBe(true);
    expect(connect().fail("get_poll", { poll: created.id })).toContain("not found");
  });

  test("invite-only polls vote through personal links", () => {
    const admin = connect();
    const created = admin.call("create_poll", { type: "approval", title: "Which venues work?", options: ["Hall", { label: "Park", description: "Weather permitting" }, "Cafe"], invitees: ["Ada", "Bo"], open: true });
    expect(created.status).toBe("open");
    expect(created.settings.voterMode).toBe("invite");
    expect(created.invitations.map((entry: Json) => entry.name)).toEqual(["Ada", "Bo"]);
    expect(created.invitationSummary).toBe("0 of 2 invitees have voted.");
    const adaLink = created.invitations[0].link as string;
    expect(adaLink.startsWith(`${ORIGIN}/poll/${created.id}?invite=`)).toBe(true);

    const stranger = connect();
    expect(stranger.call("get_poll", { poll: created.id }).you.cannotVoteReason).toContain("invite-only");
    expect(stranger.fail("cast_vote", { poll: created.id, voterName: "Ada", selected: ["Hall"] })).toContain("invite-only");

    const ada = connect();
    expect(ada.call("get_poll", { poll: adaLink }).you).toMatchObject({ role: "invitee", votingAs: "Ada", canVote: true });
    const voted = ada.call("cast_vote", { poll: created.id, voterName: "Mallory", selected: ["hall", "PARK"] });
    expect(voted.votingAs).toBe("Ada");
    expect(voted.yourVote.selected).toEqual(["Hall", "Park"]);
    expect(voted.voteToken).toBeUndefined();

    const bo = connect();
    const boToken = new URL(created.invitations[1].link).searchParams.get("invite");
    bo.call("cast_vote", { poll: created.id, inviteToken: boToken, selected: [] });

    const added = admin.call("add_invitees", { poll: created.id, invitees: ["Cy", "ada"] });
    expect(added.added).toEqual(["Cy"]);
    expect(added.newInvitations[0].link).toContain("?invite=");
    expect(added.poll.invitationSummary).toBe("2 of 3 invitees have voted.");
  });

  test("ballots for every non-proposal method", () => {
    const admin = connect();
    const voter = () => connect();
    const make = (args: Json) => admin.call("create_poll", { open: true, settings: { hideResults: "off", ...(args.settings ?? {}) }, ...args });

    const choose = make({ type: "choose", title: "Pick two", options: ["A", "B", "C"], settings: { minChoices: 2, maxChoices: 2, hideResults: "off" } });
    expect(choose.howToVote.summary).toContain("exactly 2 options");
    const chooser = voter();
    expect(chooser.fail("cast_vote", { poll: choose.id, voterName: "V", selected: ["A"] })).toContain("between 2 and 2");
    expect(chooser.call("cast_vote", { poll: choose.id, voterName: "V", selected: ["A", "C"] }).yourVote.selected).toEqual(["A", "C"]);

    const score = make({ type: "score", title: "Rate", options: ["X", "Y"], settings: { scoreMin: 1, scoreMax: 10 } });
    const scorer = voter();
    expect(scorer.fail("cast_vote", { poll: score.id, voterName: "V", scores: { X: 3 } })).toContain('Missing: "Y"');
    expect(scorer.fail("cast_vote", { poll: score.id, voterName: "V", scores: { X: 3, Y: 11 } })).toContain("from 1 to 10");
    expect(scorer.call("cast_vote", { poll: score.id, voterName: "V", scores: { X: 3, [score.options[1].id]: 9 } }).yourVote.scores).toEqual({ X: 3, Y: 9 });

    const allocate = make({ type: "allocate", title: "Split", options: ["X", "Y"], settings: { pointBudget: 5 } });
    const allocator = voter();
    expect(allocator.fail("cast_vote", { poll: allocate.id, voterName: "V", allocations: { X: 4, Y: 2 } })).toContain("must not exceed 5");
    expect(allocator.call("cast_vote", { poll: allocate.id, voterName: "V", allocations: { X: 5 } }).yourVote.allocations).toEqual({ X: 5 });

    const rank = make({ type: "rank", title: "Order", options: ["P", "Q", "R", "S"], settings: { rankCount: 2 } });
    const ranker = voter();
    expect(ranker.fail("cast_vote", { poll: rank.id, voterName: "V", ranking: ["P", "Q", "R"] })).toContain("at most 2");
    expect(ranker.fail("cast_vote", { poll: rank.id, voterName: "V", ranking: ["P", "P"] })).toContain("at most once");
    expect(ranker.call("cast_vote", { poll: rank.id, voterName: "V", ranking: ["Q", "P"] }).yourVote.ranking).toEqual(["Q", "P"]);

    const stv = make({ type: "stv", title: "Elect two", options: ["Ann", "Ben", "Cat", "Dan"], settings: { seats: 2 } });
    for (const [name, ranking] of [["V1", ["Ann", "Ben"]], ["V2", ["Ann", "Cat"]], ["V3", ["Ben", "Ann"]], ["V4", ["Dan"]], ["V5", ["Ben"]]] as const) {
      voter().call("cast_vote", { poll: stv.id, voterName: name, ranking });
    }
    const stvClosed = admin.call("close_poll", { poll: stv.id });
    expect(stvClosed.results.roundLogs.length).toBeGreaterThan(0);
    expect(stvClosed.results.rows.filter((row: Json) => row.status === "elected").length).toBe(2);

    const time = make({ type: "time_poll", title: "When?", options: ["2030-10-05T14:00:00Z", "2030-10-06 09:30"], settings: { meetingDurationMinutes: 30 } });
    expect(time.options[1]).toMatchObject({ label: "2030-10-06T09:30:00.000Z", start: "2030-10-06T09:30:00.000Z", end: "2030-10-06T10:00:00.000Z" });
    const scheduler = voter();
    expect(scheduler.fail("cast_vote", { poll: time.id, voterName: "V", availability: { "2030-10-05T14:00:00Z": "yes" } })).toContain("Missing");
    const timeVote = scheduler.call("cast_vote", { poll: time.id, voterName: "V", availability: { "2030-10-05T16:00:00+02:00": "maybe" }, defaultAvailability: "available" });
    expect(timeVote.yourVote.availability).toEqual({ "2030-10-05T14:00:00.000Z": "if_needed", "2030-10-06T09:30:00.000Z": "available" });
    const timeClosed = admin.call("close_poll", { poll: time.id });
    expect(timeClosed.results.calendarUrl).toBe(`${ORIGIN}/poll/${time.id}/event.ics`);
  });

  test("drafts can be edited in parts, retyped and scheduled", () => {
    const admin = connect();
    const draft = admin.call("create_poll", { type: "choose", title: "Lunch", options: ["Soup", "Salad"], settings: { maxChoices: 2 } });
    const edited = admin.call("update_draft", { poll: draft.id, title: "Lunch on Friday", settings: { anonymous: true } });
    expect(edited.title).toBe("Lunch on Friday");
    expect(edited.options.map((option: Json) => option.label)).toEqual(["Soup", "Salad"]);
    expect(edited.settings).toMatchObject({ anonymous: true, maxChoices: 2 });

    const retyped = admin.call("update_draft", { poll: draft.id, type: "majority" });
    expect(retyped.options.map((option: Json) => option.label)).toEqual(["Yes", "No"]);
    expect(retyped.settings.maxChoices).toBeUndefined();
    expect(retyped.settings.anonymous).toBe(true);
    expect(admin.fail("update_draft", { poll: draft.id, options: ["Sure", "Nah"] })).toContain("fixed voting positions");
    expect(admin.fail("update_draft", { poll: draft.id, settings: { colour: "red" } })).toContain("Unknown setting");
    expect(admin.call("update_draft", { poll: draft.id, invitees: ["Ada"] }).settings.voterMode).toBe("invite");
    expect(admin.call("update_draft", { poll: draft.id, invitees: [] }).settings.voterMode).toBe("open");

    expect(admin.fail("schedule_poll", { poll: draft.id })).toContain("opening time");
    const opensAt = new Date(Date.now() + 86_400_000).toISOString();
    const scheduled = admin.call("schedule_poll", { poll: draft.id, opensAt });
    expect(scheduled.status).toBe("scheduled");
    expect(scheduled.opensAt).toBe(opensAt);
    expect(admin.fail("update_draft", { poll: draft.id, title: "x" })).toContain("Unschedule it first");

    const visitor = connect().call("get_poll", { poll: draft.id });
    expect(visitor.options).toEqual([]);
    expect(visitor.howToVote).toBeUndefined();
    expect(visitor.you.cannotVoteReason).toContain("Voting opens at");

    expect(admin.call("unschedule_poll", { poll: draft.id }).status).toBe("draft");

    const copy = admin.call("duplicate_poll", { poll: draft.id });
    expect(copy.title).toBe("Copy of Lunch on Friday");
    expect(copy.adminToken).not.toBe(draft.adminToken);
    expect(copy.status).toBe("draft");
  });

  test("create_poll with open and a future opensAt schedules it", () => {
    const opensAt = new Date(Date.now() + 3_600_000).toISOString();
    expect(connect().call("create_poll", { type: "majority", title: "Later", opensAt, open: true }).status).toBe("scheduled");
  });

  test("results hidden until close stay hidden, even after voting", () => {
    const admin = connect();
    const poll = admin.call("create_poll", { type: "majority", title: "Secret", open: true, settings: { hideResults: "after_close" } });
    const voter = connect();
    const voted = voter.call("cast_vote", { poll: poll.id, voterName: "V", choice: "Yes" });
    expect(voted.poll.results).toBeNull();
    expect(voter.call("get_results", { poll: poll.id }).resultsNote).toContain("until the poll closes");
    admin.call("close_poll", { poll: poll.id });
    expect(voter.call("get_results", { poll: poll.id }).results.castVotes).toBe(1);
  });

  test("the operator token works as a bearer credential", () => {
    process.env.OPERATOR_TOKEN = "op-secret";
    const owner = connect();
    const poll = owner.call("create_poll", { type: "majority", title: "Spam?" });
    expect(connect().fail("delete_poll", { poll: poll.id })).toContain("Only the poll's admin");
    const operator = connect({ bearer: "op-secret" });
    expect(operator.call("list_my_polls").drafts.map((entry: Json) => entry.id)).toEqual([poll.id]);
    expect(operator.call("get_poll", { poll: poll.id }).you.role).toBe("operator");
    expect(operator.call("delete_poll", { poll: poll.id }).deleted).toBe(true);
  });

  test("sessions are isolated, and stateless calls still work with explicit tokens", () => {
    const admin = connect();
    const poll = admin.call("create_poll", { type: "majority", title: "Stateless" });
    const stateless = (name: string, args: Json) => (rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }).body as Json).result;
    expect(stateless("open_poll", { poll: poll.id }).isError).toBe(true);
    expect(stateless("open_poll", { poll: poll.id, adminToken: poll.adminToken }).structuredContent.status).toBe("open");
    // An unknown or expired session id is treated as a fresh session.
    const orphan = rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_my_polls", arguments: {} } }, { sessionId: "gone" });
    expect((orphan.body as Json).result.structuredContent.active).toEqual([]);
  });
});

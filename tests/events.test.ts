import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cookies } from "@sveltejs/kit";
import type { Store } from "../src/db";
import { createPollWithAdmin, inputFromData, OPERATOR_COOKIE, resetStoreForTesting } from "../src/lib/server/app";
import { runWithContext } from "../src/lib/server/context";
import { cleanPath, logEvent, pollSlugOf } from "../src/lib/server/events";
import { handleMcp, resetSessionsForTesting, type McpRequestContext } from "../src/lib/server/mcp/server";
import { setAskForTesting, type Ask } from "../src/lib/server/suggest";
import { actions as homeActions } from "../src/routes/+page.server";
import { POST as beacon } from "../src/routes/api/events/+server";
import { load as eventsLoad } from "../src/routes/events/+page.server";
import { GET as exportCsv } from "../src/routes/events/export.csv/+server";
import { GET as exportJson } from "../src/routes/events/export.json/+server";

const ORIGIN = "https://poll.test";
const OPERATOR = "operator-secret-for-tests";
let dir = "";
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poll-events-"));
  store = resetStoreForTesting(join(dir, "test.sqlite"));
  resetSessionsForTesting();
});

afterEach(() => {
  setAskForTesting(null);
  store.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.OPERATOR_TOKEN;
  delete process.env.EVENT_LOG;
});

type Json = Record<string, any>;

function connect(overrides: Partial<McpRequestContext> = {}) {
  const send = (body: unknown, sessionId: string | null) => handleMcp(JSON.stringify(body), { origin: ORIGIN, sessionId, bearer: "", limit: null, ...overrides });
  const init = send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "test-agent", version: "9" } } }, null);
  const sessionId = init.sessionId ?? null;
  let id = 2;
  return {
    raw: (name: string, args: Json = {}) => (send({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }, sessionId).body as Json).result as Json,
    call(name: string, args: Json = {}): Json {
      const result = this.raw(name, args);
      if (result.isError) throw new Error(`${name} failed: ${result.content[0].text}`);
      return result.structuredContent;
    }
  };
}

const kinds = () => store.listEvents({ limit: 500 }).reverse().map((event) => event.kind);

function cookieJar(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { get: (name: string) => values.get(name), getAll: () => [...values].map(([name, value]) => ({ name, value })), set: (name: string, value: string) => void values.set(name, value), delete: (name: string) => void values.delete(name) } as unknown as Cookies;
}

describe("the usage log", () => {
  test("a poll's whole life is recorded with its contents, and no tokens", () => {
    const agent = connect();
    const created = agent.call("create_poll", { type: "choose", title: "Which film?", details: "Friday night", options: ["Past Lives", { label: "Poor Things", description: "Gothic" }], open: true });
    const voted = agent.call("cast_vote", { poll: created.id, voterName: "Ada", selected: ["Past Lives"], reason: "Loved the trailer" });
    agent.call("close_poll", { poll: created.id });

    const events = store.listEvents({ limit: 500 }).reverse();
    expect(kinds()).toEqual(expect.arrayContaining(["mcp_initialize", "poll_created", "poll_opened", "vote_cast", "poll_closed", "mcp_tool"]));

    const createdEvent = events.find((event) => event.kind === "poll_created")!;
    expect(createdEvent.pollSlug).toBe(created.id);
    expect(createdEvent.data).toMatchObject({ type: "choose", title: "Which film?", details: "Friday night", options: [{ label: "Past Lives", meaning: "" }, { label: "Poor Things", meaning: "Gothic" }], inviteeCount: 0 });
    expect((createdEvent.data.config as Json).anonymous).toBe(false);

    const vote = events.find((event) => event.kind === "vote_cast")!;
    expect(vote.data).toMatchObject({ type: "choose", update: false, reason: "Loved the trailer", voterName: "Ada" });
    expect(Object.values(vote.data.optionLabels as Json)).toEqual(expect.arrayContaining(["Past Lives", "Poor Things"]));
    expect(vote.data.ballot).toBeDefined();

    const toolCalls = events.filter((event) => event.kind === "mcp_tool");
    expect(toolCalls.map((event) => event.data.tool)).toEqual(expect.arrayContaining(["create_poll", "cast_vote", "close_poll"]));
    expect(toolCalls.every((event) => event.data.ok === true && typeof event.data.ms === "number")).toBe(true);
    expect(events.find((event) => event.kind === "mcp_initialize")!.data).toMatchObject({ client: "test-agent", clientVersion: "9" });

    // Nothing that grants access is ever written.
    const everything = JSON.stringify(events);
    expect(everything).not.toContain(created.adminToken);
    expect(everything).not.toContain(voted.voteToken);
    expect(everything).not.toContain("admin=");
  });

  test("anonymous polls log ballots but never who cast them", () => {
    const agent = connect();
    const created = agent.call("create_poll", { type: "approval", title: "Secret?", options: ["A", "B"], settings: { anonymous: true }, open: true });
    runWithContext({ source: "web", path: `/poll/${created.id}`, session: "abcdefgh1234" }, () => {
      agent.call("cast_vote", { poll: created.id, selected: ["A"] });
    });
    const vote = store.listEvents({ kind: "vote_cast" })[0]!;
    expect(vote.session).toBe("");
    expect("voterName" in vote.data).toBe(false);
    expect(vote.data.ballot).toBeDefined();
    expect(JSON.stringify(vote)).not.toContain("Anonymous ");
  });

  test("rejected ballots are logged without the ballot", () => {
    const admin = connect();
    const created = admin.call("create_poll", { type: "consent", title: "Final?", open: true });
    const agent = connect();
    agent.call("cast_vote", { poll: created.id, voterName: "Ada", choice: "Consent", reason: "yes" });
    expect(agent.raw("cast_vote", { poll: created.id, voterName: "Ada", choice: "Objection", reason: "changed my mind" }).isError).toBe(true);
    const rejected = store.listEvents({ kind: "vote_rejected" })[0]!;
    expect(rejected.data.message).toContain("already in");
    expect(JSON.stringify(rejected)).not.toContain("changed my mind");
    const failedTool = store.listEvents({ kind: "mcp_tool" }).find((event) => event.data.ok === false)!;
    expect(failedTool.data.tool).toBe("cast_vote");
    expect(failedTool.pollSlug).toBe(created.id);
  });

  test("source and session come from the request, not the caller", () => {
    runWithContext({ source: "web", path: "/x", session: "sessionid1234" }, () => logEvent("probe", { a: 1 }));
    logEvent("probe", { b: 2 });
    const [outside, inside] = store.listEvents({ kind: "probe" });
    expect(inside).toMatchObject({ source: "web", session: "sessionid1234", data: { a: 1 } });
    expect(outside).toMatchObject({ source: "internal", session: "" });
  });

  test("a description is linked to the poll saved from it, with what was changed", async () => {
    process.env.TYPESAFE_API_KEY = "";
    const fake: Ask = async (request) => ({
      model: "jev-test",
      usage: { input_tokens: 10, output_tokens: 5 },
      answers: Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => [
          id,
          question.type === "noul" ? { type: "noul", noul: id.startsWith("item_") ? 0.95 : 0.02 } : id === "type" ? { type: "choice", choice: "choose", confidence: 1, probabilities: { choose: 1 } } : { type: "choice", choice: id === "option_count" ? "unknown" : "other", confidence: 1, probabilities: { other: 1 } }
        ])
      )
    });
    setAskForTesting(fake);
    const result = (await runWithContext({ source: "web", path: "/", session: "sessionid1234" }, () =>
      homeActions.suggest({ request: new Request("http://local.test/?/suggest", { method: "POST", headers: { "x-sveltekit-action": "true" }, body: new URLSearchParams({ prompt: "Which film: Past Lives, Perfect Days or Poor Things?" }) }) } as never)
    )) as { suggestion: Json };

    const described = store.listEvents({ kind: "describe" })[0]!;
    expect(described.session).toBe("sessionid1234");
    expect(described.data).toMatchObject({ suggestionId: result.suggestion.id, prompt: "Which film: Past Lives, Perfect Days or Poor Things?", model: "jev-test", usage: { input_tokens: 10, output_tokens: 5 } });
    expect((described.data.suggestion as Json).optionsText).toBe("Past Lives\nPerfect Days\nPoor Things");
    expect(typeof described.data.latencyMs).toBe("number");
    expect(described.data.modelAnswers).toBeDefined();

    // The person keeps the options but retitles the poll.
    const input = inputFromData({ type: "choose", title: "Friday film night", optionsText: "Past Lives\nPerfect Days\nPoor Things", suggestionId: result.suggestion.id });
    const poll = createPollWithAdmin(input, cookieJar());
    const savedEvent = store.listEvents({ kind: "poll_created" })[0]!;
    expect(savedEvent.pollSlug).toBe(poll.id);
    expect(savedEvent.data.suggestionId).toBe(result.suggestion.id);
    expect(savedEvent.data.fromDescription).toMatchObject({ eventId: described.id, changed: ["title"], unchanged: false });

    // A malformed id is ignored rather than stored.
    expect(inputFromData({ type: "choose", title: "x", optionsText: "A\nB", suggestionId: "bad id!" }).suggestionId).toBeUndefined();
  });

  test("failed descriptions are logged with the prompt", async () => {
    setAskForTesting(async () => ({ answers: {} }));
    await homeActions.suggest({ request: new Request("http://local.test/?/suggest", { method: "POST", headers: { "x-sveltekit-action": "true" }, body: new URLSearchParams({ prompt: "Hello there" }) }) } as never);
    expect(store.listEvents({ kind: "describe_failed" })[0]!.data).toMatchObject({ prompt: "Hello there", status: 502 });
  });

  test("logging can be switched off", () => {
    process.env.EVENT_LOG = "off";
    logEvent("probe");
    connect().call("create_poll", { type: "majority", title: "Quiet" });
    expect(store.listEvents()).toHaveLength(0);
  });

  test("filters, paging, text search with wildcards, and retention", () => {
    for (let i = 0; i < 5; i += 1) logEvent("client_click", { text: `Button ${i}` }, { pollSlug: i < 3 ? "AAAAAAAAAA" : "BBBBBBBBBB" });
    logEvent("poll_created", { title: "100% done_ish" });
    expect(store.listEvents({ kindPrefix: "client_" })).toHaveLength(5);
    expect(store.listEvents({ pollSlug: "AAAAAAAAAA" })).toHaveLength(3);
    expect(store.listEvents({ text: "100% done_ish" })).toHaveLength(1);
    expect(store.listEvents({ text: "100%x" })).toHaveLength(0);
    expect(store.listEvents({ text: "%" })).toHaveLength(1); // matches the literal percent sign only
    const first = store.listEvents({ limit: 2 });
    expect(store.listEvents({ before: first[1]!.id, limit: 100 }).map((event) => event.id).every((id) => id < first[1]!.id)).toBe(true);
    expect(store.eventSummary().reduce((sum, row) => sum + row.count, 0)).toBe(6);
    expect(store.findEvent("poll_created", "title", "100% done_ish")).not.toBeNull();
    expect(store.pruneEvents(new Date(Date.now() + 1000).toISOString())).toBe(6);
    expect(store.listEvents()).toHaveLength(0);
  });
});

describe("browser events", () => {
  const post = (payload: unknown, raw?: string) => beacon({ request: new Request("http://local.test/api/events", { method: "POST", body: raw ?? JSON.stringify(payload) }) } as never);

  test("only allowed kinds, with paths cleaned of query strings and tokens", async () => {
    runWithContext({ source: "web", path: "/api/events", session: "sessionid1234" }, () => {});
    const response = await runWithContext({ source: "web", path: "/api/events", session: "sessionid1234" }, () =>
      post({
        events: [
          { kind: "click", path: "/poll/4WZegrFSou?admin=SECRET", tag: "button", text: "Open voting", href: "/new?x=1", t: "2026-10-02T10:00:00Z" },
          { kind: "page_view", path: "/", viewportWidth: 390, viewportHeight: 800, touch: true, language: "en-US" },
          { kind: "field_change", path: "/new", tag: "input", name: "title", text: "Title", value: "typed secret" },
          { kind: "evil", path: "/" },
          { kind: "click", path: "https://elsewhere.test/" },
          "junk"
        ]
      })
    );
    expect((await response.json()).accepted).toBe(4);
    const events = store.listEvents({ kindPrefix: "client_" }).reverse();
    expect(events.map((event) => event.kind)).toEqual(["client_click", "client_page_view", "client_field_change", "client_click"]);
    expect(events[0]).toMatchObject({ source: "browser", session: "sessionid1234", pollSlug: "4WZegrFSou", data: { path: "/poll/4WZegrFSou", text: "Open voting", href: "/new" } });
    expect(JSON.stringify(events)).not.toContain("SECRET");
    expect(JSON.stringify(events)).not.toContain("typed secret");
    expect(events[1]!.data).toMatchObject({ viewportWidth: 390, touch: true, language: "en-US" });
  });

  test("nothing is kept from anonymous polls' pages", async () => {
    const agent = connect();
    const anonymous = agent.call("create_poll", { type: "approval", title: "Secret", options: ["A", "B"], settings: { anonymous: true }, open: true });
    const open = agent.call("create_poll", { type: "approval", title: "Public", options: ["A", "B"], open: true });
    const response = await post({ events: [{ kind: "click", path: `/poll/${anonymous.id}`, text: "Vote" }, { kind: "click", path: `/poll/${open.id}`, text: "Vote" }] });
    expect((await response.json()).accepted).toBe(1);
    expect(store.listEvents({ kind: "client_click" }).map((event) => event.pollSlug)).toEqual([open.id]);
  });

  test("bad bodies are refused and batches are capped", async () => {
    expect((await post(null, "{nope")).status).toBe(400);
    expect((await post(null, "x".repeat(41_000))).status).toBe(413);
    const many = await post({ events: Array.from({ length: 80 }, () => ({ kind: "click", path: "/", text: "a" })) });
    expect((await many.json()).accepted).toBe(50);
    expect(cleanPath("/a/b?token=1#x")).toBe("/a/b");
    expect(cleanPath("javascript:alert(1)")).toBe("");
    expect(pollSlugOf("/poll/4WZegrFSou/results")).toBe("4WZegrFSou");
    expect(pollSlugOf("/new")).toBe("");
  });
});

describe("reading the log", () => {
  const url = (path: string) => new URL(`${ORIGIN}${path}`);
  const asOperator = () => cookieJar({ [OPERATOR_COOKIE]: OPERATOR });

  test("only the operator sees the page and the downloads", async () => {
    process.env.OPERATOR_TOKEN = OPERATOR;
    logEvent("describe", { prompt: "Which film: A, B or C?" });
    logEvent("poll_created", { title: "Needle" });

    const denied = () => eventsLoad({ url: url("/events"), cookies: cookieJar() } as never);
    expect(denied).toThrow();
    try {
      denied();
    } catch (error) {
      expect((error as { status: number }).status).toBe(404);
    }
    expect(() => exportJson({ url: url("/events/export.json"), cookies: cookieJar() } as never)).toThrow();
    expect(() => exportCsv({ url: url("/events/export.csv"), cookies: cookieJar() } as never)).toThrow();

    const page = eventsLoad({ url: url("/events?text=Needle"), cookies: asOperator() } as never) as Json;
    expect(page.events.map((event: Json) => event.kind)).toEqual(["poll_created"]);
    expect(page.summary[0]).toMatchObject({ kind: "poll_created", count: 1 });

    // Signing in with the token in the URL sets the cookie and redirects without it.
    const jar = cookieJar();
    try {
      eventsLoad({ url: url(`/events?admin=${OPERATOR}`), cookies: jar } as never);
    } catch (error) {
      expect(error).toMatchObject({ status: 303, location: "/events" });
    }
    expect(jar.get(OPERATOR_COOKIE)).toBe(OPERATOR);

    const json = await (exportJson({ url: url("/events/export.json?kindPrefix=describe"), cookies: asOperator() } as never) as Response).json();
    expect(json.events).toHaveLength(1);
    expect(json.events[0].data.prompt).toBe("Which film: A, B or C?");
    const csv = await (exportCsv({ url: url("/events/export.csv"), cookies: asOperator() } as never) as Response).text();
    expect(csv.split("\n")[0]).toBe("id,ts,kind,source,poll_slug,session,data_json");
    expect(csv).toContain('"{""prompt"":""Which film: A, B or C?""}"');
  });

  test("agents read it through MCP only as the operator", () => {
    process.env.OPERATOR_TOKEN = OPERATOR;
    logEvent("describe", { prompt: "hello" });
    const stranger = connect();
    expect(stranger.raw("get_usage_events").isError).toBe(true);
    expect(stranger.raw("get_usage_events").content[0].text).toContain("operator");

    const operator = connect({ bearer: OPERATOR });
    const result = operator.call("get_usage_events", { kind: "describe" });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].data.prompt).toBe("hello");
    expect(result.next).toBeNull();
    expect(result.summary[0]).toMatchObject({ kind: "describe", count: 1 });

    for (let i = 0; i < 3; i += 1) logEvent("page", { i });
    const first = operator.call("get_usage_events", { kind: "page", limit: 2 });
    expect(first.events).toHaveLength(2);
    const second = operator.call("get_usage_events", { kind: "page", limit: 2, before: first.next });
    expect(second.events).toHaveLength(1);
    expect(second.next).toBeNull();
  });
});

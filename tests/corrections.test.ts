import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cookies } from "@sveltejs/kit";
import type { Store } from "../src/db";
import { createPollWithAdmin, inputFromData, OPERATOR_COOKIE, resetStoreForTesting, updateDraftOrThrow, openPollOrThrow, getStore } from "../src/lib/server/app";
import { runWithContext } from "../src/lib/server/context";
import { correctionRows, correctionStats, trainingJsonl } from "../src/lib/server/corrections";
import { logEvent } from "../src/lib/server/events";
import { handleMcp, resetSessionsForTesting } from "../src/lib/server/mcp/server";
import { load as correctionsLoad } from "../src/routes/events/corrections/+page.server";
import { GET as exportJsonl } from "../src/routes/events/corrections/export.jsonl/+server";
import { suggestionChanges } from "../src/lib/suggestionDiff";
import { defaultConfigFor } from "../src/templates";

const OPERATOR = "operator-secret-for-tests";
let dir = "";
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poll-corrections-"));
  store = resetStoreForTesting(join(dir, "test.sqlite"));
  resetSessionsForTesting();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.OPERATOR_TOKEN;
});

function cookieJar(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { get: (name: string) => values.get(name), getAll: () => [...values].map(([name, value]) => ({ name, value })), set: (name: string, value: string) => void values.set(name, value), delete: (name: string) => void values.delete(name) } as unknown as Cookies;
}

/** Records a description the way the home page does. */
function describeAs(session: string, id: string, prompt: string, suggestion: Record<string, unknown>, probabilities: Record<string, number> = { [String(suggestion.type)]: 1 }, provider = "jev") {
  runWithContext({ source: "web", path: "/", session }, () =>
    logEvent("describe", {
      suggestionId: id,
      prompt,
      suggestion: { id, confidence: probabilities[String(suggestion.type)] ?? 1, alternatives: [], config: {}, optionsText: null, notes: [], ...suggestion },
      modelAnswers: { type: { type: "choice", choice: suggestion.type, probabilities } },
      provider,
      model: "test-model"
    })
  );
}

const save = (data: Record<string, unknown>) => createPollWithAdmin(inputFromData(data), cookieJar());

describe("field-level corrections", () => {
  const choose = defaultConfigFor("choose");

  test("type, title and options, with what moved", () => {
    const saved = { type: "approval" as const, title: "Where to eat?", config: defaultConfigFor("approval"), options: [{ label: "Nopa", meaning: "" }, { label: "Zuni", meaning: "" }] };
    const jev = { type: "choose" as const, title: "Where to eat", optionsText: "Nopa\nSouvla\nZuni", config: {} };
    const changes = suggestionChanges(jev, saved);
    expect(changes.map((change) => change.field)).toEqual(["type", "title", "options"]);
    expect(changes[2]).toMatchObject({ jev: ["Nopa", "Souvla", "Zuni"], final: ["Nopa", "Zuni"], detail: { added: [], removed: ["Souvla"], reordered: false } });
    // Switching method makes the settings incomparable, so only the method is reported for them.
    expect(changes.some((change) => change.field.startsWith("config."))).toBe(false);
  });

  test("settings Jev set wrongly versus settings it missed", () => {
    const saved = { type: "choose" as const, title: "T", config: { ...choose, maxChoices: 3, anonymous: true }, options: [{ label: "A", meaning: "" }, { label: "B", meaning: "" }] };
    const changes = suggestionChanges({ type: "choose", title: "T", optionsText: "A\nB", config: { maxChoices: 2 } }, saved);
    expect(changes).toHaveLength(2);
    expect(changes).toContainEqual({ field: "config.maxChoices", jev: 2, final: 3, jevSet: true });
    expect(changes).toContainEqual({ field: "config.anonymous", jev: false, final: true, jevSet: false });
  });

  test("placeholder rows only count when the number was wrong, and a reorder is flagged", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Name ${i}`, meaning: "" }));
    const base = { type: "choose" as const, title: "T", config: choose };
    expect(suggestionChanges({ ...base, optionsText: "Option A\nOption B\nOption C", config: {} }, { ...base, options: rows(3) })).toEqual([]);
    expect(suggestionChanges({ ...base, optionsText: "Option A\nOption B\nOption C", config: {} }, { ...base, options: rows(5) })).toEqual([{ field: "optionCount", jev: 3, final: 5 }]);
    const reorder = suggestionChanges({ ...base, optionsText: "A\nB", config: {} }, { ...base, options: [{ label: "B", meaning: "" }, { label: "A", meaning: "" }] });
    expect(reorder[0]).toMatchObject({ field: "options", detail: { reordered: true } });
    // Nothing is claimed about options Jev did not provide, nor about time-poll slots.
    expect(suggestionChanges({ ...base, optionsText: null, config: {} }, { ...base, options: rows(2) })).toEqual([]);
    expect(suggestionChanges({ type: "time_poll", title: "T", optionsText: "x", config: {} }, { type: "time_poll", title: "T", config: defaultConfigFor("time_poll"), options: rows(2) })).toEqual([]);
  });
});

describe("what became of each description", () => {
  function scenario() {
    // 1. Kept exactly as Jev filled it in.
    describeAs("sess-accept", "acceptedAAAA1", "Which film: Past Lives or Poor Things?", { type: "choose", title: "Which film", optionsText: "Past Lives\nPoor Things" }, { choose: 0.97, approval: 0.03 });
    save({ type: "choose", title: "Which film", optionsText: "Past Lives\nPoor Things", suggestionId: "acceptedAAAA1" });

    // 2. Method switched to the close second, an option dropped, anonymity missed; edited again as a draft and opened.
    describeAs("sess-fix", "correctedBBBB2", "Where should we eat? Nopa, Souvla or Zuni. Keep it secret.", { type: "choose", title: "Where should we eat", optionsText: "Nopa\nSouvla\nZuni", alternatives: [{ type: "approval", label: "Approval", percent: 35 }] }, { choose: 0.62, approval: 0.35, rank: 0.03 });
    const poll = save({ type: "choose", title: "Where should we eat", optionsText: "Nopa\nSouvla\nZuni", suggestionId: "correctedBBBB2" });
    const jar = cookieJar();
    const created = getStore().getPollBySlug(poll.id)!;
    const asAdmin = cookieJar({ [`poll_${created.id}_admin_token`]: poll.adminToken });
    updateDraftOrThrow(created, inputFromData({ type: "approval", title: "Where should we eat?", optionsText: "Nopa\nZuni", anonymous: "on" }), asAdmin);
    openPollOrThrow(poll.id, asAdmin);
    void jar;

    // 3. Typed a better description straight away.
    describeAs("sess-retry", "rephrasedCCCC3", "do the thing", { type: "majority", title: "do the thing" }, { majority: 0.5, consent: 0.5 });
    describeAs("sess-retry", "retriedDDDDD4", "Should we adopt the thing?", { type: "majority", title: "Should we adopt the thing?" });

    // 4. Never came back.
    describeAs("sess-gone", "abandonedEEE5", "Elect two people", { type: "stv", title: "Elect two people" });
  }

  test("accepted, corrected, rephrased, abandoned and pending", () => {
    scenario();
    const later = Date.now() + 3 * 3_600_000;
    const rows = Object.fromEntries(correctionRows({ now: later }).map((row) => [row.suggestionId, row]));

    expect(rows.acceptedAAAA1).toMatchObject({ outcome: "accepted", changes: [], opened: false, final: { type: "choose" } });

    const fixed = rows.correctedBBBB2!;
    expect(fixed.outcome).toBe("corrected");
    expect(fixed.opened).toBe(true);
    expect(fixed.pickedAlternative).toBe(true);
    expect(fixed.final).toMatchObject({ type: "approval", title: "Where should we eat?" });
    expect(fixed.changes.map((change) => change.field)).toEqual(["type", "title", "options"]);
    expect(fixed.jev.probabilities).toEqual({ choose: 0.62, approval: 0.35, rank: 0.03 });

    expect(rows.rephrasedCCCC3).toMatchObject({ outcome: "rephrased", rephrasedTo: "Should we adopt the thing?", final: null });
    expect(rows.retriedDDDDD4!.outcome).toBe("abandoned");
    expect(rows.abandonedEEE5!.outcome).toBe("abandoned");
    // Judged soon after, an unsaved description is still in progress.
    expect(correctionRows({ now: Date.now() }).find((row) => row.suggestionId === "abandonedEEE5")!.outcome).toBe("pending");
  });

  test("statistics: acceptance, fields, confusions and calibration", () => {
    scenario();
    const stats = correctionStats(correctionRows({ now: Date.now() + 3 * 3_600_000 }));
    expect(stats.descriptions).toBe(5);
    expect(stats.outcomes).toEqual({ accepted: 1, corrected: 1, rephrased: 1, abandoned: 2, pending: 0 });
    expect(stats.acceptedShare).toBe(0.5);
    expect(stats.fieldCorrections.map((row) => [row.field, row.count])).toEqual([["type", 1], ["title", 1], ["options", 1]]);
    expect(stats.typeConfusions).toEqual([{ jev: "choose", final: "approval", count: 1 }]);
    expect(stats.providers).toEqual([expect.objectContaining({ provider: "jev", descriptions: 5, saved: 2, acceptedShare: 0.5, typeKeptShare: 0.5 })]);
    expect(stats.calibration.find((row) => row.bucket === "95%+")).toMatchObject({ saved: 1, typeKept: 1, typeKeptShare: 1 });
    expect(stats.calibration.find((row) => row.bucket === "60-80%")).toMatchObject({ saved: 1, typeKept: 0, typeKeptShare: 0 });
  });

  test("the training export pairs prompts with corrected labels", () => {
    scenario();
    const lines = trainingJsonl(correctionRows({ now: Date.now() + 3 * 3_600_000 })).split("\n").map((line) => JSON.parse(line));
    const fixed = lines.find((line) => line.id === "correctedBBBB2");
    expect(fixed).toMatchObject({
      prompt: "Where should we eat? Nopa, Souvla or Zuni. Keep it secret.",
      outcome: "corrected",
      jev: { type: "choose", confidence: 0.62, probabilities: { choose: 0.62, approval: 0.35, rank: 0.03 } },
      labels: { type: "approval", title: "Where should we eat?", options: ["Nopa", "Zuni"], opened: true },
      pickedAlternative: true
    });
    expect(fixed.labels.config.anonymous).toBe(true);
    expect(lines.find((line) => line.id === "abandonedEEE5").labels).toBeNull();
    // No tokens in the export.
    expect(JSON.stringify(lines)).not.toContain("adminToken");
  });
});

describe("comparing models", () => {
  test("rows carry the model that read them, and the summary compares models", () => {
    describeAs("s1", "cmpClefAAAA1", "Which film: A or B?", { type: "choose", title: "Which film", optionsText: "A\nB" }, { choose: 0.9 }, "clef");
    save({ type: "choose", title: "Which film", optionsText: "A\nB", suggestionId: "cmpClefAAAA1" });
    describeAs("s2", "cmpJevBBBBB2", "Where? X or Y", { type: "choose", title: "Where", optionsText: "X\nY" }, { choose: 0.6 }, "jev");
    save({ type: "approval", title: "Where", optionsText: "X\nY", suggestionId: "cmpJevBBBBB2" });
    // Events logged before models were recorded are treated as Jev's.
    runWithContext({ source: "web", path: "/", session: "old" }, () => logEvent("describe", { suggestionId: "legacyCCCCC3", prompt: "old", suggestion: { type: "majority", title: "old", config: {}, optionsText: null, confidence: 1, alternatives: [] } }));

    const rows = correctionRows({ now: Date.now() });
    expect(Object.fromEntries(rows.map((row) => [row.suggestionId, row.provider]))).toEqual({ cmpClefAAAA1: "clef", cmpJevBBBBB2: "jev", legacyCCCCC3: "jev" });
    const stats = correctionStats(rows);
    expect(stats.providers.map((row) => row.provider)).toEqual(["clef", "jev"]);
    expect(stats.providers[0]).toMatchObject({ provider: "clef", saved: 1, acceptedShare: 1, typeKeptShare: 1 });
    expect(stats.providers[1]).toMatchObject({ provider: "jev", descriptions: 2, saved: 1, acceptedShare: 0, typeKeptShare: 0 });
    expect(JSON.parse(trainingJsonl(rows).split("\n")[0]!).provider).toBeDefined();
  });
});

describe("reading corrections", () => {
  const url = (path: string) => new URL(`https://poll.test${path}`);

  test("operator only, on the page, the download and over MCP", async () => {
    process.env.OPERATOR_TOKEN = OPERATOR;
    describeAs("sess-1", "pageTestAAAA1", "Which film: A or B?", { type: "choose", title: "Which film", optionsText: "A\nB" });
    save({ type: "choose", title: "Which film", optionsText: "A\nB", suggestionId: "pageTestAAAA1" });

    expect(() => correctionsLoad({ url: url("/events/corrections"), cookies: cookieJar() } as never)).toThrow();
    expect(() => exportJsonl({ url: url("/events/corrections/export.jsonl"), cookies: cookieJar() } as never)).toThrow();

    const operator = cookieJar({ [OPERATOR_COOKIE]: OPERATOR });
    const page = correctionsLoad({ url: url("/events/corrections"), cookies: operator } as never) as { stats: { outcomes: Record<string, number> }; rows: unknown[] };
    expect(page.stats.outcomes.accepted).toBe(1);
    const onlyCorrected = correctionsLoad({ url: url("/events/corrections?outcome=corrected"), cookies: operator } as never) as { rows: unknown[] };
    expect(onlyCorrected.rows).toHaveLength(0);

    const download = exportJsonl({ url: url("/events/corrections/export.jsonl?saved=1"), cookies: operator } as never) as Response;
    expect(download.headers.get("content-type")).toContain("ndjson");
    expect(JSON.parse((await download.text()).split("\n")[0]!).labels.type).toBe("choose");

    const call = (bearer: string, args: Record<string, unknown>) => {
      const init = handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }), { origin: "https://poll.test", sessionId: null, bearer, limit: null });
      const reply = handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_jev_corrections", arguments: args } }), { origin: "https://poll.test", sessionId: init.sessionId ?? null, bearer, limit: null });
      return (reply.body as { result: Record<string, any> }).result;
    };
    expect(call("", {}).isError).toBe(true);
    const result = call(OPERATOR, {}).structuredContent;
    expect(result.statistics.outcomes.accepted).toBe(1);
    expect(result.rows[0].prompt).toBe("Which film: A or B?");
    expect(call(OPERATOR, { format: "jsonl" }).structuredContent.jsonl).toContain("pageTestAAAA1");
  });
});

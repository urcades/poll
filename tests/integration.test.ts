import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POST as createPollRoute } from "../src/routes/api/polls/+server";
import { POST as editPollRoute } from "../src/routes/api/polls/[id]/+server";
import { POST as openPollRoute } from "../src/routes/api/polls/[id]/open/+server";
import { POST as closePollRoute } from "../src/routes/api/polls/[id]/close/+server";
import { POST as voteRoute } from "../src/routes/api/polls/[id]/votes/+server";
import { GET as exportCsvRoute } from "../src/routes/poll/[id]/export.csv/+server";
import { GET as exportJsonRoute } from "../src/routes/poll/[id]/export.json/+server";
import { actions as pollActions, load as pollLoad } from "../src/routes/poll/[id]/+page.server";
import { load as homeLoad } from "../src/routes/+page.server";
import { deletePollOrThrow, resetStoreForTesting, tallyFor } from "../src/lib/server/app";
import { deriveInviteToken, hashToken } from "../src/db";
import { POST as inviteesRoute } from "../src/routes/api/polls/[id]/invitees/+server";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Store as StoreClass } from "../src/db";
import { templates } from "../src/templates";
import type { Store } from "../src/db";

let cleanupPaths: string[] = [];
let store: Store | null = null;

type CookieJar = {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  getAll(): Array<{ name: string; value: string }>;
};

const SLUG_PATTERN = /^[0-9A-Za-z]{10}$/;

/** Internal integer id for a public slug (for store methods keyed by id). */
function pid(db: Store, slug: string): number {
  const poll = db.getPollBySlug(slug);
  if (!poll) throw new Error(`no poll ${slug}`);
  return poll.id;
}

function cookieJar(): CookieJar {
  const jar = new Map<string, string>();
  return {
    get: (name) => jar.get(name),
    set: (name, value) => {
      jar.set(name, value);
    },
    getAll: () => [...jar].map(([name, value]) => ({ name, value }))
  };
}

let cookies = cookieJar();

afterEach(() => {
  store?.close();
  store = null;
  cookies = cookieJar();
  for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
  cleanupPaths = [];
});

function storeFixture(): Store {
  const dir = mkdtempSync(join(tmpdir(), "loomio-lite-"));
  cleanupPaths.push(dir);
  store = resetStoreForTesting(join(dir, "test.sqlite"));
  return store;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://local.test", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body)
  });
}

async function postJson(handler: Function, params: Record<string, string>, body: unknown, jar: CookieJar = cookies): Promise<Response> {
  return await handler({ params, request: jsonRequest(body), cookies: jar });
}

async function createPoll(overrides: Record<string, unknown> = {}) {
  const response = await postJson(createPollRoute, {}, {
    type: "choose",
    title: "Dinner",
    details: "Pick a place",
    optionsText: "Pizza\nSushi\nTacos",
    ...overrides
  });
  expect(response.status).toBe(200);
  return await response.json() as { id: string; adminToken: string };
}

async function openPoll(id: string) {
  const response = await postJson(openPollRoute, { id: String(id) }, {});
  expect(response.status).toBe(200);
}

async function closePoll(id: string) {
  const response = await postJson(closePollRoute, { id: String(id) }, {});
  expect(response.status).toBe(200);
}

async function getExport(handler: Function, id: string, jar: CookieJar = cookies, adminToken = ""): Promise<Response> {
  return await handler({
    params: { id: String(id) },
    url: new URL(`http://local.test/poll/${id}/export${adminToken ? `?admin=${encodeURIComponent(adminToken)}` : ""}`),
    cookies: jar
  } as never);
}

async function loadPoll(id: string, jar: CookieJar = cookies, search = "") {
  return await pollLoad({
    params: { id: String(id) },
    url: new URL(`http://local.test/poll/${id}${search}`),
    cookies: jar
  } as never);
}

describe("SvelteKit app integration", () => {
  test("creates each template as a draft", async () => {
    const db = storeFixture();
    for (const template of templates) {
      const result = await createPoll({
        type: template.type,
        title: template.label,
        optionsText: template.defaultOptions.map((option) => option.label).join("\n"),
        seats: template.type === "stv" ? 1 : undefined
      });
      expect(result.id).toMatch(SLUG_PATTERN);
      expect(db.getPollBySlug(result.id)?.status).toBe("draft");
    }
    expect(db.listPolls()).toHaveLength(templates.length);
  });

  test("drafts can be edited, previewed, opened, and closed", async () => {
    const db = storeFixture();
    const { id } = await createPoll({ title: "Draft dinner" });
    let page = await loadPoll(id);
    expect(page.poll.status).toBe("draft");
    expect(page.showResults).toBe(false);

    const edit = await postJson(editPollRoute, { id: String(id) }, {
      type: "approval",
      title: "Edited dinner",
      details: "Updated",
      optionsText: "Pizza\nSushi"
    });
    expect(edit.status).toBe(200);
    expect(db.getPollBySlug(id)?.type).toBe("approval");
    expect(db.getOptions(pid(db, id))).toHaveLength(2);

    await openPoll(id);
    expect(db.getPollBySlug(id)?.status).toBe("open");
    page = await loadPoll(id);
    expect(page.poll.status).toBe("open");
    expect(page.options.map((option) => option.label)).toEqual(["Pizza", "Sushi"]);

    await closePoll(id);
    expect(db.getPollBySlug(id)?.status).toBe("closed");
    expect((await loadPoll(id)).showResults).toBe(true);
  });

  test("rejects poll setup constraints that conflict with option count or fixed semantics", async () => {
    storeFixture();

    let response = await postJson(createPollRoute, {}, {
      type: "rank",
      title: "Bad rank",
      optionsText: "A\nB\nC",
      rankCount: 5
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Number of ranked choices cannot exceed the number of options." });

    response = await postJson(createPollRoute, {}, {
      type: "choose",
      title: "Bad choose",
      optionsText: "A\nB",
      minChoices: 1,
      maxChoices: 3
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Maximum choices cannot exceed the number of options." });

    response = await postJson(createPollRoute, {}, {
      type: "stv",
      title: "Bad STV",
      optionsText: "A\nB",
      seats: 2
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "STV seats must be less than the number of candidates." });

    response = await postJson(createPollRoute, {}, {
      type: "majority",
      title: "Bad majority",
      optionsText: "Maybe\nNo"
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain("fixed voting positions");
  });

  test("submits and updates a vote by display name", async () => {
    const db = storeFixture();
    const { id } = await createPoll();
    await openPoll(id);
    const options = db.getOptions(pid(db, id));
    await postJson(voteRoute, { id: String(id) }, {
      voterName: "Ada",
      selected: [String(options[0]!.id)],
      reason: "First"
    });
    await postJson(voteRoute, { id: String(id) }, {
      voterName: "Ada",
      selected: [String(options[1]!.id)],
      reason: "Updated"
    });
    const votes = db.getVotes(pid(db, id));
    expect(votes).toHaveLength(1);
    expect(votes[0]!.reason).toBe("Updated");
    expect((votes[0]!.ballot as { selected: number[] }).selected).toEqual([options[1]!.id]);
  });

  test("hide-results behavior before vote, after vote, and after close", async () => {
    const db = storeFixture();
    const { id } = await createPoll({ hideResults: "after_vote" });
    await openPoll(id);
    expect((await loadPoll(id)).showResults).toBe(false);

    const options = db.getOptions(pid(db, id));
    await postJson(voteRoute, { id: String(id) }, { voterName: "Ada", selected: [String(options[0]!.id)] });
    expect((await loadPoll(id)).showResults).toBe(true);

    // Someone who merely guesses a voter's name (no edit-token cookie) gets nothing.
    const stranger = cookieJar();
    expect((await loadPoll(id, stranger)).showResults).toBe(false);

    const closedHidden = await createPoll({ title: "Closed hidden", hideResults: "after_close" });
    await openPoll(closedHidden.id);
    expect((await loadPoll(closedHidden.id)).showResults).toBe(false);
    await closePoll(closedHidden.id);
    expect((await loadPoll(closedHidden.id)).showResults).toBe(true);
  });

  test("non-admins cannot edit, open, close, or export a poll", async () => {
    const db = storeFixture();
    const { id, adminToken: token } = await createPoll();
    const stranger = cookieJar();

    const editDenied = await postJson(editPollRoute, { id: String(id) }, {
      type: "choose",
      title: "Hijacked",
      optionsText: "A\nB"
    }, stranger);
    expect(editDenied.status).toBe(403);

    expect((await postJson(openPollRoute, { id: String(id) }, {}, stranger)).status).toBe(400);
    await openPoll(id);
    expect(db.getPollBySlug(id)?.status).toBe("open");

    expect((await postJson(closePollRoute, { id: String(id) }, {}, stranger)).status).toBe(400);
    expect(db.getPollBySlug(id)?.status).toBe("open");
    await closePoll(id);

    expect((await getExport(exportJsonRoute, id, stranger)).status).toBe(403);
    expect((await getExport(exportCsvRoute, id, stranger)).status).toBe(403);
    expect((await getExport(exportJsonRoute, id)).status).toBe(200);

    // A valid ?admin= token in the URL grants access without the cookie.
    expect((await getExport(exportJsonRoute, id, cookieJar(), token)).status).toBe(200);

    // Non-admin page loads hide the admin controls and link.
    const page = await loadPoll(id, stranger);
    expect(page.isAdmin).toBe(false);
    expect(page.adminLink).toBeNull();
    expect(JSON.stringify(page)).not.toContain(token);
  });

  test("hidden results and voter data never reach the page payload", async () => {
    const db = storeFixture();
    const { id } = await createPoll({ hideResults: "after_close" });
    await openPoll(id);
    const options = db.getOptions(pid(db, id));
    await postJson(voteRoute, { id: String(id) }, { voterName: "Ada", selected: [String(options[0]!.id)], reason: "Secret" });

    // A different browser sees no voter data; the voter sees only their own vote.
    const stranger = cookieJar();
    const page = await loadPoll(id, stranger);
    expect(page.showResults).toBe(false);
    expect(page.tally).toBeNull();
    expect(page.voteCount).toBe(1);
    expect(JSON.stringify(page)).not.toContain("Secret");

    const ownPage = await loadPoll(id);
    expect(ownPage.viewerVote?.reason).toBe("Secret");
    expect(ownPage.tally).toBeNull();

    await closePoll(id);
    const closedPage = await loadPoll(id);
    expect(closedPage.tally).not.toBeNull();
  });

  test("a different browser cannot replace an existing vote by reusing the name", async () => {
    const db = storeFixture();
    const { id } = await createPoll();
    await openPoll(id);
    const options = db.getOptions(pid(db, id));
    const ada = cookieJar();
    await postJson(voteRoute, { id: String(id) }, { voterName: "Ada", selected: [String(options[0]!.id)] }, ada);

    const impostor = cookieJar();
    const rejected = await postJson(voteRoute, { id: String(id) }, { voterName: "Ada", selected: [String(options[1]!.id)] }, impostor);
    expect(rejected.status).toBe(400);
    expect((db.getVotes(pid(db, id))[0]!.ballot as { selected: number[] }).selected).toEqual([options[0]!.id]);

    // The original browser can still update its own vote.
    const updated = await postJson(voteRoute, { id: String(id) }, { voterName: "Ada", selected: [String(options[2]!.id)] }, ada);
    expect(updated.status).toBe(200);
    expect((db.getVotes(pid(db, id))[0]!.ballot as { selected: number[] }).selected).toEqual([options[2]!.id]);
  });

  test("rejects oversized fields", async () => {
    const db = storeFixture();
    let response = await postJson(createPollRoute, {}, {
      type: "choose",
      title: "x".repeat(201),
      optionsText: "A\nB"
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain("too long");

    const { id } = await createPoll();
    await openPoll(id);
    const options = db.getOptions(pid(db, id));
    response = await postJson(voteRoute, { id: String(id) }, {
      voterName: "x".repeat(81),
      selected: [String(options[0]!.id)]
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain("too long");
  });

  test("csv export neutralizes spreadsheet formula payloads", async () => {
    const db = storeFixture();
    const { id } = await createPoll();
    await openPoll(id);
    const options = db.getOptions(pid(db, id));
    await postJson(voteRoute, { id: String(id) }, {
      voterName: "=HYPERLINK(evil)",
      selected: [String(options[0]!.id)],
      reason: "+SUM(A1:A9)"
    });
    await closePoll(id);
    const csv = await (await getExport(exportCsvRoute, id)).text();
    expect(csv).toContain("\"'=HYPERLINK(evil)\"");
    expect(csv).toContain("\"'+SUM(A1:A9)\"");
  });

  test("reason required and disabled validation", async () => {
    const db = storeFixture();
    const required = await createPoll({ title: "Required", reasonMode: "required" });
    await openPoll(required.id);
    const options = db.getOptions(pid(db, required.id));
    const bad = await postJson(voteRoute, { id: String(required.id) }, { voterName: "Ada", selected: [String(options[0]!.id)] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "A reason is required." });

    const disabled = await createPoll({ title: "Disabled", reasonMode: "disabled" });
    await openPoll(disabled.id);
    const disabledOptions = db.getOptions(pid(db, disabled.id));
    const good = await postJson(voteRoute, { id: String(disabled.id) }, {
      voterName: "Ben",
      selected: [String(disabledOptions[0]!.id)],
      reason: "Ignored"
    });
    expect(good.status).toBe(200);
    expect(db.getVotes(pid(db, disabled.id))[0]!.reason).toBe("");
  });

  test("vote reasons are not capped", async () => {
    const db = storeFixture();
    const { id } = await createPoll({ reasonMode: "optional" });
    await openPoll(id);
    const options = db.getOptions(pid(db, id));
    const longReason = "Long reason. ".repeat(200);
    const response = await postJson(voteRoute, { id: String(id) }, {
      voterName: "Ada",
      selected: [String(options[0]!.id)],
      reason: longReason
    });
    expect(response.status).toBe(200);
    expect(db.getVotes(pid(db, id))[0]!.reason).toBe(longReason.trim());
  });

  test("exports are available only after close and redact anonymous voters", async () => {
    const db = storeFixture();
    const { id } = await createPoll({ anonymous: true });
    await openPoll(id);
    let response = await getExport(exportJsonRoute, id);
    expect(response.status).toBe(400);

    const options = db.getOptions(pid(db, id));
    await postJson(voteRoute, { id: String(id) }, {
      voterName: "Ada",
      selected: [String(options[0]!.id)],
      reason: "Private"
    });
    await closePoll(id);

    response = await getExport(exportJsonRoute, id);
    expect(response.status).toBe(200);
    const json = await response.json() as { votes: Array<{ voterName: string; reason: string; updatedAt: string }> };
    expect(json.votes[0]).toEqual(expect.objectContaining({ voterName: "Voter 1", reason: "", updatedAt: "" }));

    const csv = await (await getExport(exportCsvRoute, id)).text();
    expect(csv).toContain('"Voter 1"');
    expect(csv).not.toContain("Ada");
    expect(csv).not.toContain("Private");
  });

  test("polls past their scheduled close read as closed in the database", async () => {
    const db = storeFixture();
    const { id } = await createPoll({ closesAt: new Date(Date.now() - 60_000).toISOString() });
    await openPoll(id);
    const poll = db.getPollBySlug(id);
    expect(poll?.status).toBe("closed");
    expect(poll?.closedAt).toBeTruthy();
  });

  test("admin links grant a cookie and then redirect to the clean poll URL", async () => {
    const db = storeFixture();
    const { id, adminToken: token } = await createPoll();
    const device = cookieJar();

    let thrown: unknown;
    try {
      await loadPoll(id, device, `?admin=${encodeURIComponent(token)}`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ status: 303, location: `/poll/${id}` });
    expect((await loadPoll(id, device)).isAdmin).toBe(true);

    // A bad token still strips the query string but grants nothing.
    const guesser = cookieJar();
    await expect(loadPoll(id, guesser, "?admin=nope")).rejects.toMatchObject({ status: 303 });
    expect((await loadPoll(id, guesser)).isAdmin).toBe(false);
  });

  test("legacy polls without an admin token are managed only by the operator", async () => {
    const db = storeFixture();
    const { id } = await createPoll();
    db.db.query("UPDATE polls SET admin_token_hash = '' WHERE id = ?").run(pid(db, id));

    const stranger = cookieJar();
    expect(() => deletePollOrThrow(id, stranger as never)).toThrow("Only the poll admin");
    expect((await loadPoll(id, stranger)).isAdmin).toBe(false);

    const previous = process.env.OPERATOR_TOKEN;
    process.env.OPERATOR_TOKEN = "operator-secret";
    try {
      const operator = cookieJar();
      await expect(loadPoll(id, operator, "?admin=operator-secret")).rejects.toMatchObject({ status: 303 });
      expect((await loadPoll(id, operator)).isAdmin).toBe(true);
      deletePollOrThrow(id, operator as never);
      expect(db.getPollBySlug(id)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.OPERATOR_TOKEN;
      else process.env.OPERATOR_TOKEN = previous;
    }
  });

  test("rejects invalid open/close dates instead of crashing", async () => {
    storeFixture();
    const response = await postJson(createPollRoute, {}, {
      type: "choose",
      title: "Bad date",
      optionsText: "A\nB",
      closesAt: "not-a-date"
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("Invalid date");
  });

  test("only the admin can delete a poll, and deletion cascades", async () => {
    const db = storeFixture();
    const { id } = await createPoll();
    await openPoll(id);
    const options = db.getOptions(pid(db, id));
    await postJson(voteRoute, { id: String(id) }, { voterName: "Ada", selected: [String(options[0]!.id)] });

    const internalId = pid(db, id);
    const stranger = cookieJar();
    expect(() => deletePollOrThrow(id, stranger as never)).toThrow("Only the poll admin");
    expect(db.getPollBySlug(id)).not.toBeNull();

    deletePollOrThrow(id, cookies as never);
    expect(db.getPollBySlug(id)).toBeNull();
    expect(db.getOptions(internalId)).toEqual([]);
    expect(db.getVotes(internalId)).toEqual([]);
  });

  test("approval and IRV can be opened, voted, closed, and exported", async () => {
    const db = storeFixture();
    const approval = await createPoll({ type: "approval", title: "Approval", optionsText: "A\nB\nC" });
    await openPoll(approval.id);
    let options = db.getOptions(pid(db, approval.id));
    await postJson(voteRoute, { id: String(approval.id) }, {
      voterName: "Ada",
      selected: [String(options[0]!.id), String(options[1]!.id)]
    });
    await closePoll(approval.id);
    expect(await (await getExport(exportCsvRoute, approval.id)).text()).toContain("Approval");

    const irv = await createPoll({ type: "irv", title: "IRV", optionsText: "A\nB\nC" });
    await openPoll(irv.id);
    options = db.getOptions(pid(db, irv.id));
    await postJson(voteRoute, { id: String(irv.id) }, {
      voterName: "Ada",
      rank_1: String(options[0]!.id),
      rank_2: String(options[1]!.id)
    });
    await closePoll(irv.id);
    const page = await loadPoll(irv.id);
    expect(page.tally?.roundLogs?.length).toBeGreaterThan(0);
    expect(await (await getExport(exportJsonRoute, irv.id)).text()).toContain('"IRV"');
  });

  test("numeric internal ids never resolve as public poll ids", async () => {
    const db = storeFixture();
    const { id } = await createPoll();
    const internal = String(pid(db, id));
    expect(db.getPollBySlug(internal)).toBeNull();
    await expect(loadPoll(internal)).rejects.toMatchObject({ status: 404 });
    expect((await postJson(voteRoute, { id: internal }, { voterName: "Ada" })).status).toBe(404);
    expect((await postJson(editPollRoute, { id: internal }, { type: "choose", title: "x", optionsText: "A\nB" })).status).toBe(404);
    expect((await postJson(openPollRoute, { id: internal }, {})).status).toBe(400);
    expect((await getExport(exportJsonRoute, internal)).status).toBe(404);
    expect((await getExport(exportCsvRoute, internal)).status).toBe(404);
    // The slug itself works.
    expect((await loadPoll(id)).poll.slug).toBe(id);
  });

  test("slugs are 10-char base62 and unique", async () => {
    const db = storeFixture();
    const slugs = new Set<string>();
    for (let index = 0; index < 50; index++) {
      const { id } = await createPoll({ title: `Poll ${index}` });
      expect(id).toMatch(SLUG_PATTERN);
      slugs.add(id);
    }
    expect(slugs.size).toBe(50);
    expect(db.listPolls().every((poll) => SLUG_PATTERN.test(poll.slug))).toBe(true);
    expect(() => db.db.query("UPDATE polls SET slug = (SELECT slug FROM polls LIMIT 1) WHERE id = (SELECT MAX(id) FROM polls)").run()).toThrow();
    // Export filenames use the slug too.
    const { id } = await createPoll();
    await openPoll(id);
    await closePoll(id);
    expect((await getExport(exportJsonRoute, id)).headers.get("content-disposition")).toContain(`poll-${id}.json`);
    expect((await getExport(exportCsvRoute, id)).headers.get("content-disposition")).toContain(`poll-${id}.csv`);
  });

  test("the database stores token hashes, not plaintext", async () => {
    const db = storeFixture();
    const { id, adminToken } = await createPoll();
    await openPoll(id);
    const options = db.getOptions(pid(db, id));
    await postJson(voteRoute, { id }, { voterName: "Ada", selected: [String(options[0]!.id)] });
    const voteToken = cookies.get(`poll_${pid(db, id)}_vote_token`)!;
    expect(voteToken).toBeTruthy();

    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const pollRow = db.db.query("SELECT * FROM polls WHERE id = ?").get(pid(db, id)) as Record<string, string>;
    expect(pollRow.admin_token_hash).toBe(sha(adminToken));
    expect(Object.values(pollRow)).not.toContain(adminToken);
    const voteRow = db.db.query("SELECT * FROM votes WHERE poll_id = ?").get(pid(db, id)) as Record<string, string>;
    expect(voteRow.edit_token_hash).toBe(sha(voteToken));
    expect(Object.values(voteRow)).not.toContain(voteToken);
  });

  test("admin link is rebuilt from the admin's cookie; operators who are not the admin get none", async () => {
    storeFixture();
    const { id, adminToken } = await createPoll();
    const page = await loadPoll(id);
    expect(page.adminLink).toBe(`/poll/${id}?admin=${encodeURIComponent(adminToken)}`);

    const previous = process.env.OPERATOR_TOKEN;
    process.env.OPERATOR_TOKEN = "operator-secret";
    try {
      const operator = cookieJar();
      await expect(loadPoll(id, operator, "?admin=operator-secret")).rejects.toMatchObject({ status: 303 });
      const operatorPage = await loadPoll(id, operator);
      expect(operatorPage.isAdmin).toBe(true);
      expect(operatorPage.adminLink).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.OPERATOR_TOKEN;
      else process.env.OPERATOR_TOKEN = previous;
    }
  });

  test("migrates a pre-slug, pre-status database and keeps old cookies working", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loomio-lite-"));
    cleanupPaths.push(dir);
    const path = join(dir, "old.sqlite");
    const old = new Database(path, { create: true });
    // The original schema: no status/opened_at/closed_at/admin_token on polls, no edit_token on votes.
    old.exec(`
      CREATE TABLE polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '', config_json TEXT NOT NULL,
        opens_at TEXT, closes_at TEXT, manually_closed_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE options (
        id INTEGER PRIMARY KEY AUTOINCREMENT, poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        label TEXT NOT NULL, meaning TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL
      );
      CREATE TABLE votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        voter_name TEXT NOT NULL, ballot_json TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL, UNIQUE(poll_id, voter_name)
      );
    `);
    old.query("INSERT INTO polls (type, title, config_json, created_at) VALUES ('choose', 'Ancient', '{}', '2024-01-01T00:00:00.000Z')").run();
    old.query("INSERT INTO options (poll_id, label, sort_order) VALUES (1, 'A', 0), (1, 'B', 1)").run();
    old.query("INSERT INTO votes (poll_id, voter_name, ballot_json, updated_at) VALUES (1, 'Ada', '{\"selected\":[1]}', '2024-01-02T00:00:00.000Z')").run();
    old.close();

    const migrated = new StoreClass(path);
    store = migrated;
    expect((migrated.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBeGreaterThanOrEqual(3);
    const poll = migrated.getPoll(1)!;
    expect(poll.slug).toMatch(SLUG_PATTERN);
    expect(poll.status).toBe("open");
    expect(poll.openedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(migrated.getOptions(1)).toHaveLength(2);
    expect(migrated.getVotes(1)).toHaveLength(1);
    // Legacy: no admin token, so only the operator can manage it.
    expect(migrated.verifyAdminToken(1, "")).toBe(false);
    // Re-opening is a no-op.
    const version = (migrated.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    migrated.close();
    const again = new StoreClass(path);
    store = again;
    expect(again.getPoll(1)!.slug).toBe(poll.slug);
    expect((again.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(version);
  });

  test("migrates a pre-versioning database with plaintext tokens: hashes them, old cookies still work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loomio-lite-"));
    cleanupPaths.push(dir);
    const path = join(dir, "current.sqlite");
    const old = new Database(path, { create: true });
    old.exec(`
      CREATE TABLE polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '', config_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        opens_at TEXT, closes_at TEXT, manually_closed_at TEXT, opened_at TEXT, closed_at TEXT,
        admin_token TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE TABLE options (
        id INTEGER PRIMARY KEY AUTOINCREMENT, poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        label TEXT NOT NULL, meaning TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL
      );
      CREATE TABLE votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        voter_name TEXT NOT NULL, ballot_json TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
        edit_token TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, UNIQUE(poll_id, voter_name)
      );
    `);
    old.query("INSERT INTO polls (type, title, config_json, status, admin_token, created_at) VALUES ('choose', 'Mine', '{}', 'open', 'plain-admin-token', '2025-01-01T00:00:00.000Z')").run();
    old.query("INSERT INTO polls (type, title, config_json, status, admin_token, created_at) VALUES ('choose', 'Legacy', '{}', 'open', '', '2025-01-02T00:00:00.000Z')").run();
    old.query("INSERT INTO options (poll_id, label, sort_order) VALUES (1, 'A', 0), (1, 'B', 1)").run();
    old.query("INSERT INTO votes (poll_id, voter_name, ballot_json, reason, edit_token, updated_at) VALUES (1, 'Ada', '{\"selected\":[1]}', 'because', 'plain-vote-token', '2025-01-02T00:00:00.000Z')").run();
    old.close();

    const migrated = resetStoreForTesting(path);
    store = migrated;
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const pollRow = migrated.db.query("SELECT * FROM polls WHERE id = 1").get() as Record<string, string>;
    expect(pollRow.admin_token_hash).toBe(sha("plain-admin-token"));
    expect((migrated.db.query("SELECT admin_token_hash FROM polls WHERE id = 2").get() as Record<string, string>).admin_token_hash).toBe("");
    const voteRow = migrated.db.query("SELECT * FROM votes WHERE id = 1").get() as Record<string, string>;
    expect(voteRow.edit_token_hash).toBe(sha("plain-vote-token"));
    expect(JSON.stringify([pollRow, voteRow])).not.toContain("plain-");

    const slug = migrated.getPoll(1)!.slug;
    expect(migrated.getPoll(2)!.slug).not.toBe(slug);

    const jar = cookieJar();
    jar.set("poll_1_admin_token", "plain-admin-token");
    jar.set("poll_1_vote_token", "plain-vote-token");
    jar.set("poll_1_voter_name", "Ada");
    const page = await loadPoll(slug, jar);
    expect(page.isAdmin).toBe(true);
    expect(page.adminLink).toBe(`/poll/${slug}?admin=plain-admin-token`);
    expect(page.viewerVote?.reason).toBe("because");
    expect((await loadPoll(slug, cookieJar())).isAdmin).toBe(false);

    // The old vote token can still update its own ballot; a stranger cannot.
    const update = await postJson(voteRoute, { id: slug }, { voterName: "Ada", selected: ["2"] }, jar);
    expect(update.status).toBe(200);
    expect((await postJson(voteRoute, { id: slug }, { voterName: "Ada", selected: ["1"] }, cookieJar())).status).toBe(400);
  });

  test("the home page lists only polls this browser created or voted in; the operator sees all", async () => {
    const db = storeFixture();
    const alice = cookieJar();
    const bob = cookieJar();
    const carol = cookieJar();

    const draft = await (await postJson(createPollRoute, {}, { type: "choose", title: "Alice draft", optionsText: "A\nB" }, alice)).json() as { id: string };
    const open = await (await postJson(createPollRoute, {}, { type: "choose", title: "Alice open", optionsText: "A\nB" }, alice)).json() as { id: string };
    await postJson(openPollRoute, { id: open.id }, {}, alice);
    const options = db.getOptions(pid(db, open.id));
    await postJson(voteRoute, { id: open.id }, { voterName: "Bob", selected: [String(options[0]!.id)] }, bob);

    const titles = (page: ReturnType<typeof homeLoad>) => [...page.drafts, ...page.active, ...page.closed].map(({ poll }) => poll.title).sort();
    const roles = (page: ReturnType<typeof homeLoad>) => Object.fromEntries([...page.drafts, ...page.active, ...page.closed].map(({ poll, role }) => [poll.title, role]));

    const alicePage = homeLoad({ cookies: alice } as never);
    expect(titles(alicePage)).toEqual(["Alice draft", "Alice open"]);
    expect(alicePage.drafts).toHaveLength(1);
    expect(alicePage.active).toHaveLength(1);
    expect(roles(alicePage)).toEqual({ "Alice draft": "admin", "Alice open": "admin" });

    const bobPage = homeLoad({ cookies: bob } as never);
    expect(titles(bobPage)).toEqual(["Alice open"]);
    expect(roles(bobPage)).toEqual({ "Alice open": "voter" });

    expect(titles(homeLoad({ cookies: carol } as never))).toEqual([]);

    // Forged cookies list nothing.
    const forger = cookieJar();
    forger.set(`poll_${pid(db, draft.id)}_admin_token`, "guess");
    forger.set(`poll_${pid(db, open.id)}_vote_token`, "guess");
    expect(titles(homeLoad({ cookies: forger } as never))).toEqual([]);

    const previous = process.env.OPERATOR_TOKEN;
    process.env.OPERATOR_TOKEN = "operator-secret";
    try {
      const operator = cookieJar();
      operator.set("poll_operator_token", "operator-secret");
      expect(titles(homeLoad({ cookies: operator } as never))).toEqual(["Alice draft", "Alice open"]);
    } finally {
      if (previous === undefined) delete process.env.OPERATOR_TOKEN;
      else process.env.OPERATOR_TOKEN = previous;
    }
  });

  test("page payload carries voter names and reasons but no full ballots; export keeps ballots", async () => {
    const db = storeFixture();
    const { id } = await createPoll();
    await openPoll(id);
    const options = db.getOptions(pid(db, id));
    await postJson(voteRoute, { id }, { voterName: "Ada", selected: [String(options[0]!.id)], reason: "Tasty" });
    await closePoll(id);

    const page = await loadPoll(id);
    expect(page.tally?.voteDetails).toEqual([{ voterName: "Ada", reason: "Tasty" }]);
    expect(JSON.stringify(page.tally)).not.toContain("selected");

    // The cached closed tally still has ballots (not mutated) for the export.
    const poll = db.getPollBySlug(id)!;
    expect(tallyFor(poll, options, db.getVotes(poll.id)).voteDetails?.[0]?.ballot).toBeDefined();
    const exported = await (await getExport(exportJsonRoute, id)).json() as { tally: { voteDetails: Array<{ ballot: unknown }> }; votes: Array<{ ballot: unknown }> };
    expect(exported.votes[0]!.ballot).toBeDefined();
    expect(exported.tally.voteDetails[0]!.ballot).toBeDefined();
  });

  describe("invite mode", () => {
    async function createInvitePoll(overrides: Record<string, unknown> = {}, jar: CookieJar = cookies) {
      const response = await postJson(createPollRoute, {}, {
        type: "choose",
        title: "Board vote",
        optionsText: "Pizza\nSushi\nTacos",
        voterMode: "invite",
        inviteesText: "Ada\nBo\nCy",
        ...overrides
      }, jar);
      expect(response.status).toBe(200);
      return await response.json() as { id: string; adminToken: string };
    }

    /** Invite tokens as the admin page presents them, keyed by invitee name. */
    async function inviteTokens(id: string, jar: CookieJar = cookies): Promise<Record<string, string>> {
      const page = await loadPoll(id, jar);
      return Object.fromEntries((page.invitations ?? []).map((invitation) => {
        const token = new URL(invitation.link ?? "", "http://local.test").searchParams.get("invite");
        return [invitation.name, token ?? ""];
      }));
    }

    async function redeem(id: string, token: string, jar: CookieJar) {
      await expect(loadPoll(id, jar, `?invite=${encodeURIComponent(token)}`)).rejects.toMatchObject({ status: 303, location: `/poll/${id}` });
    }

    function formVote(id: string, fields: Record<string, string>, jar: CookieJar) {
      return pollActions.vote({
        params: { id },
        request: new Request("http://local.test", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(fields)
        }),
        cookies: jar
      } as never) as Promise<unknown>;
    }

    test("invite tokens derive from the admin token and verify; links are rebuilt from the admin cookie", async () => {
      const db = storeFixture();
      const { id, adminToken } = await createInvitePoll();
      const internal = pid(db, id);
      const invites = db.getInvites(internal);
      expect(invites.map((invite) => invite.name)).toEqual(["Ada", "Bo", "Cy"]);

      const tokens = await inviteTokens(id);
      for (const invite of invites) {
        expect(tokens[invite.name]).toBe(deriveInviteToken(adminToken, invite.id));
        expect(db.findInviteByToken(internal, tokens[invite.name]!)?.name).toBe(invite.name);
      }
      expect(new Set(Object.values(tokens)).size).toBe(3);
      expect(deriveInviteToken("other-admin-token", invites[0]!.id)).not.toBe(tokens.Ada);
      expect(db.findInviteByToken(internal, "nope")).toBeNull();
      expect(db.findInviteByToken(internal, "")).toBeNull();

      // Non-admins see no invitation data at all.
      expect((await loadPoll(id, cookieJar())).invitations).toBeNull();
    });

    test("the database holds no plaintext invite tokens", async () => {
      const db = storeFixture();
      const { id, adminToken } = await createInvitePoll();
      const tokens = Object.values(await inviteTokens(id));
      const dump = JSON.stringify(db.db.query("SELECT * FROM invites").all());
      for (const token of tokens) {
        expect(dump).not.toContain(token);
        const row = db.db.query("SELECT token_hash FROM invites WHERE token_hash = ?").get(hashToken(token));
        expect(row).not.toBeNull();
      }
      expect(dump).not.toContain(adminToken);
    });

    test("?invite= sets the invite cookie and redirects to the clean URL; bad tokens grant nothing", async () => {
      const db = storeFixture();
      const { id } = await createInvitePoll();
      await openPoll(id);
      const tokens = await inviteTokens(id);
      const internal = pid(db, id);

      const ada = cookieJar();
      await redeem(id, tokens.Ada!, ada);
      expect(ada.get(`poll_${internal}_invite_token`)).toBe(tokens.Ada!);
      const page = await loadPoll(id, ada);
      expect(page.viewerName).toBe("Ada");
      expect(page.inviteRequired).toBe(false);
      expect(page.isAdmin).toBe(false);

      const guesser = cookieJar();
      await expect(loadPoll(id, guesser, "?invite=nope")).rejects.toMatchObject({ status: 303 });
      expect(guesser.get(`poll_${internal}_invite_token`)).toBeUndefined();
      expect((await loadPoll(id, guesser)).inviteRequired).toBe(true);

      // An invite for another poll is worthless here.
      const other = await createInvitePoll({ title: "Other" });
      const otherTokens = await inviteTokens(other.id);
      await expect(loadPoll(id, guesser, `?invite=${otherTokens.Ada}`)).rejects.toMatchObject({ status: 303 });
      expect(guesser.get(`poll_${internal}_invite_token`)).toBeUndefined();
    });

    test("voting without a valid invite is rejected on the JSON API and the form action", async () => {
      const db = storeFixture();
      const { id } = await createInvitePoll();
      await openPoll(id);
      const options = db.getOptions(pid(db, id));
      const pick = { selected: [String(options[0]!.id)] };

      for (const jar of [cookieJar(), cookies /* the admin is not automatically an invitee */]) {
        const response = await postJson(voteRoute, { id }, { voterName: "Ada", ...pick }, jar);
        expect(response.status).toBe(403);
        expect(((await response.json()) as { error: string }).error).toBe("This poll is invite-only. Use the personal link you were sent.");
      }
      const forged = cookieJar();
      forged.set(`poll_${pid(db, id)}_invite_token`, "guess");
      expect((await postJson(voteRoute, { id }, { voterName: "Ada", ...pick }, forged)).status).toBe(403);

      const failure = await formVote(id, { voterName: "Ada", selected: String(options[0]!.id) }, cookieJar()) as { status: number; data: { error: string } };
      expect(failure.status).toBe(403);
      expect(failure.data.error).toContain("invite-only");
      expect(db.getVotes(pid(db, id))).toEqual([]);
    });

    test("the invite decides the voter name; a submitted name is ignored; re-voting updates the ballot", async () => {
      const db = storeFixture();
      const { id } = await createInvitePoll({ hideResults: "after_vote" });
      await openPoll(id);
      const internal = pid(db, id);
      const options = db.getOptions(internal);
      const tokens = await inviteTokens(id);
      const ada = cookieJar();
      await redeem(id, tokens.Ada!, ada);

      expect((await loadPoll(id, ada)).showResults).toBe(false);
      const first = await postJson(voteRoute, { id }, { voterName: "Bo", selected: [String(options[0]!.id)], reason: "one" }, ada);
      expect(first.status).toBe(200);
      let votes = db.getVotes(internal);
      expect(votes.map((vote) => vote.voterName)).toEqual(["Ada"]);
      expect(ada.get(`poll_${internal}_vote_token`)).toBe(tokens.Ada!);
      expect(decodeURIComponent(ada.get(`poll_${internal}_voter_name`)!)).toBe("Ada");

      // Same invite again (via the form action, with yet another spoofed name) updates in place.
      const result = await formVote(id, { voterName: "Cy", selected: String(options[1]!.id), reason: "two" }, ada).catch((error) => error);
      expect(result).toMatchObject({ status: 303 });
      votes = db.getVotes(internal);
      expect(votes).toHaveLength(1);
      expect(votes[0]!.voterName).toBe("Ada");
      expect(votes[0]!.reason).toBe("two");
      expect((votes[0]!.ballot as { selected: number[] }).selected).toEqual([options[1]!.id]);

      const page = await loadPoll(id, ada);
      expect(page.viewerVote?.reason).toBe("two");
      expect(page.showResults).toBe(true);

      // Bo's own link still works and is independent.
      const bo = cookieJar();
      await redeem(id, tokens.Bo!, bo);
      expect((await postJson(voteRoute, { id }, { selected: [String(options[2]!.id)] }, bo)).status).toBe(200);
      expect(db.getVotes(internal).map((vote) => vote.voterName).sort()).toEqual(["Ada", "Bo"]);

      // The admin's invitation list shows who voted, not what.
      const invitations = (await loadPoll(id)).invitations!;
      expect(invitations.map(({ name, voted }) => [name, voted])).toEqual([["Ada", true], ["Bo", true], ["Cy", false]]);
      expect(JSON.stringify(invitations)).not.toContain("selected");
    });

    test("the admin can add invitees while open; existing links stay valid and duplicates are skipped", async () => {
      const db = storeFixture();
      const { id } = await createInvitePoll();
      await openPoll(id);
      const before = await inviteTokens(id);

      const stranger = cookieJar();
      expect((await postJson(inviteesRoute, { id }, { inviteesText: "Mallory" }, stranger)).status).toBe(400);

      const response = await postJson(inviteesRoute, { id }, { inviteesText: "Di\n ada \n\nEd\nDI" });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { added: string[] }).added).toEqual(["Di", "Ed"]);

      const after = await inviteTokens(id);
      expect(Object.keys(after)).toEqual(["Ada", "Bo", "Cy", "Di", "Ed"]);
      for (const name of ["Ada", "Bo", "Cy"]) expect(after[name]).toBe(before[name]!);

      // The new invitee can vote; the form action path works too.
      const di = cookieJar();
      await redeem(id, after.Di!, di);
      const options = db.getOptions(pid(db, id));
      expect((await postJson(voteRoute, { id }, { selected: [String(options[0]!.id)] }, di)).status).toBe(200);

      // Not for open-mode polls or closed polls.
      const open = await createPoll();
      expect((await postJson(inviteesRoute, { id: open.id }, { inviteesText: "X" })).status).toBe(400);
      await closePoll(id);
      expect((await postJson(inviteesRoute, { id }, { inviteesText: "Fay" })).status).toBe(400);
    });

    test("invitees who voted cannot be removed or renamed", async () => {
      const db = storeFixture();
      const { id, adminToken } = await createInvitePoll();
      await openPoll(id);
      const internal = pid(db, id);
      const tokens = await inviteTokens(id);
      const options = db.getOptions(internal);
      const ada = cookieJar();
      await redeem(id, tokens.Ada!, ada);
      await postJson(voteRoute, { id }, { selected: [String(options[0]!.id)] }, ada);

      expect(() => db.replaceInvitees(internal, ["Bo", "Cy"], adminToken)).toThrow("already voted");
      expect(() => db.replaceInvitees(internal, ["ADA", "Bo", "Cy"], adminToken)).toThrow("already voted");
      // Someone who has not voted can be dropped from the list.
      db.replaceInvitees(internal, ["Ada", "Bo"], adminToken);
      expect(db.getInvites(internal).map((invite) => invite.name)).toEqual(["Ada", "Bo"]);
      expect(db.findInviteByToken(internal, tokens.Cy!)).toBeNull();
      expect(db.findInviteByToken(internal, tokens.Ada!)?.name).toBe("Ada");
      expect(db.getVotes(internal)).toHaveLength(1);
    });

    test("draft edits replace the invitee list; kept invitees keep their links, removed ones lose them", async () => {
      const db = storeFixture();
      const { id } = await createInvitePoll();
      const before = await inviteTokens(id);
      const edit = await postJson(editPollRoute, { id }, {
        type: "choose", title: "Board vote", optionsText: "Pizza\nSushi\nTacos", voterMode: "invite", inviteesText: "Ada\nDi"
      });
      expect(edit.status).toBe(200);
      const after = await inviteTokens(id);
      expect(Object.keys(after)).toEqual(["Ada", "Di"]);
      expect(after.Ada).toBe(before.Ada!);
      expect(db.findInviteByToken(pid(db, id), before.Bo!)).toBeNull();

      // Switching back to open mode clears the list.
      const toOpen = await postJson(editPollRoute, { id }, { type: "choose", title: "Board vote", optionsText: "Pizza\nSushi\nTacos", voterMode: "open" });
      expect(toOpen.status).toBe(200);
      expect(db.getInvites(pid(db, id))).toEqual([]);
      expect(db.getPollBySlug(id)?.config.voterMode).toBe("open");
    });

    test("an operator who is not the admin can see invitees but gets no links and cannot add new ones", async () => {
      const db = storeFixture();
      const { id } = await createInvitePoll();
      const previous = process.env.OPERATOR_TOKEN;
      process.env.OPERATOR_TOKEN = "operator-secret";
      try {
        const operator = cookieJar();
        operator.set("poll_operator_token", "operator-secret");
        const page = await loadPoll(id, operator);
        expect(page.isAdmin).toBe(true);
        expect(page.invitations?.map((invitation) => [invitation.name, invitation.link])).toEqual([["Ada", null], ["Bo", null], ["Cy", null]]);
        const response = await postJson(inviteesRoute, { id }, { inviteesText: "Di" }, operator);
        expect(response.status).toBe(400);
        expect(db.getInvites(pid(db, id))).toHaveLength(3);
        // Saving an unchanged list from the operator is fine.
        const same = await postJson(editPollRoute, { id }, { type: "choose", title: "Renamed", optionsText: "Pizza\nSushi\nTacos", voterMode: "invite", inviteesText: "Ada\nBo\nCy" }, operator);
        expect(same.status).toBe(200);
      } finally {
        if (previous === undefined) delete process.env.OPERATOR_TOKEN;
        else process.env.OPERATOR_TOKEN = previous;
      }
    });

    test("quorum counts invitees, not the typed eligible voter count", async () => {
      const db = storeFixture();
      const { id } = await createInvitePoll({ inviteesText: "Ada\nBo\nCy\nDi", quorumPercent: 50, eligibleVoterCount: 100 });
      expect(db.getPollBySlug(id)?.config.eligibleVoterCount).toBe(0);
      await openPoll(id);
      const tokens = await inviteTokens(id);
      const options = db.getOptions(pid(db, id));
      const ada = cookieJar();
      await redeem(id, tokens.Ada!, ada);
      await postJson(voteRoute, { id }, { selected: [String(options[0]!.id)] }, ada);

      let page = await loadPoll(id, ada);
      expect(page.tally?.quorumText).toBe("1/2 votes for 50% quorum");
      expect(page.tally?.quorumMet).toBe(false);

      const bo = cookieJar();
      await redeem(id, tokens.Bo!, bo);
      await postJson(voteRoute, { id }, { selected: [String(options[0]!.id)] }, bo);
      page = await loadPoll(id, ada);
      expect(page.tally?.quorumMet).toBe(true);

      // Adding invitees raises the bar.
      await postJson(inviteesRoute, { id }, { inviteesText: "Ed\nFay\nGus\nHal" });
      page = await loadPoll(id, ada);
      expect(page.tally?.quorumText).toBe("2/4 votes for 50% quorum");
    });

    test("deleting a poll cascades to its invites", async () => {
      const db = storeFixture();
      const { id } = await createInvitePoll();
      const internal = pid(db, id);
      expect(db.countInvites(internal)).toBe(3);
      deletePollOrThrow(id, cookies as never);
      expect(db.countInvites(internal)).toBe(0);
      expect((db.db.query("SELECT COUNT(*) AS n FROM invites").get() as { n: number }).n).toBe(0);
    });

    test("invite holders see the poll on the home page", async () => {
      const db = storeFixture();
      const { id } = await createInvitePoll();
      await openPoll(id);
      const tokens = await inviteTokens(id);
      const ada = cookieJar();
      expect(homeLoad({ cookies: ada } as never).active).toHaveLength(0);
      await redeem(id, tokens.Ada!, ada);
      const home = homeLoad({ cookies: ada } as never);
      expect(home.active.map(({ role }) => role)).toEqual(["invitee"]);
      const forger = cookieJar();
      forger.set(`poll_${pid(db, id)}_invite_token`, "guess");
      expect(homeLoad({ cookies: forger } as never).active).toHaveLength(0);
    });

    test("setup validation: invite mode needs invitees; names are trimmed, deduped, and length-limited", async () => {
      const db = storeFixture();
      const base = { type: "choose", title: "T", optionsText: "A\nB", voterMode: "invite" };
      for (const inviteesText of ["", "  \n \n"]) {
        const response = await postJson(createPollRoute, {}, { ...base, inviteesText });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toContain("at least one invitee");
      }
      const tooLong = await postJson(createPollRoute, {}, { ...base, inviteesText: "x".repeat(81) });
      expect(tooLong.status).toBe(400);
      const tooMany = await postJson(createPollRoute, {}, { ...base, inviteesText: Array.from({ length: 501 }, (_, i) => `v${i}`).join("\n") });
      expect(tooMany.status).toBe(400);

      const { id } = await createInvitePoll({ inviteesText: "  Ada  \nada\n\nBo\nADA" });
      expect(db.getInvites(pid(db, id)).map((invite) => invite.name)).toEqual(["Ada", "Bo"]);

      // Invitee text is ignored in open mode.
      const open = await createPoll({ inviteesText: "Ada" });
      expect(db.countInvites(pid(db, open.id))).toBe(0);
      expect(db.getPollBySlug(open.id)?.config.voterMode).toBe("open");
    });

    test("open mode is unchanged, and configs saved before voterMode existed read as open", async () => {
      const db = storeFixture();
      const { id } = await createPoll();
      await openPoll(id);
      const options = db.getOptions(pid(db, id));
      expect((await postJson(voteRoute, { id }, { voterName: "Ada", selected: [String(options[0]!.id)] }, cookieJar())).status).toBe(200);
      db.db.query("UPDATE polls SET config_json = '{}' WHERE slug = ?").run(id);
      expect(db.getPollBySlug(id)?.config.voterMode).toBe("open");
    });

    test("migration 4 adds the invites table to a version-3 database", async () => {
      const dir = mkdtempSync(join(tmpdir(), "loomio-lite-"));
      cleanupPaths.push(dir);
      const path = join(dir, "v3.sqlite");
      const fresh = new StoreClass(path);
      fresh.createPoll({ type: "choose", title: "Old", details: "", config: { ...templates[0]!.defaultConfig } as never, opensAt: null, closesAt: null, options: [{ label: "A", meaning: "" }], adminToken: "tok" });
      fresh.close();
      const raw = new Database(path);
      raw.exec("DROP TABLE invites; PRAGMA user_version = 3;");
      raw.close();

      const migrated = new StoreClass(path);
      store = migrated;
      expect((migrated.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(4);
      expect(migrated.listPolls()).toHaveLength(1);
      expect(migrated.getPoll(1)?.config.voterMode).toBe("open");
      migrated.replaceInvitees(1, ["Ada"], "tok");
      expect(migrated.findInviteByToken(1, deriveInviteToken("tok", migrated.getInvites(1)[0]!.id))?.name).toBe("Ada");
      // Ids are never reissued after a delete.
      const firstId = migrated.getInvites(1)[0]!.id;
      migrated.replaceInvitees(1, ["Bo"], "tok");
      expect(migrated.getInvites(1)[0]!.id).toBeGreaterThan(firstId);
    });
  });
});

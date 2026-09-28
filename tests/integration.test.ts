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
import { load as pollLoad } from "../src/routes/poll/[id]/+page.server";
import { deletePollOrThrow, resetStoreForTesting } from "../src/lib/server/app";
import { templates } from "../src/templates";
import type { Store } from "../src/db";

let cleanupPaths: string[] = [];
let store: Store | null = null;

type CookieJar = {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
};

function cookieJar(): CookieJar {
  const jar = new Map<string, string>();
  return {
    get: (name) => jar.get(name),
    set: (name, value) => {
      jar.set(name, value);
    }
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
  return await response.json() as { id: number };
}

async function openPoll(id: number) {
  const response = await postJson(openPollRoute, { id: String(id) }, {});
  expect(response.status).toBe(200);
}

async function closePoll(id: number) {
  const response = await postJson(closePollRoute, { id: String(id) }, {});
  expect(response.status).toBe(200);
}

async function getExport(handler: Function, id: number, jar: CookieJar = cookies, adminToken = ""): Promise<Response> {
  return await handler({
    params: { id: String(id) },
    url: new URL(`http://local.test/poll/${id}/export${adminToken ? `?admin=${encodeURIComponent(adminToken)}` : ""}`),
    cookies: jar
  } as never);
}

async function loadPoll(id: number, jar: CookieJar = cookies, search = "") {
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
      expect(result.id).toBeGreaterThan(0);
      expect(db.getPoll(result.id)?.status).toBe("draft");
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
    expect(db.getPoll(id)?.type).toBe("approval");
    expect(db.getOptions(id)).toHaveLength(2);

    await openPoll(id);
    expect(db.getPoll(id)?.status).toBe("open");
    page = await loadPoll(id);
    expect(page.poll.status).toBe("open");
    expect(page.options.map((option) => option.label)).toEqual(["Pizza", "Sushi"]);

    await closePoll(id);
    expect(db.getPoll(id)?.status).toBe("closed");
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
    const options = db.getOptions(id);
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
    const votes = db.getVotes(id);
    expect(votes).toHaveLength(1);
    expect(votes[0]!.reason).toBe("Updated");
    expect((votes[0]!.ballot as { selected: number[] }).selected).toEqual([options[1]!.id]);
  });

  test("hide-results behavior before vote, after vote, and after close", async () => {
    const db = storeFixture();
    const { id } = await createPoll({ hideResults: "after_vote" });
    await openPoll(id);
    expect((await loadPoll(id)).showResults).toBe(false);

    const options = db.getOptions(id);
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
    const { id } = await createPoll();
    const stranger = cookieJar();

    const editDenied = await postJson(editPollRoute, { id: String(id) }, {
      type: "choose",
      title: "Hijacked",
      optionsText: "A\nB"
    }, stranger);
    expect(editDenied.status).toBe(403);

    expect((await postJson(openPollRoute, { id: String(id) }, {}, stranger)).status).toBe(400);
    await openPoll(id);
    expect(db.getPoll(id)?.status).toBe("open");

    expect((await postJson(closePollRoute, { id: String(id) }, {}, stranger)).status).toBe(400);
    expect(db.getPoll(id)?.status).toBe("open");
    await closePoll(id);

    expect((await getExport(exportJsonRoute, id, stranger)).status).toBe(403);
    expect((await getExport(exportCsvRoute, id, stranger)).status).toBe(403);
    expect((await getExport(exportJsonRoute, id)).status).toBe(200);

    // A valid ?admin= token in the URL grants access without the cookie.
    const token = db.getPollAdminToken(id);
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
    const options = db.getOptions(id);
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
    const options = db.getOptions(id);
    const ada = cookieJar();
    await postJson(voteRoute, { id: String(id) }, { voterName: "Ada", selected: [String(options[0]!.id)] }, ada);

    const impostor = cookieJar();
    const rejected = await postJson(voteRoute, { id: String(id) }, { voterName: "Ada", selected: [String(options[1]!.id)] }, impostor);
    expect(rejected.status).toBe(400);
    expect((db.getVotes(id)[0]!.ballot as { selected: number[] }).selected).toEqual([options[0]!.id]);

    // The original browser can still update its own vote.
    const updated = await postJson(voteRoute, { id: String(id) }, { voterName: "Ada", selected: [String(options[2]!.id)] }, ada);
    expect(updated.status).toBe(200);
    expect((db.getVotes(id)[0]!.ballot as { selected: number[] }).selected).toEqual([options[2]!.id]);
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
    const options = db.getOptions(id);
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
    const options = db.getOptions(id);
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
    const options = db.getOptions(required.id);
    const bad = await postJson(voteRoute, { id: String(required.id) }, { voterName: "Ada", selected: [String(options[0]!.id)] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "A reason is required." });

    const disabled = await createPoll({ title: "Disabled", reasonMode: "disabled" });
    await openPoll(disabled.id);
    const disabledOptions = db.getOptions(disabled.id);
    const good = await postJson(voteRoute, { id: String(disabled.id) }, {
      voterName: "Ben",
      selected: [String(disabledOptions[0]!.id)],
      reason: "Ignored"
    });
    expect(good.status).toBe(200);
    expect(db.getVotes(disabled.id)[0]!.reason).toBe("");
  });

  test("vote reasons are not capped", async () => {
    const db = storeFixture();
    const { id } = await createPoll({ reasonMode: "optional" });
    await openPoll(id);
    const options = db.getOptions(id);
    const longReason = "Long reason. ".repeat(200);
    const response = await postJson(voteRoute, { id: String(id) }, {
      voterName: "Ada",
      selected: [String(options[0]!.id)],
      reason: longReason
    });
    expect(response.status).toBe(200);
    expect(db.getVotes(id)[0]!.reason).toBe(longReason.trim());
  });

  test("exports are available only after close and redact anonymous voters", async () => {
    const db = storeFixture();
    const { id } = await createPoll({ anonymous: true });
    await openPoll(id);
    let response = await getExport(exportJsonRoute, id);
    expect(response.status).toBe(400);

    const options = db.getOptions(id);
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
    const poll = db.getPoll(id);
    expect(poll?.status).toBe("closed");
    expect(poll?.closedAt).toBeTruthy();
  });

  test("admin links grant a cookie and then redirect to the clean poll URL", async () => {
    const db = storeFixture();
    const { id } = await createPoll();
    const token = db.getPollAdminToken(id);
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
    db.db.query("UPDATE polls SET admin_token = '' WHERE id = ?").run(id);

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
      expect(db.getPoll(id)).toBeNull();
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
    const options = db.getOptions(id);
    await postJson(voteRoute, { id: String(id) }, { voterName: "Ada", selected: [String(options[0]!.id)] });

    const stranger = cookieJar();
    expect(() => deletePollOrThrow(id, stranger as never)).toThrow("Only the poll admin");
    expect(db.getPoll(id)).not.toBeNull();

    deletePollOrThrow(id, cookies as never);
    expect(db.getPoll(id)).toBeNull();
    expect(db.getOptions(id)).toEqual([]);
    expect(db.getVotes(id)).toEqual([]);
  });

  test("approval and IRV can be opened, voted, closed, and exported", async () => {
    const db = storeFixture();
    const approval = await createPoll({ type: "approval", title: "Approval", optionsText: "A\nB\nC" });
    await openPoll(approval.id);
    let options = db.getOptions(approval.id);
    await postJson(voteRoute, { id: String(approval.id) }, {
      voterName: "Ada",
      selected: [String(options[0]!.id), String(options[1]!.id)]
    });
    await closePoll(approval.id);
    expect(await (await getExport(exportCsvRoute, approval.id)).text()).toContain("Approval");

    const irv = await createPoll({ type: "irv", title: "IRV", optionsText: "A\nB\nC" });
    await openPoll(irv.id);
    options = db.getOptions(irv.id);
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
});

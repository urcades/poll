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
import { resetStoreForTesting } from "../src/lib/server/app";
import { templates } from "../src/templates";
import type { Store } from "../src/db";

let cleanupPaths: string[] = [];
let store: Store | null = null;

afterEach(() => {
  store?.close();
  store = null;
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

async function postJson(handler: Function, params: Record<string, string>, body: unknown): Promise<Response> {
  return await handler({ params, request: jsonRequest(body) });
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

async function loadPoll(id: number, voterName = "") {
  return await pollLoad({
    params: { id: String(id) },
    url: new URL(`http://local.test/poll/${id}${voterName ? `?voterName=${encodeURIComponent(voterName)}` : ""}`)
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
    expect((await loadPoll(id, "Ada")).showResults).toBe(true);

    const closedHidden = await createPoll({ title: "Closed hidden", hideResults: "after_close" });
    await openPoll(closedHidden.id);
    expect((await loadPoll(closedHidden.id)).showResults).toBe(false);
    await closePoll(closedHidden.id);
    expect((await loadPoll(closedHidden.id)).showResults).toBe(true);
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
    let response = await exportJsonRoute({ params: { id: String(id) } } as never);
    expect(response.status).toBe(400);

    const options = db.getOptions(id);
    await postJson(voteRoute, { id: String(id) }, {
      voterName: "Ada",
      selected: [String(options[0]!.id)],
      reason: "Private"
    });
    await closePoll(id);

    response = await exportJsonRoute({ params: { id: String(id) } } as never);
    expect(response.status).toBe(200);
    const json = await response.json() as { votes: Array<{ voterName: string; reason: string }> };
    expect(json.votes[0]).toEqual(expect.objectContaining({ voterName: "Voter 1", reason: "" }));

    const csv = await (await exportCsvRoute({ params: { id: String(id) } } as never)).text();
    expect(csv).toContain('"Voter 1"');
    expect(csv).not.toContain("Ada");
    expect(csv).not.toContain("Private");
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
    expect(await (await exportCsvRoute({ params: { id: String(approval.id) } } as never)).text()).toContain("Approval");

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
    expect(page.tally.roundLogs?.length).toBeGreaterThan(0);
    expect(await (await exportJsonRoute({ params: { id: String(irv.id) } } as never)).text()).toContain('"IRV"');
  });
});

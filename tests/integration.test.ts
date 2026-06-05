import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/server";
import { templates } from "../src/templates";

let cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
  cleanupPaths = [];
});

function appFixture(): App {
  const dir = mkdtempSync(join(tmpdir(), "loomio-lite-"));
  cleanupPaths.push(dir);
  return createApp(join(dir, "test.sqlite"));
}

function request(app: App, path: string, init?: RequestInit) {
  return app.fetch(new Request(`http://local.test${path}`, init));
}

async function postJson(app: App, path: string, body: unknown) {
  return request(app, path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body)
  });
}

async function createPoll(app: App, overrides: Record<string, unknown> = {}) {
  const response = await postJson(app, "/api/polls", {
    type: "choose",
    title: "Dinner",
    details: "Pick a place",
    optionsText: "Pizza\nSushi\nTacos",
    ...overrides
  });
  expect(response.status).toBe(200);
  return await response.json() as { id: number };
}

async function openPoll(app: App, id: number) {
  const response = await postJson(app, `/api/polls/${id}/open`, {});
  expect(response.status).toBe(200);
}

describe("server integration", () => {
  test("new poll page exposes timing quick-set controls", async () => {
    const app = appFixture();
    const html = await (await request(app, "/new")).text();
    expect(html).toContain('name="opensAt"');
    expect(html).toContain('data-set-time="now"');
    expect(html).toContain('name="closesAt"');
    expect(html).toContain('data-set-time="end-of-day"');
    expect(html).toContain("End of Day");
  });

  test("new poll page keeps advanced settings collapsed with helper text", async () => {
    const app = appFixture();
    const html = await (await request(app, "/new")).text();
    expect(html).toContain('<details class="advanced-settings">');
    expect(html).toContain("<summary>Advanced settings</summary>");
    expect(html).toContain("Quorum is the minimum participation threshold");
    expect(html).toContain("The number of people allowed or expected to vote");
    expect(html).not.toContain("Reason length cap");
    expect(html).not.toContain('name="reasonLengthCap"');
  });

  test("new poll page includes richer type guidance metadata", async () => {
    const app = appFixture();
    const html = await (await request(app, "/new?type=rank")).text();
    expect(html).toContain("Example:");
    expect(html).toContain("Results:");
    expect(html).toContain("Learn more:");
    expect(html).toContain("Rank your top three trip ideas");
    expect(html).toContain("https://en.wikipedia.org/wiki/Borda_count");
    expect(html).toContain("https://help.loomio.com/en/user_manual/polls/proposal_types/");
  });

  test("creates each visible template as a draft", async () => {
    const app = appFixture();
    for (const template of templates) {
      const result = await createPoll(app, {
        type: template.type,
        title: template.label,
        optionsText: template.defaultOptions.map((option) => option.label).join("\n"),
        seats: template.type === "stv" ? 1 : undefined
      });
      expect(result.id).toBeGreaterThan(0);
      expect(app.store.getPoll(result.id)?.status).toBe("draft");
    }
    expect(app.store.listPolls()).toHaveLength(templates.length);
  });

  test("draft appears on home, can be edited, previewed, and opened", async () => {
    const app = appFixture();
    const { id } = await createPoll(app, { title: "Draft dinner" });
    let html = await (await request(app, "/")).text();
    expect(html.indexOf("Draft dinner")).toBeGreaterThan(html.indexOf("<h2>Drafts</h2>"));
    html = await (await request(app, `/poll/${id}`)).text();
    expect(html).toContain("Draft preview");
    expect(html).toContain("Open voting");

    const edit = await postJson(app, `/api/polls/${id}`, {
      type: "approval",
      title: "Edited dinner",
      details: "Updated",
      optionsText: "Pizza\nSushi"
    });
    expect(edit.status).toBe(200);
    expect(app.store.getPoll(id)?.type).toBe("approval");
    expect(app.store.getOptions(id)).toHaveLength(2);

    await openPoll(app, id);
    expect(app.store.getPoll(id)?.status).toBe("open");
    html = await (await request(app, `/poll/${id}`)).text();
    expect(html).toContain("Approve any options");
  });

  test("rejects poll setup constraints that conflict with option count or fixed semantics", async () => {
    const app = appFixture();

    let response = await postJson(app, "/api/polls", {
      type: "rank",
      title: "Bad rank",
      optionsText: "A\nB\nC",
      rankCount: 5
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Number of ranked choices cannot exceed the number of options." });

    response = await postJson(app, "/api/polls", {
      type: "choose",
      title: "Bad choose",
      optionsText: "A\nB",
      minChoices: 1,
      maxChoices: 3
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Maximum choices cannot exceed the number of options." });

    response = await postJson(app, "/api/polls", {
      type: "stv",
      title: "Bad STV",
      optionsText: "A\nB",
      seats: 2
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "STV seats must be less than the number of candidates." });

    response = await postJson(app, "/api/polls", {
      type: "majority",
      title: "Bad majority",
      optionsText: "Maybe\nNo"
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain("fixed voting positions");
  });

  test("submits and updates a vote by display name", async () => {
    const app = appFixture();
    const { id } = await createPoll(app);
    await openPoll(app, id);
    const options = app.store.getOptions(id);
    await postJson(app, `/api/polls/${id}/votes`, {
      voterName: "Ada",
      selected: [String(options[0]!.id)],
      reason: "First"
    });
    await postJson(app, `/api/polls/${id}/votes`, {
      voterName: "Ada",
      selected: [String(options[1]!.id)],
      reason: "Updated"
    });
    const votes = app.store.getVotes(id);
    expect(votes).toHaveLength(1);
    expect(votes[0]!.reason).toBe("Updated");
    expect((votes[0]!.ballot as { selected: number[] }).selected).toEqual([options[1]!.id]);
  });

  test("home page separates active and closed sections", async () => {
    const app = appFixture();
    const active = await createPoll(app, { title: "Active poll" });
    await openPoll(app, active.id);
    const closed = await createPoll(app, { title: "Closed poll" });
    await openPoll(app, closed.id);
    app.store.closePoll(closed.id);
    const html = await (await request(app, "/")).text();
    expect(html.indexOf("Active poll")).toBeGreaterThan(html.indexOf("<h2>Active votes</h2>"));
    expect(html.indexOf("Closed poll")).toBeGreaterThan(html.indexOf("<h2>Closed votes</h2>"));
    expect(app.store.getPoll(active.id)?.manuallyClosedAt).toBeNull();
  });

  test("hide-results behavior before vote, after vote, and after close", async () => {
    const app = appFixture();
    const { id } = await createPoll(app, { hideResults: "after_vote" });
    await openPoll(app, id);
    let html = await (await request(app, `/poll/${id}`)).text();
    expect(html).toContain("Results are hidden until you vote");
    const options = app.store.getOptions(id);
    await postJson(app, `/api/polls/${id}/votes`, { voterName: "Ada", selected: [String(options[0]!.id)] });
    html = await (await request(app, `/poll/${id}?voterName=Ada`)).text();
    expect(html).toContain("Leading:");

    const closedHidden = await createPoll(app, { title: "Closed hidden", hideResults: "after_close" });
    await openPoll(app, closedHidden.id);
    html = await (await request(app, `/poll/${closedHidden.id}`)).text();
    expect(html).toContain("Results are hidden until this poll closes");
    await postJson(app, `/api/polls/${closedHidden.id}/close`, {});
    html = await (await request(app, `/poll/${closedHidden.id}`)).text();
    expect(html).toContain("No quorum target");
  });

  test("reason required and disabled validation", async () => {
    const app = appFixture();
    const required = await createPoll(app, { title: "Required", reasonMode: "required" });
    await openPoll(app, required.id);
    const options = app.store.getOptions(required.id);
    const bad = await postJson(app, `/api/polls/${required.id}/votes`, { voterName: "Ada", selected: [String(options[0]!.id)] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "A reason is required." });

    const disabled = await createPoll(app, { title: "Disabled", reasonMode: "disabled" });
    await openPoll(app, disabled.id);
    const disabledOptions = app.store.getOptions(disabled.id);
    const good = await postJson(app, `/api/polls/${disabled.id}/votes`, {
      voterName: "Ben",
      selected: [String(disabledOptions[0]!.id)],
      reason: "Ignored"
    });
    expect(good.status).toBe(200);
    expect(app.store.getVotes(disabled.id)[0]!.reason).toBe("");
  });

  test("vote reasons are not capped", async () => {
    const app = appFixture();
    const { id } = await createPoll(app, { reasonMode: "optional" });
    await openPoll(app, id);
    const options = app.store.getOptions(id);
    const longReason = "Long reason. ".repeat(200);
    const response = await postJson(app, `/api/polls/${id}/votes`, {
      voterName: "Ada",
      selected: [String(options[0]!.id)],
      reason: longReason
    });
    expect(response.status).toBe(200);
    expect(app.store.getVotes(id)[0]!.reason).toBe(longReason.trim());
  });

  test("exports are available only after close and redact anonymous voters", async () => {
    const app = appFixture();
    const { id } = await createPoll(app, { anonymous: true });
    await openPoll(app, id);
    let response = await request(app, `/poll/${id}/export.json`);
    expect(response.status).toBe(400);

    const options = app.store.getOptions(id);
    await postJson(app, `/api/polls/${id}/votes`, {
      voterName: "Ada",
      selected: [String(options[0]!.id)],
      reason: "Private"
    });
    await postJson(app, `/api/polls/${id}/close`, {});

    let html = await (await request(app, `/poll/${id}`)).text();
    expect(html).toContain("Export JSON");
    expect(html).toContain("Export CSV");

    response = await request(app, `/poll/${id}/export.json`);
    expect(response.status).toBe(200);
    const json = await response.json() as { votes: Array<{ voterName: string; reason: string }> };
    expect(json.votes[0]).toEqual(expect.objectContaining({ voterName: "Voter 1", reason: "" }));

    const csv = await (await request(app, `/poll/${id}/export.csv`)).text();
    expect(csv).toContain('"Voter 1"');
    expect(csv).not.toContain("Ada");
    expect(csv).not.toContain("Private");
  });

  test("approval and IRV can be opened, voted, closed, and exported", async () => {
    const app = appFixture();
    const approval = await createPoll(app, { type: "approval", title: "Approval", optionsText: "A\nB\nC" });
    await openPoll(app, approval.id);
    let options = app.store.getOptions(approval.id);
    await postJson(app, `/api/polls/${approval.id}/votes`, {
      voterName: "Ada",
      selected: [String(options[0]!.id), String(options[1]!.id)]
    });
    await postJson(app, `/api/polls/${approval.id}/close`, {});
    expect(await (await request(app, `/poll/${approval.id}/export.csv`)).text()).toContain("Approval");

    const irv = await createPoll(app, { type: "irv", title: "IRV", optionsText: "A\nB\nC" });
    await openPoll(app, irv.id);
    options = app.store.getOptions(irv.id);
    await postJson(app, `/api/polls/${irv.id}/votes`, {
      voterName: "Ada",
      [`rank_1`]: String(options[0]!.id),
      [`rank_2`]: String(options[1]!.id)
    });
    await postJson(app, `/api/polls/${irv.id}/close`, {});
    const html = await (await request(app, `/poll/${irv.id}`)).text();
    expect(html).toContain("Round log");
    expect(html).toContain("Export JSON");
  });
});

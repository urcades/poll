import { closePoll, createDraft, expect, pageAction, openVoting, slugOf, submitVote, test, voteForm, type Person } from "./fixtures";

/** Titles are unique per test because every test shares one database. */
const uniq = (title: string) => `${title} ${Math.random().toString(36).slice(2, 8)}`;

async function vote(person: Person, slug: string, name: string, ...labels: string[]) {
  const { page } = person;
  await page.goto(`/poll/${slug}`);
  const form = voteForm(page);
  await form.getByLabel("Your display name").fill(name);
  for (const label of labels) await form.getByLabel(label, { exact: true }).check();
  await submitVote(page);
  await expect(page.getByRole("button", { name: "Update vote" })).toBeVisible();
}

/** Value cell of a results row, addressed by its option label. */
function resultRow(page: Person["page"], label: string) {
  return page.getByRole("row").filter({ has: page.getByRole("cell", { name: label, exact: true }) });
}

test("choose poll: draft, edit, open, vote, update, name clash, close, results, exports", async ({ person }) => {
  const A = await person();
  const B = await person();
  const title = uniq("Lunch place");

  const slug = await createDraft(A.page, { title, details: "Where should we eat?" });
  await pageAction(A.page, "button", "Open voting");
  await expect(A.page.getByText("Results will appear after voting opens")).toBeVisible();

  // Edit the draft.
  await (await pageAction(A.page, "link", "Edit draft")).click();
  await expect(A.page).toHaveURL(new RegExp(`/poll/${slug}/edit$`));
  const edited = `${title} (edited)`;
  await A.page.getByLabel("Title", { exact: true }).fill(edited);
  await A.page.getByRole("button", { name: "Save changes" }).click();
  await expect(A.page).toHaveURL(new RegExp(`/poll/${slug}$`));
  await expect(A.page.getByText(edited, { exact: true }).first()).toBeVisible();

  await openVoting(A.page);

  // Ada votes for Option A, Bo (another device) for Option B.
  await vote(A, slug, "Ada", "Option A");
  await expect(A.page.getByText(/\b1 vote\b/)).toBeVisible();
  await vote(B, slug, "Bo", "Option B");
  await expect(B.page.getByText(/\b2 votes\b/)).toBeVisible();

  // Ada changes her mind.
  await A.page.goto(`/poll/${slug}`);
  await expect(voteForm(A.page).getByLabel("Your display name")).toHaveValue("Ada");
  await expect(voteForm(A.page).getByLabel("Option A", { exact: true })).toBeChecked();
  await voteForm(A.page).getByLabel("Option A", { exact: true }).uncheck();
  await voteForm(A.page).getByLabel("Option C", { exact: true }).check();
  await submitVote(A.page, "Update vote");
  await expect(voteForm(A.page).getByLabel("Option C", { exact: true })).toBeChecked();
  await expect(A.page.getByText(/\b2 votes\b/)).toBeVisible();

  // Bo cannot take over the name Ada; the form keeps what Bo typed.
  await voteForm(B.page).getByLabel("Your display name").fill("Ada");
  await voteForm(B.page).getByLabel("Option B", { exact: true }).uncheck();
  await voteForm(B.page).getByLabel("Option C", { exact: true }).check();
  await submitVote(B.page, "Update vote");
  await expect(B.page.getByRole("alert")).toContainText(/name|taken|already/i);
  await expect(voteForm(B.page).getByLabel("Your display name")).toHaveValue("Ada");
  await expect(voteForm(B.page).getByLabel("Option C", { exact: true })).toBeChecked();
  await expect(A.page.getByText(/\b2 votes\b/)).toBeVisible();

  // Bo has no admin controls.
  await B.page.reload();
  await expect(B.page.getByRole("heading", { name: "Manage poll" })).toHaveCount(0);
  await expect(B.page.getByText("Admin link:")).toHaveCount(0);

  // Admin closes; results show the final counts.
  await closePoll(A.page);
  await expect(A.page.getByText("Voting is not open.")).toBeVisible();
  await expect(resultRow(A.page, "Option A")).toContainText("0");
  await expect(resultRow(A.page, "Option B")).toContainText("1");
  await expect(resultRow(A.page, "Option C")).toContainText("1");

  // Exports download for the admin only.
  const [json] = await Promise.all([A.page.waitForEvent("download"), A.page.getByRole("link", { name: "Export JSON" }).click()]);
  expect(json.suggestedFilename()).toContain(slug);
  expect(await readDownload(json)).toContain("Ada");
  const [csv] = await Promise.all([A.page.waitForEvent("download"), A.page.getByRole("link", { name: "Export CSV" }).click()]);
  expect(csv.suggestedFilename()).toMatch(/\.csv$/);
  expect(await readDownload(csv)).toContain("Bo");

  await B.page.reload();
  await expect(B.page.getByRole("link", { name: "Export JSON" })).toHaveCount(0);
  expect((await B.page.request.get(`/poll/${slug}/export.json`)).ok()).toBe(false);
  expect((await B.page.request.get(`/poll/${slug}/export.csv`)).ok()).toBe(false);
});

test("admin link grants admin in a new browser and is stripped from the URL", async ({ person }) => {
  const A = await person();
  const slug = await createDraft(A.page, { title: uniq("Admin link") });
  const href = await A.page.getByRole("link", { name: /\?admin=/ }).getAttribute("href");
  expect(href).toContain(`/poll/${slug}?admin=`);

  const stranger = await person();
  await stranger.page.goto(`/poll/${slug}`);
  await expect(stranger.page.getByRole("heading", { name: "Draft preview" })).toBeVisible();
  await expect(stranger.page.getByRole("heading", { name: "Manage poll" })).toHaveCount(0);

  const other = await person();
  await other.page.goto(href!);
  await expect(other.page).toHaveURL(new RegExp(`/poll/${slug}$`));
  expect(other.page.url()).not.toContain("admin");
  await pageAction(other.page, "button", "Open voting");
  await pageAction(other.page, "link", "Edit draft");
  // The cookie keeps working on a plain reload.
  await other.page.reload();
  await pageAction(other.page, "button", "Open voting");
});

test("hide results until vote is cast", async ({ person }) => {
  const admin = await person();
  const voter = await person();
  const bystander = await person();
  const slug = await createDraft(admin.page, { title: uniq("Hidden"), hideResults: "Until vote is cast" });
  await openVoting(admin.page);

  await voter.page.goto(`/poll/${slug}`);
  await expect(voter.page.getByText("Results are hidden until you vote")).toBeVisible();
  await expect(voter.page.getByText(/Leading:/)).toHaveCount(0);

  await vote(voter, slug, "Vera", "Option A");
  await expect(voter.page.getByText(/Leading: Option A/)).toBeVisible();
  await expect(voter.page.getByText("Results are hidden until you vote")).toHaveCount(0);

  await bystander.page.goto(`/poll/${slug}`);
  await expect(bystander.page.getByText("Results are hidden until you vote")).toBeVisible();
  await expect(bystander.page.getByText(/Leading:/)).toHaveCount(0);
  // The hidden tally must not be in the serialized page data either.
  expect(await bystander.page.content()).not.toContain("Leading: Option A");
});

test("IRV: rank with clicks and keyboard, close, winner and rounds", async ({ person }) => {
  const admin = await person();
  const slug = await createDraft(admin.page, { title: uniq("Chair"), type: "IRV / Ranked-choice", options: ["Alpha", "Beta", "Gamma"] });
  await openVoting(admin.page);

  const ranked = (p: Person) => voteForm(p.page).locator("ol.rank-list .rank-main");
  const pick = (p: Person, label: string) => voteForm(p.page).getByRole("button", { name: `${label}. Select to rank it.` });

  async function ballot(name: string, prepare: (p: Person) => Promise<void>, expected: string[]) {
    const p = await person();
    await p.page.goto(`/poll/${slug}`);
    await voteForm(p.page).getByLabel("Your display name").fill(name);
    await expect(voteForm(p.page).locator(".rank-ballot")).toBeVisible(); // enhanced UI mounted
    await prepare(p);
    await expect(ranked(p)).toHaveText(expected);
    await submitVote(p.page);
    await expect(p.page.getByRole("button", { name: "Update vote" })).toBeVisible();
    // The saved ranking survives a reload.
    await p.page.reload();
    await expect(ranked(p)).toHaveText(expected);
  }

  // Alpha, Beta, Gamma by clicks.
  await ballot("V1", async (p) => {
    for (const label of ["Alpha", "Beta", "Gamma"]) await pick(p, label).click();
  }, ["Alpha", "Beta", "Gamma"]);

  // Alpha, Gamma (Beta left unranked).
  await ballot("V2", async (p) => {
    await pick(p, "Alpha").click();
    await pick(p, "Gamma").click();
  }, ["Alpha", "Gamma"]);

  // Keyboard: rank all three, then ArrowUp to Beta, Gamma, Alpha.
  await ballot("V3", async (p) => {
    for (const label of ["Alpha", "Beta", "Gamma"]) await pick(p, label).click();
    const item = (label: string) => voteForm(p.page).getByRole("button", { name: new RegExp(`^${label}, rank \\d`) });
    await item("Beta").focus();
    await p.page.keyboard.press("ArrowUp");
    await expect(ranked(p)).toHaveText(["Beta", "Alpha", "Gamma"]);
    await expect(item("Beta")).toBeFocused();
    await item("Gamma").focus();
    await p.page.keyboard.press("ArrowUp");
  }, ["Beta", "Gamma", "Alpha"]);

  // Gamma, Beta.
  await ballot("V4", async (p) => {
    await pick(p, "Gamma").click();
    await pick(p, "Beta").click();
  }, ["Gamma", "Beta"]);

  // Rank three, then unrank Alpha by clicking it in the ranked list.
  await ballot("V5", async (p) => {
    for (const label of ["Gamma", "Alpha", "Beta"]) await pick(p, label).click();
    await voteForm(p.page).getByRole("button", { name: /^Alpha, rank 2/ }).click();
    await p.page.getByRole("button", { name: "Move Beta up" }).click();
    await p.page.getByRole("button", { name: "Move Beta down" }).click();
  }, ["Gamma", "Beta"]);

  await admin.page.reload();
  await expect(admin.page.getByText(/\b5 votes\b/)).toBeVisible();
  await closePoll(admin.page);

  // Round 1: Alpha 2, Beta 1, Gamma 2 -> Beta out, V3 transfers to Gamma -> Gamma 3.
  await expect(admin.page.getByText("Elected: Gamma")).toBeVisible();
  const rounds = admin.page.locator("details", { has: admin.page.getByText("Round by round", { exact: true }) });
  await expect(rounds).toHaveAttribute("open", "");
  await expect(rounds.getByText("Round 1")).toBeVisible();
  await expect(rounds).toContainText("Beta");
  await expect(admin.page.getByText("Round log", { exact: true })).toBeVisible();
});

test("invite-only: strangers cannot vote, invitees vote through personal links", async ({ person }) => {
  const admin = await person();
  const slug = await createDraft(admin.page, { title: uniq("Invite only"), invitees: ["Ines", "Ivo"] });
  await openVoting(admin.page);

  const panel = admin.page.locator("#invitations");
  await expect(panel).toContainText("0 of 2");
  const links = panel.getByRole("link", { name: "personal link" });
  await expect(links).toHaveCount(2);
  const ines = await links.nth(0).getAttribute("href");
  expect(await panel.locator("li", { hasText: "Ines" }).getByRole("link").getAttribute("href")).toBe(ines);
  expect(ines).toContain("invite=");

  const stranger = await person();
  await stranger.page.goto(`/poll/${slug}`);
  await expect(stranger.page.getByText("This poll is invite-only")).toBeVisible();
  await expect(voteForm(stranger.page)).toHaveCount(0);
  const attempt = await stranger.page.request.post(`/poll/${slug}?/vote`, {
    form: { voterName: "Mallory", selected: "1" },
    headers: { origin: new URL(stranger.page.url()).origin }
  });
  // SvelteKit answers action requests that accept JSON with 200 and the failure inside.
  const outcome = await attempt.text();
  expect(outcome).toContain('"type":"failure"');
  expect(outcome).toContain('"status":403');
  expect(outcome).toMatch(/invite-only/);

  const invitee = await person();
  await invitee.page.goto(ines!);
  await expect(invitee.page).toHaveURL(new RegExp(`/poll/${slug}$`));
  expect(invitee.page.url()).not.toContain("invite=");
  await expect(invitee.page.getByText("Voting as")).toContainText("Ines");
  await expect(voteForm(invitee.page).getByLabel("Your display name")).toHaveCount(0);
  await voteForm(invitee.page).getByLabel("Option B", { exact: true }).check();
  await submitVote(invitee.page);
  await expect(invitee.page.getByRole("button", { name: "Update vote" })).toBeVisible();

  await admin.page.reload();
  await expect(admin.page.locator("#invitations")).toContainText("1 of 2");
  await expect(admin.page.getByText(/\b1 vote\b/)).toBeVisible();
  await expect(admin.page.locator("#invitations li", { hasText: "Ines" })).toContainText("voted");
  await expect(admin.page.locator("#invitations li", { hasText: "Ivo" })).toContainText("not voted");
});

test("open poll page refreshes by itself when someone else votes", async ({ person }) => {
  const admin = await person();
  const watcher = await person();
  const voter = await person();
  const slug = await createDraft(admin.page, { title: uniq("Live") });
  await openVoting(admin.page);

  await watcher.page.goto(`/poll/${slug}`);
  await expect(watcher.page.getByText(/\b0 votes\b/)).toBeVisible();
  await vote(voter, slug, "Liv", "Option C");
  // No reload on the watcher's side: the 5s version probe picks it up.
  await expect(watcher.page.getByText(/\b1 vote\b/)).toBeVisible({ timeout: 15_000 });
  await expect(watcher.page.getByText(/Leading: Option C/)).toBeVisible();
});

test("home lists only polls this browser created or voted in", async ({ person }) => {
  const one = await person();
  const two = await person();
  const three = await person();
  const titleX = uniq("Poll X");
  const titleY = uniq("Poll Y");
  const slugX = await createDraft(one.page, { title: titleX });
  await openVoting(one.page);
  await createDraft(two.page, { title: titleY });
  await vote(two, slugX, "Twoey", "Option A");

  await three.page.goto("/");
  await expect(three.page.getByText("Polls you create or vote in show up here.")).toBeVisible();

  await one.page.goto("/");
  await expect(one.page.getByRole("link", { name: titleX })).toBeVisible();
  await expect(one.page.getByRole("link", { name: titleY })).toHaveCount(0);
  await expect(one.page.locator("article", { hasText: titleX })).toContainText("created by you");

  await two.page.goto("/");
  await expect(two.page.locator("article", { hasText: titleY })).toContainText("created by you");
  await expect(two.page.locator("article", { hasText: titleX })).toContainText("you voted");
});

test("delete asks for confirmation", async ({ person }) => {
  const A = await person();
  const title = uniq("Doomed");
  const slug = await createDraft(A.page, { title });

  const asked = A.page.waitForEvent("dialog");
  const clickDelete = (await pageAction(A.page, "button", "Delete")).click();
  const dialog = await asked;
  expect(dialog.message()).toContain("Delete this poll");
  await dialog.dismiss();
  await clickDelete;
  await expect(A.page).toHaveURL(new RegExp(`/poll/${slug}$`));
  await A.page.reload();
  await pageAction(A.page, "button", "Open voting");

  A.page.once("dialog", (dialog) => void dialog.accept());
  await (await pageAction(A.page, "button", "Delete")).click();
  await expect(A.page).toHaveURL(/\/$/);
  expect((await A.page.request.get(`/poll/${slug}`)).status()).toBe(404);
  await expect(A.page.getByRole("link", { name: title })).toHaveCount(0);
});

test("time poll: pick slots, vote availability, close, download the .ics", async ({ person }) => {
  const admin = await person();
  const ada = await person();
  const bo = await person();
  const slug = await createDraft(admin.page, {
    title: uniq("Standup"),
    type: "Time poll",
    slots: ["2030-05-14T10:00", "2030-05-15T10:00", "2030-05-16T14:30"]
  });
  await openVoting(admin.page);

  async function availability(p: Person, name: string, states: Array<"available" | "if needed" | "unavailable">) {
    await p.page.goto(`/poll/${slug}`);
    const form = voteForm(p.page);
    await form.getByLabel("Your display name").fill(name);
    for (const [index, state] of states.entries()) {
      await form.locator(".slot").nth(index).getByRole("radio", { name: state, exact: true }).check();
    }
    await submitVote(p.page);
    await expect(p.page.getByRole("button", { name: "Update vote" })).toBeVisible();
  }

  await availability(ada, "Ada", ["unavailable", "available", "if needed"]);
  await availability(bo, "Bo", ["unavailable", "available", "unavailable"]);

  await closePoll(admin.page);
  await expect(admin.page.getByText("Best timeslot:")).toContainText("15 May, 10:00");

  const [download] = await Promise.all([
    admin.page.waitForEvent("download"),
    admin.page.getByRole("link", { name: /calendar \(\.ics\)/ }).click()
  ]);
  expect(download.suggestedFilename()).toBe(`poll-${slug}.ics`);
  const ics = await readDownload(download);
  expect(ics).toContain("BEGIN:VCALENDAR");
  expect(ics).toContain("END:VCALENDAR");
  expect(ics).toMatch(/DTSTART:20300515T100000Z/);
});

async function readDownload(download: import("@playwright/test").Download): Promise<string> {
  const path = await download.path();
  return (await import("node:fs/promises")).readFile(path, "utf8");
}

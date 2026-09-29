import { closePoll, createDraft, expect, openVoting, submitVote, test, voteForm, watchPage } from "./fixtures";

async function noHorizontalScroll(page: import("@playwright/test").Page, where: string) {
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.scrollingElement?.scrollWidth ?? 0,
    inner: window.innerWidth
  }));
  expect(scroll, `${where}: scrollWidth ${scroll} > innerWidth ${inner}`).toBeLessThanOrEqual(inner);
}

test("poll pages fit a 375px screen", async ({ page }) => {
  const me = await watchPage(page);
  await page.goto("/");
  await noHorizontalScroll(page, "home");

  await createDraft(page, { title: "A fairly long poll title that has to wrap on a narrow phone screen without scrolling", details: "Some details ".repeat(20) });
  await noHorizontalScroll(page, "draft preview");
  await openVoting(page);
  await noHorizontalScroll(page, "open poll");

  const form = voteForm(page);
  await form.getByLabel("Your display name").fill("Mobile Voter");
  await form.getByLabel("Option B", { exact: true }).check();
  await submitVote(page);
  await expect(page.getByRole("button", { name: "Update vote" })).toBeVisible();
  await noHorizontalScroll(page, "after voting");

  await closePoll(page);
  await noHorizontalScroll(page, "closed poll with results");

  await page.goto("/new");
  await noHorizontalScroll(page, "new poll form");

  // Ranked ballot and round-by-round charts are the widest widgets.
  await createDraft(page, { title: "Ranked on a phone", type: "IRV / Ranked-choice" });
  await openVoting(page);
  await noHorizontalScroll(page, "IRV ballot");
  const irv = voteForm(page);
  await irv.getByLabel("Your display name").fill("Rita");
  for (const label of ["Candidate A", "Candidate B"]) await irv.getByRole("button", { name: `${label}. Select to rank it.` }).click();
  await submitVote(page);
  await expect(page.getByRole("button", { name: "Update vote" })).toBeVisible();
  await closePoll(page);
  await page.getByText("Round log", { exact: true }).click();
  await noHorizontalScroll(page, "IRV results");

  expect(me.issues).toEqual([]);
});

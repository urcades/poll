import { expect, test as base, type Locator, type Page } from "@playwright/test";

/** Reports CSP violations through the console so one listener catches everything. */
const CSP_WATCHER = `
  document.addEventListener("securitypolicyviolation", (event) => {
    console.error("securitypolicyviolation: " + event.violatedDirective + " " + event.blockedURI);
  });
`;

export interface Person {
  page: Page;
  /** Console errors, page errors and CSP violations seen so far. */
  issues: string[];
}

type Fixtures = {
  /** A new isolated browser context (a different person or device). Every one is checked for console errors and CSP violations at the end of the test. */
  person: () => Promise<Person>;
};

/** Starts collecting console errors, page errors and CSP violations for a page. */
export async function watchPage(page: Page): Promise<Person> {
  await page.context().addInitScript(CSP_WATCHER);
  const person: Person = { page, issues: [] };
  page.on("console", (message) => {
    if (message.type() === "error") person.issues.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => person.issues.push(`pageerror: ${error.message}`));
  return person;
}

export const test = base.extend<Fixtures>({
  person: async ({ browser, baseURL }, use) => {
    const people: Array<{ person: Person; close: () => Promise<void> }> = [];
    await use(async () => {
      // Fixed zone and locale so time-poll assertions do not depend on the host.
      const context = await browser.newContext({ baseURL, acceptDownloads: true, timezoneId: "UTC", locale: "en-US" });
      const person = await watchPage(await context.newPage());
      people.push({ person, close: () => context.close() });
      return person;
    });
    const issues = people.flatMap(({ person }) => person.issues);
    await Promise.all(people.map(({ close }) => close()));
    expect(issues, "console errors / CSP violations").toEqual([]);
  }
});

export { expect };

export interface NewPoll {
  title: string;
  /** Visible label in the Type select (default "Choose"; the form itself defaults to Sense check). */
  type?: string;
  details?: string;
  invitees?: string[];
  hideResults?: "Until vote is cast" | "Until poll is closed";
  /** Replaces the default option labels of non-fixed types. */
  options?: string[];
  /** Time polls: datetime-local values (`2030-05-14T10:00`) for the slots; the editor starts with three. */
  slots?: string[];
}

export function slugOf(page: Page): string {
  const match = /\/poll\/([^/?#]+)/.exec(new URL(page.url()).pathname);
  if (!match?.[1]) throw new Error(`Not on a poll page: ${page.url()}`);
  return match[1];
}

/** Drives /new like a person would and returns once the draft page has loaded. */
export async function createDraft(page: Page, poll: NewPoll): Promise<string> {
  await page.goto("/");
  await (await pageAction(page, "link", "New vote/proposal")).click();
  await expect(page).toHaveURL(/\/new$/);
  await page.locator("#type").waitFor();
  // Wait for hydration so the editor's own handlers exist before we type.
  await expect(page.getByRole("heading", { name: /Options|Candidates|Timeslots|Voting positions/ })).toBeVisible();
  await page.locator("#type").selectOption({ label: poll.type ?? "Choose" });
  await page.getByLabel("Title", { exact: true }).fill(poll.title);
  if (poll.details) await page.getByLabel("Details").fill(poll.details);
  if (poll.options) await setOptions(page, poll.options);
  if (poll.slots) {
    const inputs = page.getByLabel(/^Date and time/);
    await expect(inputs).toHaveCount(3);
    for (const [index, slot] of poll.slots.entries()) await inputs.nth(index).fill(slot);
  }
  if (poll.invitees) {
    await page.getByRole("radio", { name: "Invite only" }).check();
    await page.getByLabel("Invited voters").fill(poll.invitees.join("\n"));
  }
  if (poll.hideResults) {
    await page.getByText("Advanced settings", { exact: true }).first().click();
    await page.getByRole("radio", { name: poll.hideResults }).check();
  }
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page).toHaveURL(/\/poll\/[A-Za-z0-9]{10}$/);
  await expect(page.getByRole("heading", { name: "Draft preview" })).toBeVisible();
  return slugOf(page);
}

/** Overwrites the option rows in the editor (adds or removes rows as needed). */
async function setOptions(page: Page, labels: string[]) {
  const rows = page.locator("#option-blocks .option-block");
  while ((await rows.count()) < labels.length) await page.getByRole("button", { name: "Add option" }).click();
  while ((await rows.count()) > labels.length) await rows.last().getByRole("button", { name: "Remove" }).click();
  for (const [index, label] of labels.entries()) {
    await rows.nth(index).locator("input").first().fill(label);
  }
}

/**
 * Page actions live in the header: the primary button, plus secondary actions
 * inside the "Poll options" dropdown.
 */
export async function pageAction(page: Page, role: "button" | "link", name: string | RegExp): Promise<Locator> {
  const target = page.getByRole(role, { name });
  if (!(await target.isVisible())) {
    const more = page.locator(".page-header summary", { hasText: "Poll options" });
    if (await more.isVisible()) await more.click();
  }
  await target.waitFor();
  return target;
}

export async function openVoting(page: Page) {
  await (await pageAction(page, "button", "Open voting")).click();
  await expect(page.getByRole("heading", { name: "Vote", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Draft preview" })).toHaveCount(0);
  await pageAction(page, "button", "Close poll");
}

export async function closePoll(page: Page) {
  await (await pageAction(page, "button", "Close poll")).click();
  await expect(page.getByText("Voting is not open.")).toBeVisible();
}

/** The real vote form (not the inert draft preview). */
export function voteForm(page: Page): Locator {
  return page.locator("form[action='?/vote']");
}

/**
 * After voting: admins (and polls that allow changes) get "Update vote";
 * everyone else sees their ballot locked with "Your vote is in".
 */
export async function expectVoted(page: Page) {
  await expect(page.getByText("Your vote is in").or(page.getByRole("button", { name: "Update vote" })).first()).toBeVisible();
}

/** The vote button is the page's primary action, in the header. */
export async function submitVote(page: Page, button: "Submit vote" | "Update vote" = "Submit vote") {
  await page.getByRole("button", { name: button, exact: true }).click();
}

/** Waits for SvelteKit to hydrate, so form enhancement is active before interacting. */
export async function settled(page: Page) {
  await page.waitForLoadState("networkidle");
}

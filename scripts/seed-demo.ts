/**
 * Seeds one open, realistic poll of every type (with votes) into the app's
 * database, going through the real API handlers so everything is validated
 * exactly as it would be from the UI. Prints each poll's link plus an admin
 * link: opening the admin link makes your browser that poll's admin, which
 * also lists it under "My votes".
 *
 *   bun scripts/seed-demo.ts               # uses DB_PATH or work/votes.sqlite
 *   DB_PATH=/tmp/demo.sqlite bun scripts/seed-demo.ts
 *
 * Handlers are called directly, so the HTTP rate limiter does not apply.
 */
import { POST as createPoll } from "../src/routes/api/polls/+server";
import { POST as openPoll } from "../src/routes/api/polls/[id]/open/+server";
import { POST as castVote } from "../src/routes/api/polls/[id]/votes/+server";
import { load as pollPage } from "../src/routes/poll/[id]/+page.server";
import { getStore } from "../src/lib/server/app";
import { defaultOptionsText } from "../src/templates";
import type { PollType } from "../src/types";

const ORIGIN = process.env.DEMO_ORIGIN ?? "http://localhost:5173";

type Jar = ReturnType<typeof cookieJar>;
type Ballot = Record<string, unknown>;
type Voter = { name: string; ballot: (ids: number[]) => Ballot; reason?: string };

function cookieJar() {
  const jar = new Map<string, string>();
  return {
    get: (name: string) => jar.get(name),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
    getAll: () => [...jar].map(([name, value]) => ({ name, value }))
  };
}

const request = (body: unknown) =>
  new Request("http://seed.local", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function call(handler: Function, event: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = (await handler(event)) as Response;
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${response.status}: ${body.error ?? JSON.stringify(body)}`);
  return body;
}

/** Option ids for a poll, in the order they were entered. */
function optionIds(slug: string): number[] {
  const poll = getStore().getPollBySlug(slug);
  if (!poll) throw new Error(`Poll ${slug} not found`);
  return getStore().getOptions(poll.id).map((option) => option.id);
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

/** Upcoming weekday slots at the given UTC hours, starting next Monday. */
function nextWeekSlots(hours: Array<[weekdayOffset: number, hourUtc: number]>): string[] {
  const now = new Date();
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + ((8 - now.getUTCDay()) % 7 || 7)));
  return hours.map(([offset, hour]) => new Date(monday.getTime() + offset * 86_400_000 + hour * 3_600_000).toISOString());
}

// Ballot builders (field names match the vote API).
const position = (index: number) => (ids: number[]) => ({ optionId: ids[index] });
const pick = (...indexes: number[]) => (ids: number[]) => ({ selected: indexes.map((index) => ids[index]) });
const scores = (...values: number[]) => (ids: number[]) => Object.fromEntries(ids.map((id, index) => [`score_${id}`, values[index] ?? 0]));
const points = (...values: number[]) => (ids: number[]) => Object.fromEntries(ids.map((id, index) => [`allocation_${id}`, values[index] ?? 0]));
const ranking = (...indexes: number[]) => (ids: number[]) => Object.fromEntries(indexes.map((index, rank) => [`rank_${rank + 1}`, ids[index]]));
const availability = (...states: Array<"a" | "i" | "u">) => (ids: number[]) =>
  Object.fromEntries(ids.map((id, index) => [`availability_${id}`, { a: "available", i: "if_needed", u: "unavailable" }[states[index] ?? "u"]]));

type Demo = { poll: Record<string, unknown>; voters: Voter[]; invite?: boolean };

const [monAm, monPm, tueAm, wedPm] = nextWeekSlots([[0, 15], [0, 19], [1, 16], [2, 20]]);

const demos: Demo[] = [
  {
    poll: {
      type: "sense_check",
      title: "Move the spring offsite to the coast?",
      details: "Rather than the usual city venue, we could rent a house near Point Reyes for two nights. Cost is roughly the same; travel is about 90 minutes longer.",
      closesAt: inDays(6)
    },
    voters: [
      { name: "Maya", ballot: position(0), reason: "A change of scene would do us good." },
      { name: "Tomás", ballot: position(0) },
      { name: "Priya", ballot: position(1), reason: "Love it, but let's sort carpools early." },
      { name: "Jonah", ballot: position(0), reason: "Yes, as long as there's decent wifi." },
      { name: "Ines", ballot: position(2), reason: "The drive is hard for anyone with kids at home." },
      { name: "Kofi", ballot: position(1) },
      { name: "Lena", ballot: position(0) }
    ]
  },
  {
    poll: {
      type: "consent",
      title: "Try a four-day week through November",
      details: "Fridays off for everyone, with core hours Monday to Thursday. We'd review at the end of the month.",
      closesAt: inDays(4)
    },
    voters: [
      { name: "Maya", ballot: position(0), reason: "Safe to try; we can always revert." },
      { name: "Tomás", ballot: position(0) },
      { name: "Priya", ballot: position(0) },
      { name: "Jonah", ballot: position(1), reason: "Support's on-call rota isn't solved yet. Happy to consent once it is." },
      { name: "Ines", ballot: position(0) },
      { name: "Kofi", ballot: position(0), reason: "Worth an experiment." }
    ]
  },
  {
    poll: {
      type: "consensus",
      title: "Adopt the shared kitchen agreement",
      details: "Draft agreement: dishes done by end of day, fridge cleared every Friday at 4pm, and a rotating weekly lead for supplies.",
      closesAt: inDays(5)
    },
    voters: [
      { name: "Maya", ballot: position(0) },
      { name: "Tomás", ballot: position(0), reason: "Clear and fair." },
      { name: "Priya", ballot: position(1), reason: "I'm rarely in the office, so I'll stand aside." },
      { name: "Jonah", ballot: position(0) },
      { name: "Ines", ballot: position(2), reason: "Friday at 4 clashes with our team sync; I won't block though." },
      { name: "Kofi", ballot: position(0) },
      { name: "Lena", ballot: position(0) }
    ]
  },
  {
    poll: {
      type: "majority",
      title: "Book the 7pm table at Lupa for Thursday?",
      details: "They can hold a table for 10 until Tuesday noon.",
      closesAt: inDays(2)
    },
    voters: [
      { name: "Maya", ballot: position(0) },
      { name: "Tomás", ballot: position(0) },
      { name: "Priya", ballot: position(1), reason: "7 is too early for me; 8 would work." },
      { name: "Jonah", ballot: position(0) },
      { name: "Ines", ballot: position(0) },
      { name: "Kofi", ballot: position(1) },
      { name: "Lena", ballot: position(0), reason: "Their cacio e pepe is worth it." },
      { name: "Ravi", ballot: position(0) }
    ]
  },
  {
    poll: {
      type: "choose",
      title: "Which two films for Friday's movie night?",
      details: "We'll screen the top two back to back. Pick up to two.",
      optionsText: "Past Lives | Seoul, New York, and a 24-year question\nPerfect Days | A Tokyo toilet cleaner's quiet routine\nThe Holdovers | Stuck at boarding school over Christmas\nAnatomy of a Fall | A courtroom drama in the Alps\nPoor Things | A surreal Victorian odyssey",
      minChoices: 1,
      maxChoices: 2,
      closesAt: inDays(3)
    },
    voters: [
      { name: "Maya", ballot: pick(0, 1) },
      { name: "Tomás", ballot: pick(2, 3), reason: "Something with a bit of tension." },
      { name: "Priya", ballot: pick(0, 2) },
      { name: "Jonah", ballot: pick(1) },
      { name: "Ines", ballot: pick(0, 4) },
      { name: "Kofi", ballot: pick(3, 1) },
      { name: "Lena", ballot: pick(0, 1), reason: "Two gentle ones to end the week." },
      { name: "Ravi", ballot: pick(2) }
    ]
  },
  {
    poll: {
      type: "approval",
      title: "Which restaurants work for the team lunch?",
      details: "Tick every place you'd be happy with. Budget is about $30 a head.",
      optionsText: "Burma Superstar\nTartine Manufactory\nLa Taqueria\nNopa\nSouvla\nZuni Café",
      closesAt: inDays(2)
    },
    voters: [
      { name: "Maya", ballot: pick(0, 2, 4) },
      { name: "Tomás", ballot: pick(2, 3) },
      { name: "Priya", ballot: pick(0, 1, 4), reason: "Vegetarian options matter to me." },
      { name: "Jonah", ballot: pick(2) },
      { name: "Ines", ballot: pick(0, 3, 4, 5) },
      { name: "Kofi", ballot: pick(1, 2, 4) },
      { name: "Lena", ballot: pick(0, 4) }
    ]
  },
  {
    poll: {
      type: "score",
      title: "Rate the venue options for the launch party",
      details: "0 means it won't work at all; 5 means perfect.",
      optionsText: "The Midway | Big warehouse space in Dogpatch\nMonarch | Two floors, near BART\nThe Chapel | Live-music venue in the Mission\nFort Mason Pier 2 | Waterfront, needs a caterer",
      scoreMin: 0,
      scoreMax: 5,
      closesAt: inDays(5)
    },
    voters: [
      { name: "Maya", ballot: scores(4, 3, 5, 2) },
      { name: "Tomás", ballot: scores(5, 2, 4, 3), reason: "The Midway handles a crowd easily." },
      { name: "Priya", ballot: scores(3, 4, 4, 1) },
      { name: "Jonah", ballot: scores(2, 3, 5, 4) },
      { name: "Ines", ballot: scores(4, 4, 3, 5), reason: "Can't beat the view at Fort Mason." },
      { name: "Kofi", ballot: scores(5, 1, 4, 2) }
    ]
  },
  {
    poll: {
      type: "allocate",
      title: "Split 10 points across next quarter's projects",
      details: "Put your points where you think our time matters most. You don't have to use them all.",
      optionsText: "Mobile app rewrite\nOnboarding redesign\nBilling migration\nDocs overhaul\nPerformance sprint",
      pointBudget: 10,
      closesAt: inDays(7)
    },
    voters: [
      { name: "Maya", ballot: points(4, 3, 2, 0, 1) },
      { name: "Tomás", ballot: points(0, 2, 6, 0, 2), reason: "Billing is a ticking clock." },
      { name: "Priya", ballot: points(2, 5, 1, 2, 0) },
      { name: "Jonah", ballot: points(3, 1, 3, 1, 2) },
      { name: "Ines", ballot: points(0, 4, 2, 4, 0), reason: "New users keep asking the same questions." },
      { name: "Kofi", ballot: points(5, 0, 3, 0, 2) }
    ]
  },
  {
    poll: {
      type: "rank",
      title: "Rank your top three ideas for the summer trip",
      details: "First choice gets 3 points, second 2, third 1.",
      optionsText: "Hiking in Yosemite\nWine country weekend\nTahoe cabin\nBig Sur camping\nMendocino coast",
      rankCount: 3,
      closesAt: inDays(6)
    },
    voters: [
      { name: "Maya", ballot: ranking(0, 3, 2) },
      { name: "Tomás", ballot: ranking(2, 0, 4) },
      { name: "Priya", ballot: ranking(1, 4, 2), reason: "Somewhere I can actually rest." },
      { name: "Jonah", ballot: ranking(0, 2, 3) },
      { name: "Ines", ballot: ranking(3, 0, 4) },
      { name: "Kofi", ballot: ranking(2, 0, 1) },
      { name: "Lena", ballot: ranking(4, 1, 3) }
    ]
  },
  {
    poll: {
      type: "irv",
      title: "Pick a name for the new design team",
      details: "Rank as many as you like. Last place is eliminated each round until one name has a majority.",
      optionsText: "Studio North\nThe Workshop\nFieldwork\nLoom\nOpen Door",
      closesAt: inDays(4)
    },
    // Loom leads first preferences 4-3 but lacks a majority of 11. Studio North
    // and Open Door go out first, then The Workshop; their transfers carry
    // Fieldwork past Loom to win 7-4 in the final round.
    voters: [
      { name: "Maya", ballot: ranking(3, 1) },
      { name: "Tomás", ballot: ranking(3, 2) },
      { name: "Priya", ballot: ranking(3) },
      { name: "Jonah", ballot: ranking(3, 0) },
      { name: "Ines", ballot: ranking(2, 1, 0), reason: "Fieldwork sounds like how we actually work." },
      { name: "Kofi", ballot: ranking(2, 3) },
      { name: "Lena", ballot: ranking(2, 0) },
      { name: "Ravi", ballot: ranking(1, 2) },
      { name: "Sofia", ballot: ranking(1, 2, 3) },
      { name: "Wen", ballot: ranking(0, 2) },
      { name: "Amara", ballot: ranking(4, 2, 1) }
    ]
  },
  {
    poll: {
      type: "stv",
      title: "Elect two organizers for the 2027 meetup series",
      details: "Two seats. Rank the candidates in order of preference; surplus votes transfer.",
      optionsText: "Ada Okafor | Ran the 2025 hack day\nBen Carter | Venue and sponsor contacts\nChen Li | Community Discord moderator\nDiana Ruiz | Speaker program lead\nEli Novak | First-time volunteer",
      seats: 2,
      closesAt: inDays(8)
    },
    // Quota is 5 of 12. Ada's surplus of 2 transfers mostly to Diana.
    voters: [
      { name: "Maya", ballot: ranking(0, 3) },
      { name: "Tomás", ballot: ranking(0, 3) },
      { name: "Priya", ballot: ranking(0, 1) },
      { name: "Jonah", ballot: ranking(0, 3, 2) },
      { name: "Ines", ballot: ranking(0, 2) },
      { name: "Kofi", ballot: ranking(0, 3) },
      { name: "Lena", ballot: ranking(0, 1) },
      { name: "Ravi", ballot: ranking(3, 2) },
      { name: "Sofia", ballot: ranking(1, 3) },
      { name: "Wen", ballot: ranking(2, 3), reason: "Chen knows the community best." },
      { name: "Amara", ballot: ranking(4, 3) },
      { name: "Jules", ballot: ranking(1, 0) }
    ]
  },
  {
    invite: true,
    poll: {
      type: "time_poll",
      title: "Launch planning call",
      details: "One hour to walk through the launch checklist. Mark every slot that works; 'if needed' is fine.",
      optionsText: [monAm, monPm, tueAm, wedPm].join("\n"),
      meetingDurationMinutes: 60,
      voterMode: "invite",
      inviteesText: "Maya\nTomás\nPriya\nJonah\nInes\nKofi",
      closesAt: inDays(3)
    },
    voters: [
      { name: "Maya", ballot: availability("a", "a", "i", "u") },
      { name: "Tomás", ballot: availability("a", "u", "a", "i") },
      { name: "Priya", ballot: availability("i", "a", "a", "u"), reason: "Tuesday is easiest for me." },
      { name: "Jonah", ballot: availability("a", "i", "u", "a") }
    ]
  }
];

console.log(`Seeding ${demos.length} demo polls into ${process.env.DB_PATH ?? "work/votes.sqlite"}\n`);

for (const demo of demos) {
  const admin = cookieJar();
  // Proposals use their fixed positions, exactly as the editor pre-fills them.
  const poll = { optionsText: defaultOptionsText(demo.poll.type as PollType), ...demo.poll };
  const { id: slug, adminToken } = (await call(createPoll, { request: request(poll), cookies: admin })) as { id: string; adminToken: string };
  await call(openPoll, { params: { id: slug }, cookies: admin });
  const ids = optionIds(slug);

  // Invite-only polls: each voter follows their personal link first.
  const inviteLinks = new Map<string, string>();
  if (demo.invite) {
    const page = (await pollPage({ params: { id: slug }, url: new URL(`${ORIGIN}/poll/${slug}`), cookies: admin } as never)) as { invitations: Array<{ name: string; link: string | null }> };
    for (const invitation of page.invitations) if (invitation.link) inviteLinks.set(invitation.name, invitation.link);
  }

  for (const voter of demo.voters) {
    const jar: Jar = cookieJar();
    const link = inviteLinks.get(voter.name);
    if (link) {
      try {
        await pollPage({ params: { id: slug }, url: new URL(link, ORIGIN), cookies: jar } as never);
      } catch {
        // The page redirects after swapping ?invite= for a cookie.
      }
    }
    await call(castVote, {
      params: { id: slug },
      request: request({ voterName: voter.name, reason: voter.reason ?? "", ...voter.ballot(ids) }),
      cookies: jar
    });
  }

  console.log(`${String(demo.poll.type).padEnd(12)} ${demo.poll.title}`);
  console.log(`             poll:  ${ORIGIN}/poll/${slug}`);
  console.log(`             admin: ${ORIGIN}/poll/${slug}?admin=${encodeURIComponent(adminToken)}\n`);
}

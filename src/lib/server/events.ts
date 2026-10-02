import type { EventFilter, EventRow } from "../../db";
import type { Option, Poll, Vote } from "../../types";
import { getStore } from "./app";
import { currentContext } from "./context";

/**
 * Usage log. Every notable thing that happens (a description sent to Jev, a
 * poll created or changed, a vote cast, an agent tool called, a click in the
 * browser) becomes one row in the `events` table of the app's own database,
 * so prompts, polls and votes can be joined, and one JSON line on stdout, which
 * Cloudflare's log stream and `fly logs` pick up.
 *
 * What is never recorded: tokens (admin, vote, invite, operator), IP addresses,
 * cookies, text typed into fields, or - on anonymous polls - anything that
 * could tie a ballot to a person (voter name, session). Invitee names are
 * counted, not stored. Logging never breaks a request.
 */

const MAX_DATA_BYTES = 60_000;
const PRUNE_EVERY = 500;
let sincePrune = 0;

export function eventLoggingEnabled(): boolean {
  return !["off", "0", "false", "no", "disabled"].includes((process.env.EVENT_LOG ?? "").trim().toLowerCase());
}

function retentionDays(): number {
  const days = Number.parseInt(process.env.EVENT_RETENTION_DAYS ?? "", 10);
  return Number.isFinite(days) && days > 0 ? days : 365;
}

export interface EventExtras {
  pollSlug?: string;
  /** Pass "" to record an event with no session (anonymous polls). */
  session?: string;
  /** Overrides the request's source; browser-reported events say so. */
  source?: string;
}

export function logEvent(kind: string, data: Record<string, unknown> = {}, extras: EventExtras = {}): void {
  if (!eventLoggingEnabled()) return;
  try {
    const context = currentContext();
    let payload = context.tool ? { tool: context.tool, ...data } : data;
    if (JSON.stringify(payload).length > MAX_DATA_BYTES) payload = { truncated: true, preview: JSON.stringify(payload).slice(0, 2000) };
    const event = {
      ts: new Date().toISOString(),
      kind,
      source: extras.source ?? context.source,
      pollSlug: extras.pollSlug ?? "",
      session: extras.session ?? context.session,
      data: payload
    };
    const id = getStore().insertEvent(event);
    if (process.env.NODE_ENV !== "test" && process.env.EVENT_STDOUT !== "off") console.log(JSON.stringify({ usageEvent: true, id, ...event }));
    if (++sincePrune >= PRUNE_EVERY) {
      sincePrune = 0;
      getStore().pruneEvents(new Date(Date.now() - retentionDays() * 86_400_000).toISOString());
    }
  } catch (error) {
    console.error("Could not record usage event", error);
  }
}

// ---- Shapes shared by the instrumentation ----------------------------------

type PollContent = Pick<Poll, "type" | "title" | "details" | "config" | "opensAt" | "closesAt">;

/** Everything a person set up in a poll (except who is invited). */
export function pollSnapshot(poll: PollContent, options: Array<{ label: string; meaning: string }>, inviteeCount = 0) {
  return {
    type: poll.type,
    title: poll.title,
    details: poll.details,
    config: poll.config,
    opensAt: poll.opensAt,
    closesAt: poll.closesAt,
    options: options.map((option) => ({ label: option.label, meaning: option.meaning })),
    inviteeCount
  };
}

/** How a saved poll differs from what Jev pre-filled, so prompts can be scored against outcomes. */
export function diffFromSuggestion(suggestion: Record<string, unknown>, saved: ReturnType<typeof pollSnapshot>) {
  const changed: string[] = [];
  if (suggestion.type !== saved.type) changed.push("type");
  if (suggestion.title !== saved.title) changed.push("title");
  const expectedOptions = typeof suggestion.optionsText === "string" ? suggestion.optionsText.split("\n").map((line) => line.split("|")[0]?.trim() ?? "").filter(Boolean) : null;
  if (expectedOptions && JSON.stringify(expectedOptions) !== JSON.stringify(saved.options.map((option) => option.label))) changed.push("options");
  const config = (suggestion.config ?? {}) as Record<string, unknown>;
  const savedConfig = saved.config as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(config)) {
    if (JSON.stringify(savedConfig[key]) !== JSON.stringify(value)) changed.push(`config.${key}`);
  }
  return { changed, unchanged: changed.length === 0 };
}

/** Option ids to labels, so a logged ballot is readable without the poll. */
export function optionLabels(options: Option[]): Record<string, string> {
  return Object.fromEntries(options.map((option) => [String(option.id), option.label]));
}

export function voteSummary(votes: Vote[]) {
  return { votes: votes.length };
}

// ---- Reading ---------------------------------------------------------------

export function readEvents(filter: EventFilter): EventRow[] {
  return getStore().listEvents(filter);
}

export function eventsToCsv(events: EventRow[], csvCell: (value: unknown) => string): string {
  const header = ["id", "ts", "kind", "source", "poll_slug", "session", "data_json"];
  return [header.join(","), ...events.map((event) => [event.id, event.ts, event.kind, event.source, event.pollSlug, event.session, JSON.stringify(event.data)].map(csvCell).join(","))].join("\n");
}

// ---- Client events ----------------------------------------------------------

const clipText = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Paths only: no query string or fragment, which is where admin and invite tokens ride. */
export function cleanPath(value: unknown): string {
  const text = clipText(value, 200);
  if (!text.startsWith("/")) return "";
  return text.split(/[?#]/)[0] ?? "";
}

export function pollSlugOf(path: string): string {
  return /^\/poll\/([A-Za-z0-9]{10})(?:\/|$)/.exec(path)?.[1] ?? "";
}


// ---- Filters shared by the operator page, the exports and the MCP tool -------

const text = (value: unknown, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export function filterFromInput(get: (key: string) => unknown): EventFilter {
  const filter: EventFilter = {};
  const set = <K extends keyof EventFilter>(key: K, value: EventFilter[K] | "" | undefined) => {
    if (value !== "" && value !== undefined && !(typeof value === "number" && !Number.isFinite(value))) filter[key] = value as EventFilter[K];
  };
  set("kind", text(get("kind"), 60));
  set("kindPrefix", text(get("kindPrefix"), 60));
  set("pollSlug", text(get("poll"), 40));
  set("session", text(get("session"), 64));
  set("source", text(get("source"), 20));
  set("since", text(get("since"), 40));
  set("until", text(get("until"), 40));
  set("text", text(get("text"), 100));
  const before = Number(get("before"));
  set("before", Number.isInteger(before) && before > 0 ? before : undefined);
  const limit = Number(get("limit"));
  set("limit", Number.isInteger(limit) && limit > 0 ? Math.min(limit, 5000) : undefined);
  return filter;
}

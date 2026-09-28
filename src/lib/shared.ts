import { formatNumber } from "../tally";
import { templateByType } from "../templates";
import type { Poll, PublicTallyResult, RoundLog } from "../types";

export function isClosed(poll: Poll): boolean {
  if (poll.status === "scheduled") return false;
  const now = new Date();
  return poll.status === "closed" || Boolean(poll.manuallyClosedAt) || Boolean(poll.closesAt && new Date(poll.closesAt) <= now);
}

export function isOpen(poll: Poll): boolean {
  const now = new Date();
  if (poll.status !== "open") return false;
  if (isClosed(poll)) return false;
  if (poll.opensAt && new Date(poll.opensAt) > now) return false;
  return true;
}

export function statusLabel(poll: Poll): string {
  if (poll.status === "draft") return "Draft";
  if (poll.status === "scheduled") return "Scheduled";
  return isClosed(poll) ? "Closed" : "Active";
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

/** Timeslot labels in the canonical (and only displayed-as-date) form: full ISO 8601 with a zone. */
const ISO_SLOT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The instant a time-poll label denotes, or null for legacy free text (which is then shown as-is). */
export function parseSlot(label: string): Date | null {
  if (!ISO_SLOT.test(label)) return null;
  const date = new Date(label);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Human text for a timeslot, e.g. "Mon 5 Oct, 14:00-15:00 (GMT+2)". With no
 * `timeZone` it uses the runtime's local zone, so call it in the browser; the
 * server passes "UTC". Non-date labels come back untouched. `minutes <= 0`
 * gives a single moment instead of a range.
 */
export function formatSlot(label: string, minutes = 0, timeZone?: string): string {
  const start = parseSlot(label);
  if (!start) return label;
  const zone = timeZone ? { timeZone } : {};
  const parts = (date: Date, withZone: boolean) => {
    const map: Record<string, string> = {};
    const format = new Intl.DateTimeFormat("en-GB", {
      ...zone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(withZone ? { timeZoneName: "shortOffset" as const } : {})
    });
    for (const part of format.formatToParts(date)) map[part.type] = part.value;
    return map;
  };
  const from = parts(start, true);
  const zoneName = timeZone === "UTC" ? "UTC" : from.timeZoneName ?? "";
  const day = (p: Record<string, string>) => `${p.weekday} ${p.day} ${p.month}`;
  const clock = (p: Record<string, string>) => `${p.hour}:${p.minute}`;
  const suffix = zoneName ? ` (${zoneName})` : "";
  if (!(minutes > 0)) return `${day(from)}, ${clock(from)}${suffix}`;
  const to = parts(new Date(start.getTime() + minutes * 60_000), false);
  const end = day(to) === day(from) ? clock(to) : `${day(to)}, ${clock(to)}`;
  return `${day(from)}, ${clock(from)}\u2013${end}${suffix}`;
}

export interface PollMeta {
  title: string;
  description: string;
  url: string;
  image: string;
}

/** Open Graph / Twitter card fields. Built only from public poll fields and the request origin: never a token, invitee or vote. */
export function pollMeta(poll: Poll, origin: string, path = `/poll/${poll.slug}`, titlePrefix = ""): PollMeta {
  const details = poll.details.replace(/\s+/g, " ").trim();
  return {
    title: `${titlePrefix}${poll.title}`,
    description: details ? shorten(details, 197) : `${labelForPoll(poll)} \u00b7 ${statusLabel(poll)}`,
    url: `${origin}${path}`,
    image: `${origin}/og.png`
  };
}

export function dateTimeLocalValue(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function shorten(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}...`;
}

export function labelForPoll(poll: Poll): string {
  return templateByType.get(poll.type)?.label ?? poll.type;
}

export function formatTallies(tallies: Record<number, number>): Record<string, string> {
  return Object.fromEntries(Object.entries(tallies).map(([key, value]) => [key, formatNumber(value)]));
}

export function resultHeaders(tally: PublicTallyResult): string[] {
  if (tally.type === "score") return ["Rank", "Option", "Total", "Mean", "Voters"];
  if (tally.type === "allocate" || tally.type === "rank") return ["Rank", "Option", "Points", "% points", "Mean"];
  if (tally.type === "time_poll") return ["Rank", "Timeslot", "Available", "If needed", "Unavailable"];
  if (tally.type === "irv") return ["Status", "Candidate", "First prefs", "Final tally", "Elected round"];
  if (tally.type === "stv") return ["Status", "Candidate", "First prefs", "Final tally", "Elected round", "Surplus"];
  return ["Option", "Votes", "%"];
}

export function resultCells(tally: PublicTallyResult, row: PublicTallyResult["rows"][number]): Array<string | number> {
  if (tally.type === "score") return [row.rank ?? "", row.label, formatNumber(row.points ?? 0), formatNumber(row.mean ?? 0), row.count ?? 0];
  if (tally.type === "allocate" || tally.type === "rank") return [row.rank ?? "", row.label, formatNumber(row.points ?? 0), `${formatNumber(row.percent ?? 0)}%`, formatNumber(row.mean ?? 0)];
  if (tally.type === "time_poll") return [row.rank ?? "", row.label, row.available ?? 0, row.ifNeeded ?? 0, row.unavailable ?? 0];
  if (tally.type === "irv") return [row.status ?? "", row.label, formatNumber(row.firstPreferences ?? 0), formatNumber(row.finalTally ?? 0), row.electedRound ?? ""];
  if (tally.type === "stv") return [row.status ?? "", row.label, formatNumber(row.firstPreferences ?? 0), formatNumber(row.finalTally ?? 0), row.electedRound ?? "", formatNumber(row.surplus ?? 0)];
  return [row.label, row.count ?? 0, `${formatNumber(row.percent ?? 0)}%`];
}

export function roundTallies(log: RoundLog): string {
  return JSON.stringify(formatTallies(log.tallies));
}

export interface BarSegment {
  kind: "main" | "available" | "if_needed" | "unavailable";
  /** Share of the full track, 0-100. */
  percent: number;
}

export interface ResultBar {
  optionId: number;
  label: string;
  segments: BarSegment[];
  /** Plain-text value shown next to the bar. */
  text: string;
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

/** One compact bar per result row, showing the poll type's key metric. */
export function resultBars(tally: PublicTallyResult, poll: Poll): ResultBar[] {
  return tally.rows.map((row) => {
    const base = { optionId: row.optionId, label: row.label };
    if (tally.type === "time_poll") {
      const available = row.available ?? 0;
      const ifNeeded = row.ifNeeded ?? 0;
      const unavailable = row.unavailable ?? 0;
      const total = available + ifNeeded + unavailable || 1;
      return {
        ...base,
        segments: [
          { kind: "available", percent: (available / total) * 100 },
          { kind: "if_needed", percent: (ifNeeded / total) * 100 },
          { kind: "unavailable", percent: (unavailable / total) * 100 }
        ],
        text: `${available} / ${ifNeeded} / ${unavailable}`
      };
    }
    if (tally.type === "score") {
      const min = poll.config.scoreMin ?? 0;
      const max = poll.config.scoreMax ?? 5;
      const share = max > min ? ((row.mean ?? 0) - min) / (max - min) * 100 : 0;
      return { ...base, segments: [{ kind: "main", percent: clampPercent(share) }], text: `mean ${formatNumber(row.mean ?? 0)}` };
    }
    if (tally.type === "irv" || tally.type === "stv") {
      const share = tally.castVotes > 0 ? ((row.finalTally ?? 0) / tally.castVotes) * 100 : 0;
      return { ...base, segments: [{ kind: "main", percent: clampPercent(share) }], text: formatNumber(row.finalTally ?? 0) };
    }
    const percent = row.percent ?? 0;
    return { ...base, segments: [{ kind: "main", percent: clampPercent(percent) }], text: `${formatNumber(percent)}%` };
  });
}

export interface RoundBar {
  optionId: number;
  label: string;
  value: number;
  mark: "elected" | "eliminated" | null;
}

export interface RoundStage {
  round: number;
  bars: RoundBar[];
  /** Majority (IRV) or quota (STV) line, when known. */
  threshold: number | null;
}

/** Round-by-round view of an IRV/STV count, derived from `tally.roundLogs`. */
export function roundStages(tally: PublicTallyResult): RoundStage[] {
  const logs = tally.roundLogs ?? [];
  const rows = tally.rows;
  const byLabel = new Map(rows.map((row) => [row.label, row.optionId]));
  const removed = new Set<number>();
  const stages: RoundStage[] = [];
  const rounds = [...new Set(logs.map((log) => log.round))];
  for (const round of rounds) {
    const group = logs.filter((log) => log.round === round);
    const first = group[0];
    if (!first) continue;
    const marks = new Map<number, "elected" | "eliminated">();
    for (const row of rows) if (row.electedRound === round) marks.set(row.optionId, "elected");
    for (const log of group) {
      const match = /^eliminate (.+)$/.exec(log.action);
      const id = match ? byLabel.get(match[1] ?? "") : undefined;
      if (id !== undefined) marks.set(id, "eliminated");
    }
    const bars = rows
      .filter((row) => !removed.has(row.optionId))
      .map((row) => ({ optionId: row.optionId, label: row.label, value: first.tallies[row.optionId] ?? 0, mark: marks.get(row.optionId) ?? null }))
      .sort((a, b) => b.value - a.value);
    const threshold = tally.type === "irv" ? bars.reduce((sum, bar) => sum + bar.value, 0) / 2 : tally.quota ?? null;
    stages.push({ round, bars, threshold });
    for (const id of marks.keys()) removed.add(id);
  }
  return stages;
}

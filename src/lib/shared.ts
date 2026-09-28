import { formatNumber } from "../tally";
import { templateByType } from "../templates";
import type { Poll, PublicTallyResult, RoundLog } from "../types";

export function isClosed(poll: Poll): boolean {
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
  return isClosed(poll) ? "Closed" : "Active";
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleString();
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

import { formatNumber } from "../tally";
import { templateByType } from "../templates";
import type { Poll, RoundLog, TallyResult } from "../types";

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

export function resultHeaders(tally: TallyResult): string[] {
  if (tally.type === "score") return ["Rank", "Option", "Total", "Mean", "Voters"];
  if (tally.type === "allocate" || tally.type === "rank") return ["Rank", "Option", "Points", "% points", "Mean"];
  if (tally.type === "time_poll") return ["Rank", "Timeslot", "Available", "If needed", "Unavailable"];
  if (tally.type === "irv") return ["Status", "Candidate", "First prefs", "Final tally", "Elected round"];
  if (tally.type === "stv") return ["Status", "Candidate", "First prefs", "Final tally", "Elected round", "Surplus"];
  return ["Option", "Votes", "%"];
}

export function resultCells(tally: TallyResult, row: TallyResult["rows"][number]): Array<string | number> {
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

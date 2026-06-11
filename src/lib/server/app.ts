import { error, json, redirect } from "@sveltejs/kit";
import { Store, type CreatePollInput } from "../../db";
import { baseConfig, defaultConfigFor, templateByType } from "../../templates";
import { validateBallot } from "../../tally";
import { POLL_TYPES, type Option, type Poll, type PollConfig, type PollType, type Vote } from "../../types";
import { isClosed, isOpen } from "../shared";

let store: Store | null = null;

export function getStore(): Store {
  store ??= new Store(process.env.DB_PATH ?? "work/votes.sqlite");
  return store;
}

export function resetStoreForTesting(path = ":memory:"): Store {
  store?.close();
  store = new Store(path);
  return store;
}

export function canShowResults(poll: Poll, viewerVote: Vote | null): boolean {
  if (poll.status === "draft") return false;
  if (isClosed(poll)) return true;
  if (poll.config.hideResults === "off") return true;
  if (poll.config.hideResults === "after_vote") return Boolean(viewerVote);
  return false;
}

export async function inputFromRequest(request: Request): Promise<CreatePollInput> {
  const data = await readData(request);
  return inputFromData(data);
}

export function inputFromData(data: Record<string, unknown>): CreatePollInput {
  const type = parseType(data.type);
  if (!type) throw new Error("Invalid poll type.");
  const title = stringField(data.title).trim();
  if (!title) throw new Error("Title is required.");
  const options = parseOptions(stringField(data.optionsText));
  const config = parseConfig(type, data);
  validatePollSetup(type, config, options);
  return {
    type,
    title,
    details: stringField(data.details),
    config,
    opensAt: dateField(data.opensAt),
    closesAt: dateField(data.closesAt),
    options
  };
}

export async function voteInputFromRequest(request: Request, poll: Poll, options: Option[]) {
  const data = await readData(request);
  const voterName = stringField(data.voterName).trim();
  if (!voterName) throw new Error("Display name is required.");
  const reason = poll.config.reasonMode === "disabled" ? "" : stringField(data.reason).trim();
  if (poll.config.reasonMode === "required" && !reason) throw new Error("A reason is required.");
  const ballot = parseBallot(poll, options, data);
  const ballotError = validateBallot(poll, options, ballot);
  if (ballotError) throw new Error(ballotError);
  return { voterName, reason, ballot };
}

export function openPollOrThrow(pollId: number) {
  const db = getStore();
  const poll = db.getPoll(pollId);
  if (!poll) throw new Error("Poll not found.");
  if (!db.openPoll(poll.id)) throw new Error("Only draft polls can be opened.");
  return poll;
}

export function closePollOrThrow(pollId: number) {
  const db = getStore();
  const poll = db.getPoll(pollId);
  if (!poll) throw new Error("Poll not found.");
  if (poll.status === "draft") throw new Error("Open the draft before closing it.");
  db.closePoll(poll.id);
  return poll;
}

export function exportVotes(poll: Poll, votes: Vote[]): Array<{ voterName: string; ballot: unknown; reason: string; updatedAt: string }> {
  return votes.map((vote, index) => ({
    voterName: poll.config.anonymous ? `Voter ${index + 1}` : vote.voterName,
    ballot: vote.ballot,
    reason: poll.config.anonymous ? "" : vote.reason,
    updatedAt: vote.updatedAt
  }));
}

export function csvCell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function ensurePoll(id: number): Poll {
  const poll = getStore().getPoll(id);
  if (!poll) error(404, "Poll not found.");
  return poll;
}

export function redirectTo(location: string) {
  redirect(303, location);
}

export function jsonOk(body: unknown = { ok: true }) {
  return json(body);
}

export async function readData(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return await request.json() as Record<string, unknown>;
  const form = await request.formData();
  const data: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (Object.hasOwn(data, key)) {
      const existing = data[key];
      data[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      data[key] = value;
    }
  }
  return data;
}

function validatePollSetup(type: PollType, config: PollConfig, options: Array<{ label: string; meaning: string }>) {
  if (options.length < 1) throw new Error("At least one option is required.");

  if (["sense_check", "consent", "consensus", "majority"].includes(type)) {
    const expected = templateByType.get(type)?.defaultOptions.map((option) => option.label) ?? [];
    const actual = options.map((option) => option.label);
    if (expected.length !== actual.length || expected.some((label, index) => label !== actual[index])) {
      throw new Error(`${templateByType.get(type)?.label ?? type} uses fixed voting positions: ${expected.join(", ")}.`);
    }
  }

  if (type === "choose") {
    const min = config.minChoices ?? 1;
    const max = config.maxChoices ?? 1;
    if (min < 0) throw new Error("Minimum choices cannot be negative.");
    if (max < 1) throw new Error("Maximum choices must be at least 1.");
    if (min > max) throw new Error("Minimum choices cannot exceed maximum choices.");
    if (max > options.length) throw new Error("Maximum choices cannot exceed the number of options.");
  }

  if (type === "score" && (config.scoreMin ?? 0) > (config.scoreMax ?? 5)) {
    throw new Error("Maximum score must be greater than or equal to minimum score.");
  }

  if (type === "allocate" && (config.pointBudget ?? 8) < 1) {
    throw new Error("Point budget must be at least 1.");
  }

  if (type === "rank") {
    const rankCount = config.rankCount ?? options.length;
    if (rankCount < 1) throw new Error("Number of ranked choices must be at least 1.");
    if (rankCount > options.length) throw new Error("Number of ranked choices cannot exceed the number of options.");
  }

  if (type === "irv" && options.length < 2) throw new Error("IRV needs at least 2 candidates.");

  if (type === "stv") {
    const seats = config.seats ?? 1;
    if (options.length < 2) throw new Error("STV needs at least 2 candidates.");
    if (seats < 1) throw new Error("STV seats must be at least 1.");
    if (seats >= options.length) throw new Error("STV seats must be less than the number of candidates.");
  }

  if (type === "time_poll" && (config.meetingDurationMinutes ?? 60) < 1) {
    throw new Error("Meeting duration must be at least 1 minute.");
  }
}

function parseConfig(type: PollType, data: Record<string, unknown>): PollConfig {
  const config = { ...defaultConfigFor(type) };
  config.anonymous = boolField(data.anonymous);
  config.hideResults = ["off", "after_vote", "after_close"].includes(stringField(data.hideResults)) ? stringField(data.hideResults) as PollConfig["hideResults"] : baseConfig.hideResults;
  config.reasonMode = ["optional", "required", "disabled"].includes(stringField(data.reasonMode)) ? stringField(data.reasonMode) as PollConfig["reasonMode"] : baseConfig.reasonMode;
  config.quorumPercent = numberField(data.quorumPercent, 0);
  config.eligibleVoterCount = numberField(data.eligibleVoterCount, 0);
  config.allowComments = boolField(data.allowComments);
  config.allowReactions = boolField(data.allowReactions);
  config.shuffleOptions = boolField(data.shuffleOptions);
  if (type === "choose") {
    config.minChoices = numberField(data.minChoices, 1);
    config.maxChoices = numberField(data.maxChoices, 1);
  }
  if (type === "score") {
    config.scoreMin = numberField(data.scoreMin, 0);
    config.scoreMax = numberField(data.scoreMax, 5);
  }
  if (type === "allocate") config.pointBudget = numberField(data.pointBudget, 8);
  if (type === "rank") config.rankCount = numberField(data.rankCount, 3);
  if (type === "stv") {
    config.seats = numberField(data.seats, 1);
    config.stvMethod = stringField(data.stvMethod) === "meek" ? "meek" : "scottish";
    config.quotaType = stringField(data.quotaType) === "hare" ? "hare" : "droop";
  }
  if (type === "time_poll") config.meetingDurationMinutes = numberField(data.meetingDurationMinutes, 60);
  return config;
}

function parseBallot(poll: Poll, options: Option[], data: Record<string, unknown>): unknown {
  if (["sense_check", "consent", "consensus", "majority"].includes(poll.type)) return { optionId: numberField(data.optionId, 0) };
  if (poll.type === "choose" || poll.type === "approval") return { selected: arrayField(data.selected).map(Number) };
  if (poll.type === "score") return { scores: Object.fromEntries(options.map((option) => [option.id, numberField(data[`score_${option.id}`], poll.config.scoreMin ?? 0)])) };
  if (poll.type === "allocate") return { allocations: Object.fromEntries(options.map((option) => [option.id, numberField(data[`allocation_${option.id}`], 0)])) };
  if (poll.type === "rank" || poll.type === "irv" || poll.type === "stv") {
    const limit = poll.type === "rank" ? (poll.config.rankCount ?? options.length) : options.length;
    const rankings = Array.from({ length: limit }, (_, index) => numberField(data[`rank_${index + 1}`], 0)).filter((id) => id > 0);
    return { rankings };
  }
  if (poll.type === "time_poll") return { availability: Object.fromEntries(options.map((option) => [option.id, stringField(data[`availability_${option.id}`])])) };
  return {};
}

function parseOptions(text: string): Array<{ label: string; meaning: string }> {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label, ...meaning] = line.split("|");
      return { label: (label ?? "").trim(), meaning: meaning.join("|").trim() };
    })
    .filter((option) => option.label);
}

function parseType(value: unknown): PollType | null {
  return POLL_TYPES.includes(value as PollType) ? value as PollType : null;
}

function stringField(value: unknown): string {
  if (Array.isArray(value)) return stringField(value[0]);
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown, fallback: number): number {
  const n = Number(stringField(value) || value);
  return Number.isFinite(n) ? n : fallback;
}

function boolField(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value === true || value === "true" || value === "on" || value === "1";
}

function arrayField(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function dateField(value: unknown): string | null {
  const raw = stringField(value);
  return raw ? new Date(raw).toISOString() : null;
}

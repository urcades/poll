import { error, json, redirect, type Cookies } from "@sveltejs/kit";
import { Store, type CreatePollInput } from "../../db";
import { baseConfig, defaultConfigFor, templateByType } from "../../templates";
import { tallyPoll, validateBallot } from "../../tally";
import { POLL_TYPES, type Option, type Poll, type PollConfig, type PollType, type TallyResult, type Vote } from "../../types";
import { isClosed, isOpen } from "../shared";

let store: Store | null = null;

export function getStore(): Store {
  store ??= new Store(process.env.DB_PATH ?? "work/votes.sqlite");
  return store;
}

export function resetStoreForTesting(path = ":memory:"): Store {
  store?.close();
  store = new Store(path);
  closedTallyCache.clear();
  return store;
}

// A closed poll's votes can never change, so its tally is computed once.
const closedTallyCache = new Map<number, TallyResult>();

export function tallyFor(poll: Poll, options: Option[], votes: Vote[]): TallyResult {
  if (!isClosed(poll)) return tallyPoll(poll, options, votes);
  let tally = closedTallyCache.get(poll.id);
  if (!tally) {
    tally = tallyPoll(poll, options, votes);
    closedTallyCache.set(poll.id, tally);
  }
  return tally;
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

export const LIMITS = {
  title: 200,
  details: 10_000,
  optionLabel: 200,
  optionMeaning: 500,
  optionCount: 100,
  voterName: 80,
  reason: 10_000
} as const;

function limitedField(value: unknown, label: string, max: number): string {
  const text = stringField(value);
  if (text.length > max) throw new Error(`${label} is too long (max ${max} characters).`);
  return text;
}

export function inputFromData(data: Record<string, unknown>): CreatePollInput {
  const type = parseType(data.type);
  if (!type) throw new Error("Invalid poll type.");
  const title = limitedField(data.title, "Title", LIMITS.title).trim();
  if (!title) throw new Error("Title is required.");
  const options = parseOptions(stringField(data.optionsText));
  const config = parseConfig(type, data);
  validatePollSetup(type, config, options);
  return {
    type,
    title,
    details: limitedField(data.details, "Details", LIMITS.details),
    config,
    opensAt: dateField(data.opensAt),
    closesAt: dateField(data.closesAt),
    options
  };
}

export async function voteInputFromRequest(request: Request, poll: Poll, options: Option[]) {
  const data = await readData(request);
  const voterName = limitedField(data.voterName, "Display name", LIMITS.voterName).trim();
  if (!voterName) throw new Error("Display name is required.");
  const reason = poll.config.reasonMode === "disabled" ? "" : limitedField(data.reason, "Reason", LIMITS.reason).trim();
  if (poll.config.reasonMode === "required" && !reason) throw new Error("A reason is required.");
  const ballot = parseBallot(poll, options, data);
  const ballotError = validateBallot(poll, options, ballot);
  if (ballotError) throw new Error(ballotError);
  return { voterName, reason, ballot };
}

const TOKEN_COOKIE_OPTIONS = { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 } as const;

export function adminTokenCookie(pollId: number): string {
  return `poll_${pollId}_admin_token`;
}

/**
 * Polls created before admin tokens existed have an empty token and stay
 * open to everyone; new polls are managed only by the token holder. A valid
 * `?admin=<token>` URL grants the cookie, so the admin link is shareable.
 */
export function isPollAdmin(cookies: Cookies, pollId: number, urlToken = ""): boolean {
  const token = getStore().getPollAdminToken(pollId);
  if (!token) return true;
  return cookies.get(adminTokenCookie(pollId)) === token || urlToken === token;
}

export function grantAdminFromUrl(cookies: Cookies, pollId: number, urlToken: string) {
  if (urlToken && urlToken === getStore().getPollAdminToken(pollId)) {
    cookies.set(adminTokenCookie(pollId), urlToken, TOKEN_COOKIE_OPTIONS);
  }
}

export function createPollWithAdmin(input: CreatePollInput, cookies: Cookies): { id: number; adminToken: string } {
  const adminToken = crypto.randomUUID();
  const id = getStore().createPoll({ ...input, adminToken });
  cookies.set(adminTokenCookie(id), adminToken, TOKEN_COOKIE_OPTIONS);
  return { id, adminToken };
}

export function requirePollAdmin(cookies: Cookies, pollId: number, urlToken = "") {
  if (!isPollAdmin(cookies, pollId, urlToken)) {
    throw new Error("Only the poll admin can do this. Open the poll's admin link first.");
  }
}

export function voteTokenCookie(pollId: number): string {
  return `poll_${pollId}_vote_token`;
}

export function voterNameCookie(pollId: number): string {
  return `poll_${pollId}_voter_name`;
}

export function voterNameFor(cookies: Cookies, pollId: number): string {
  const raw = cookies.get(voterNameCookie(pollId)) ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

export function voteTokenFor(cookies: Cookies, pollId: number): string {
  return cookies.get(voteTokenCookie(pollId)) ?? "";
}

/**
 * Stores the vote under this browser's edit token (minting one on first vote)
 * so another visitor cannot silently replace it by reusing the display name.
 */
export function recordVote(poll: Poll, vote: { voterName: string; reason: string; ballot: unknown }, cookies: Cookies) {
  const token = voteTokenFor(cookies, poll.id) || crypto.randomUUID();
  getStore().upsertVote(poll.id, vote.voterName, vote.ballot, vote.reason, token);
  cookies.set(voteTokenCookie(poll.id), token, TOKEN_COOKIE_OPTIONS);
  // Remember the name in a cookie so the post-vote redirect can stay clean of
  // `?voterName=` (names in URLs end up in history and logs).
  cookies.set(voterNameCookie(poll.id), encodeURIComponent(vote.voterName), TOKEN_COOKIE_OPTIONS);
}

export function openPollOrThrow(pollId: number, cookies: Cookies) {
  const db = getStore();
  const poll = db.getPoll(pollId);
  if (!poll) throw new Error("Poll not found.");
  requirePollAdmin(cookies, poll.id);
  if (!db.openPoll(poll.id)) throw new Error("Only draft polls can be opened.");
  return poll;
}

export function closePollOrThrow(pollId: number, cookies: Cookies) {
  const db = getStore();
  const poll = db.getPoll(pollId);
  if (!poll) throw new Error("Poll not found.");
  requirePollAdmin(cookies, poll.id);
  if (poll.status === "draft") throw new Error("Open the draft before closing it.");
  db.closePoll(poll.id);
  return poll;
}

export function deletePollOrThrow(pollId: number, cookies: Cookies) {
  const db = getStore();
  const poll = db.getPoll(pollId);
  if (!poll) throw new Error("Poll not found.");
  requirePollAdmin(cookies, poll.id);
  db.deletePoll(poll.id);
  closedTallyCache.delete(poll.id);
  return poll;
}

export function exportVotes(poll: Poll, votes: Vote[]): Array<{ voterName: string; ballot: unknown; reason: string; updatedAt: string }> {
  if (!poll.config.anonymous) {
    return votes.map((vote) => ({
      voterName: vote.voterName,
      ballot: vote.ballot,
      reason: vote.reason,
      updatedAt: vote.updatedAt
    }));
  }
  // Re-order by a name hash and drop timestamps so anonymous exports do not
  // reveal who voted when.
  return [...votes]
    .sort((a, b) => hashString(`${poll.id}:${a.voterName}`) - hashString(`${poll.id}:${b.voterName}`) || a.voterName.localeCompare(b.voterName))
    .map((vote, index) => ({
      voterName: `Voter ${index + 1}`,
      ballot: vote.ballot,
      reason: "",
      updatedAt: ""
    }));
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function csvCell(value: unknown): string {
  let text = String(value ?? "");
  // Guard against spreadsheet formula injection from free-text fields.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
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
  config.quorumPercent = intField(data.quorumPercent, 0, 0, 100);
  config.eligibleVoterCount = intField(data.eligibleVoterCount, 0, 0, 1_000_000);
  config.allowComments = boolField(data.allowComments);
  config.allowReactions = boolField(data.allowReactions);
  config.shuffleOptions = boolField(data.shuffleOptions);
  if (type === "choose") {
    config.minChoices = intField(data.minChoices, 1, 0, 1000);
    config.maxChoices = intField(data.maxChoices, 1, 0, 1000);
  }
  if (type === "score") {
    config.scoreMin = intField(data.scoreMin, 0, -1000, 1000);
    config.scoreMax = intField(data.scoreMax, 5, -1000, 1000);
  }
  if (type === "allocate") config.pointBudget = intField(data.pointBudget, 8, 0, 100_000);
  if (type === "rank") config.rankCount = intField(data.rankCount, 3, 0, 1000);
  if (type === "stv") {
    config.seats = intField(data.seats, 1, 0, 1000);
    config.stvMethod = stringField(data.stvMethod) === "meek" ? "meek" : "scottish";
    config.quotaType = stringField(data.quotaType) === "hare" ? "hare" : "droop";
  }
  if (type === "time_poll") config.meetingDurationMinutes = intField(data.meetingDurationMinutes, 60, 0, 10_080);
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
  const options = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label, ...meaning] = line.split("|");
      return { label: (label ?? "").trim(), meaning: meaning.join("|").trim() };
    })
    .filter((option) => option.label);
  if (options.length > LIMITS.optionCount) throw new Error(`Too many options (max ${LIMITS.optionCount}).`);
  for (const option of options) {
    if (option.label.length > LIMITS.optionLabel) throw new Error(`Option labels are too long (max ${LIMITS.optionLabel} characters).`);
    if (option.meaning.length > LIMITS.optionMeaning) throw new Error(`Option descriptions are too long (max ${LIMITS.optionMeaning} characters).`);
  }
  return options;
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

function intField(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(numberField(value, fallback));
  return Math.min(max, Math.max(min, n));
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
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date.");
  return date.toISOString();
}

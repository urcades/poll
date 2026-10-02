import { error, json, redirect, type Cookies } from "@sveltejs/kit";
import { deriveInviteToken, hashToken, MAX_INVITEES, Store, tokenMatches, type CreatePollInput, type DurableStorage } from "../../db";
import { baseConfig, defaultConfigFor, templateByType } from "../../templates";
import { tallyPoll, validateBallot } from "../../tally";
import { isProposalType, POLL_TYPES, type Invite, type Option, type Poll, type PollConfig, type PollType, type PublicTallyResult, type TallyResult, type Vote } from "../../types";
import { isClosed, parseSlot } from "../shared";
import { seededShuffle } from "../shuffle";

let store: Store | null = null;
let storeDurable: DurableStorage | undefined;

export function getStore(): Store {
  // On Cloudflare the app runs inside one Durable Object, which hands over its
  // SQLite storage here (worker/index.ts); everywhere else it is a file. A
  // restarted object can reuse this isolate with new storage, and the old
  // storage then refuses all I/O, so reopen whenever the storage changes.
  const durable = (globalThis as { __pollDurableStorage?: DurableStorage }).__pollDurableStorage;
  if (store && durable !== storeDurable) store = null;
  storeDurable = durable;
  store ??= new Store(durable ?? process.env.DB_PATH ?? "work/votes.sqlite");
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

/**
 * In invite mode the eligible electorate is the invitee list, so quorum is
 * computed against that instead of the (ignored) hand-typed count. Handed to
 * the tally as a config copy; tally.ts itself is unchanged.
 */
function withEligibleCount(poll: Poll): Poll {
  if (poll.config.voterMode !== "invite") return poll;
  return { ...poll, config: { ...poll.config, eligibleVoterCount: getStore().countInvites(poll.id) } };
}

export function tallyFor(poll: Poll, options: Option[], votes: Vote[]): TallyResult {
  if (!isClosed(poll)) return tallyPoll(withEligibleCount(poll), options, votes);
  let tally = closedTallyCache.get(poll.id);
  if (!tally) {
    tally = tallyPoll(withEligibleCount(poll), options, votes);
    closedTallyCache.set(poll.id, tally);
  }
  return tally;
}

/**
 * Page-safe copy of a tally: the UI only needs voter names and reasons, so full
 * ballots stay out of the payload. Copies rather than mutating the cached tally.
 */
export function publicTally(tally: TallyResult): PublicTallyResult {
  const { voteDetails, ...rest } = tally;
  return voteDetails
    ? { ...rest, voteDetails: voteDetails.map((detail) => ({ voterName: detail.voterName, reason: detail.reason })) }
    : rest;
}

/**
 * "after_vote" shows results once this browser has voted; the poll's admin sees
 * them regardless, to follow their own poll. "after_close" hides them from
 * everyone until the poll closes.
 */
export function canShowResults(poll: Poll, viewerVote: Vote | null, isAdmin = false): boolean {
  if (poll.status === "draft" || poll.status === "scheduled") return false;
  if (isClosed(poll)) return true;
  if (poll.config.hideResults === "off") return true;
  if (poll.config.hideResults === "after_vote") return Boolean(viewerVote) || isAdmin;
  return false;
}

/** Whether this viewer may cast (or recast) a ballot: once cast, a vote is final unless the poll allows changes or the viewer is its admin. */
export function canChangeVote(poll: Poll, viewerVote: Vote | null, isAdmin: boolean): boolean {
  return !viewerVote || poll.config.allowVoteChanges || isAdmin;
}

export const VOTE_LOCKED_MESSAGE = "Your vote is already in. Votes on this poll can't be changed once cast.";

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

/** `options` may be given already split (the MCP tools do); otherwise they are read from `optionsText`, one `label | meaning` per line. */
export function inputFromData(data: Record<string, unknown>, parsedOptions?: Array<{ label: string; meaning: string }>): CreatePollInput {
  const type = parseType(data.type);
  if (!type) throw new Error("Invalid poll type.");
  const title = limitedField(data.title, "Title", LIMITS.title).trim();
  if (!title) throw new Error("Title is required.");
  const options = parsedOptions ? checkOptions(parsedOptions.map((option) => ({ label: option.label.trim(), meaning: option.meaning.trim() })).filter((option) => option.label)) : parseOptions(stringField(data.optionsText));
  const config = parseConfig(type, data);
  if (type === "time_poll") normalizeTimeOptions(options);
  validatePollSetup(type, config, options);
  const opensAt = dateField(data.opensAt);
  const closesAt = dateField(data.closesAt);
  if (opensAt && closesAt && opensAt >= closesAt) throw new Error("Opens at must be before closes at.");
  const invitees = config.voterMode === "invite" ? parseInvitees(stringField(data.inviteesText)) : [];
  if (config.voterMode === "invite" && invitees.length < 1) throw new Error("Invite-only polls need at least one invitee.");
  return {
    type,
    title,
    details: limitedField(data.details, "Details", LIMITS.details),
    config,
    opensAt,
    closesAt,
    options,
    invitees
  };
}

/** One name per line: trimmed, blanks dropped, duplicates removed case-insensitively (first spelling wins). */
export function parseInvitees(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim();
    if (!name) continue;
    if (name.length > LIMITS.voterName) throw new Error(`Invitee names are too long (max ${LIMITS.voterName} characters).`);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length > MAX_INVITEES) throw new Error(`Too many invitees (max ${MAX_INVITEES}).`);
  return names;
}

/** `forcedName` (invite mode) replaces whatever name the request carries. */
export async function voteInputFromRequest(request: Request, poll: Poll, options: Option[], forcedName?: string) {
  return voteInputFromData(await readData(request), poll, options, forcedName);
}

export function voteInputFromData(data: Record<string, unknown>, poll: Poll, options: Option[], forcedName?: string) {
  const voterName = forcedName ?? limitedField(data.voterName, "Display name", LIMITS.voterName).trim();
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

export const OPERATOR_COOKIE = "poll_operator_token";

function operatorToken(): string {
  return process.env.OPERATOR_TOKEN ?? "";
}

/**
 * The instance operator (holder of the OPERATOR_TOKEN env secret) is admin of
 * every poll. This is the only way to manage legacy polls, created before
 * per-poll admin tokens existed, and to moderate spam.
 */
export function isOperator(cookies: Cookies, urlToken = ""): boolean {
  const token = operatorToken();
  if (!token) return false;
  const hash = hashToken(token);
  return tokenMatches(hash, cookies.get(OPERATOR_COOKIE) ?? "") || tokenMatches(hash, urlToken);
}

/**
 * The plaintext admin token in this browser's cookie for the poll, if (and only
 * if) it is valid. Used to rebuild the shareable admin link; the database only
 * holds a hash, so this is the sole source of a usable credential.
 */
export function adminCookieToken(cookies: Cookies, pollId: number): string {
  const value = cookies.get(adminTokenCookie(pollId)) ?? "";
  return value && getStore().verifyAdminToken(pollId, value) ? value : "";
}

/**
 * New polls are managed only by the admin token holder (or the operator).
 * Legacy polls with an empty token are managed only by the operator. A valid
 * `?admin=<token>` URL grants the cookie, so the admin link is shareable.
 */
export function isPollAdmin(cookies: Cookies, pollId: number, urlToken = ""): boolean {
  if (isOperator(cookies, urlToken)) return true;
  return Boolean(adminCookieToken(cookies, pollId)) || (Boolean(urlToken) && getStore().verifyAdminToken(pollId, urlToken));
}

/** Exchanges a `?admin=` URL token for a cookie; returns true if one was granted. */
export function grantAdminFromUrl(cookies: Cookies, pollId: number, urlToken: string): boolean {
  if (!urlToken) return false;
  const operator = operatorToken();
  if (operator && tokenMatches(hashToken(operator), urlToken)) {
    cookies.set(OPERATOR_COOKIE, urlToken, TOKEN_COOKIE_OPTIONS);
    return true;
  }
  if (getStore().verifyAdminToken(pollId, urlToken)) {
    cookies.set(adminTokenCookie(pollId), urlToken, TOKEN_COOKIE_OPTIONS);
    return true;
  }
  return false;
}

/** Returns the public slug as `id`; the integer primary key never leaves the server. */
export function createPollWithAdmin(input: CreatePollInput, cookies: Cookies): { id: string; adminToken: string } {
  const adminToken = crypto.randomUUID();
  const { id, slug } = getStore().createPoll({ ...input, adminToken });
  cookies.set(adminTokenCookie(id), adminToken, TOKEN_COOKIE_OPTIONS);
  return { id: slug, adminToken };
}

export interface Involvement {
  poll: Poll;
  /** "admin": holds this poll's admin cookie; "voter": holds a vote token; "invitee": holds a valid personal invite link; null: operator-only visibility. */
  role: "admin" | "voter" | "invitee" | null;
}

/**
 * Polls this browser is involved with, discovered from its capability cookies
 * (`poll_<id>_admin_token`, `poll_<id>_vote_token`, `poll_<id>_invite_token`). Every cookie is verified
 * against the stored hash, so forged cookie names/values list nothing. The
 * operator sees every poll.
 */
export function involvedPolls(cookies: Cookies): Involvement[] {
  const db = getStore();
  if (isOperator(cookies)) {
    return db.listPolls().map((poll): Involvement => ({ poll, role: adminCookieToken(cookies, poll.id) ? "admin" : db.hasVoteToken(poll.id, voteTokenFor(cookies, poll.id)) ? "voter" : currentInvite(cookies, poll) ? "invitee" : null }));
  }
  const ids = new Set<number>();
  for (const { name } of cookies.getAll()) {
    const match = /^poll_(\d+)_(?:admin|vote|invite)_token$/.exec(name);
    if (match) ids.add(Number(match[1]));
  }
  const result: Involvement[] = [];
  for (const id of ids) {
    const poll = db.getPoll(id);
    if (!poll) continue;
    if (adminCookieToken(cookies, id)) result.push({ poll, role: "admin" });
    else if (poll.status === "draft" || poll.status === "scheduled") continue;
    else if (db.hasVoteToken(id, voteTokenFor(cookies, id))) result.push({ poll, role: "voter" });
    else if (currentInvite(cookies, poll)) result.push({ poll, role: "invitee" });
  }
  return result.sort((a, b) => b.poll.createdAt.localeCompare(a.poll.createdAt));
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

export function shuffleSeedCookie(pollId: number): string {
  return `poll_${pollId}_shuffle_seed`;
}

/**
 * Options in the order this browser should see them. With shuffling on (and
 * not a proposal type, whose positions are fixed) the order is a deterministic
 * shuffle seeded by the poll slug plus a per-poll random cookie minted on first
 * view, so it is stable across reloads and differs between voters.
 */
export function ballotOptionsFor(poll: Poll, options: Option[], cookies: Cookies): Option[] {
  if (!poll.config.shuffleOptions || isProposalType(poll.type) || poll.status === "draft") return options;
  let seed = cookies.get(shuffleSeedCookie(poll.id)) ?? "";
  if (!seed) {
    seed = crypto.randomUUID();
    cookies.set(shuffleSeedCookie(poll.id), seed, TOKEN_COOKIE_OPTIONS);
  }
  return seededShuffle(options, `${poll.slug}:${seed}`);
}

/**
 * Who this browser votes as and their existing ballot. In invite mode that is
 * the invitee their cookie names (the invite token is the ballot's edit token);
 * otherwise the remembered display name.
 */
export function viewerContext(poll: Poll, cookies: Cookies) {
  const inviteMode = poll.config.voterMode === "invite";
  const invite = inviteMode ? currentInvite(cookies, poll) : null;
  const viewerName = invite ? invite.name : inviteMode ? "" : voterNameFor(cookies, poll.id);
  const viewerVote = viewerName ? getStore().getVoteByName(poll.id, viewerName, invite ? invite.token : voteTokenFor(cookies, poll.id)) : null;
  return { inviteMode, invite, viewerName, viewerVote };
}

export function voteTokenFor(cookies: Cookies, pollId: number): string {
  return cookies.get(voteTokenCookie(pollId)) ?? "";
}

/**
 * Stores the vote under this browser's edit token (minting one on first vote)
 * so another visitor cannot silently replace it by reusing the display name.
 */
export function recordVote(poll: Poll, vote: { voterName: string; reason: string; ballot: unknown }, cookies: Cookies, editToken = "") {
  const token = editToken || voteTokenFor(cookies, poll.id) || crypto.randomUUID();
  getStore().upsertVote(poll.id, vote.voterName, vote.ballot, vote.reason, token);
  cookies.set(voteTokenCookie(poll.id), token, TOKEN_COOKIE_OPTIONS);
  // Remember the name in a cookie so the post-vote redirect can stay clean of
  // `?voterName=` (names in URLs end up in history and logs).
  cookies.set(voterNameCookie(poll.id), encodeURIComponent(vote.voterName), TOKEN_COOKIE_OPTIONS);
}

export const INVITE_ONLY_MESSAGE = "This poll is invite-only. Use the personal link you were sent.";

/** Thrown for a vote on an invite-only poll without a valid invite; routes map it to 403. */
export class InviteRequiredError extends Error {
  constructor() {
    super(INVITE_ONLY_MESSAGE);
  }
}

export function inviteTokenCookie(pollId: number): string {
  return `poll_${pollId}_invite_token`;
}

/** The invitee this browser's invite cookie identifies, with the plaintext token; null if absent or invalid. */
export function currentInvite(cookies: Cookies, poll: Poll): (Invite & { token: string }) | null {
  const token = cookies.get(inviteTokenCookie(poll.id)) ?? "";
  const invite = token ? getStore().findInviteByToken(poll.id, token) : null;
  return invite ? { ...invite, token } : null;
}

/** Exchanges a `?invite=` URL token for a cookie; returns true if it was a valid invite. */
export function grantInviteFromUrl(cookies: Cookies, poll: Poll, urlToken: string): boolean {
  if (!urlToken || !getStore().findInviteByToken(poll.id, urlToken)) return false;
  cookies.set(inviteTokenCookie(poll.id), urlToken, TOKEN_COOKIE_OPTIONS);
  return true;
}

/**
 * The single vote-submission path for the form action and the JSON API. In
 * invite mode the voter is whoever the invite cookie says: any submitted name
 * is ignored and the invite token doubles as the ballot's edit token, so
 * re-voting from the same invite updates the ballot.
 */
export async function submitVote(poll: Poll, options: Option[], request: Request, cookies: Cookies) {
  submitVoteData(poll, options, await readData(request), cookies);
}

/** `submitVote` for already-parsed form-shaped data (`voterName`, `reason`, `optionId`, `score_<id>`, ...). */
export function submitVoteData(poll: Poll, options: Option[], data: Record<string, unknown>, cookies: Cookies) {
  const invite = poll.config.voterMode === "invite" ? currentInvite(cookies, poll) : null;
  if (poll.config.voterMode === "invite" && !invite) throw new InviteRequiredError();
  // Anonymous open-link polls take no name: the ballot is keyed to this
  // browser's vote token instead (one vote per browser still holds).
  const anonymousToken = poll.config.anonymous && !invite ? voteTokenFor(cookies, poll.id) || crypto.randomUUID() : "";
  const vote = voteInputFromData(data, poll, options, invite?.name ?? (anonymousToken ? anonymousVoterName(anonymousToken) : undefined));
  // Final votes: once this browser has a ballot in the poll, it can't cast
  // another under any name, unless the poll allows changes or it's the admin.
  const token = invite?.token || anonymousToken || voteTokenFor(cookies, poll.id);
  if (!poll.config.allowVoteChanges && token && getStore().hasVoteToken(poll.id, token) && !isPollAdmin(cookies, poll.id)) {
    throw new Error(VOTE_LOCKED_MESSAGE);
  }
  recordVote(poll, vote, cookies, invite?.token || anonymousToken);
}

/** Internal key for an anonymous ballot: stable per browser, meaningless to anyone reading it. */
export function anonymousVoterName(token: string): string {
  return `Anonymous ${hashToken(`anonymous:${token}`).slice(0, 10)}`;
}

export interface InvitationView {
  name: string;
  voted: boolean;
  /** Personal link, rebuilt from the admin's own cookie; null when this viewer lacks the plaintext admin token. */
  link: string | null;
}

/** Admin-only invitee status (voted or not, never what) and links. */
export function invitationsFor(poll: Poll, votes: Vote[], adminToken: string): InvitationView[] {
  const voted = new Set(votes.map((vote) => vote.voterName));
  return getStore().getInvites(poll.id).map((invite) => ({
    name: invite.name,
    voted: voted.has(invite.name),
    link: adminToken ? `/poll/${poll.slug}?invite=${encodeURIComponent(deriveInviteToken(adminToken, invite.id))}` : null
  }));
}

/** Adds invitees to a not-yet-closed invite-mode poll. Existing invitees are never removed or renamed. */
export function addInviteesOrThrow(slug: string, cookies: Cookies, text: string): { poll: Poll; added: string[] } {
  const db = getStore();
  const poll = db.getPollBySlug(slug);
  if (!poll) throw new Error("Poll not found.");
  requirePollAdmin(cookies, poll.id);
  if (poll.config.voterMode !== "invite") throw new Error("This poll is not invite-only.");
  if (poll.status === "closed" || isClosed(poll)) throw new Error("Closed polls cannot take new invitees.");
  const names = parseInvitees(text);
  if (!names.length) throw new Error("Enter at least one name.");
  const added = db.addInvitees(poll.id, names, adminCookieToken(cookies, poll.id));
  return { poll, added };
}

/** Saves a draft edit, including its invitee list (invite links need the admin's plaintext token). */
export function updateDraftOrThrow(poll: Poll, input: CreatePollInput, cookies: Cookies) {
  if (!getStore().updatePoll({ id: poll.id, ...input, adminToken: adminCookieToken(cookies, poll.id) })) throw new Error("Could not update draft.");
}

export function openPollOrThrow(slug: string, cookies: Cookies) {
  const db = getStore();
  const poll = db.getPollBySlug(slug);
  if (!poll) throw new Error("Poll not found.");
  requirePollAdmin(cookies, poll.id);
  if (poll.status === "scheduled") throw new Error("This poll is scheduled to open by itself. Unschedule it to open it now.");
  if (!db.openPoll(poll.id)) throw new Error("Only draft polls can be opened.");
  return poll;
}

/** Draft -> scheduled: needs `opensAt` in the future (and before `closesAt`); the poll then opens itself and setup is frozen. */
export function schedulePollOrThrow(slug: string, cookies: Cookies) {
  const db = getStore();
  const poll = db.getPollBySlug(slug);
  if (!poll) throw new Error("Poll not found.");
  requirePollAdmin(cookies, poll.id);
  if (poll.status !== "draft") throw new Error("Only draft polls can be scheduled.");
  if (!poll.opensAt) throw new Error("Set an opening time before scheduling.");
  if (poll.opensAt <= new Date().toISOString()) throw new Error("The opening time must be in the future to schedule.");
  if (poll.closesAt && poll.opensAt >= poll.closesAt) throw new Error("Opens at must be before closes at.");
  if (!db.schedulePoll(poll.id)) throw new Error("Could not schedule this poll.");
  return poll;
}

export function unschedulePollOrThrow(slug: string, cookies: Cookies) {
  const db = getStore();
  const poll = db.getPollBySlug(slug);
  if (!poll) throw new Error("Poll not found.");
  requirePollAdmin(cookies, poll.id);
  if (poll.status !== "scheduled") throw new Error("Only scheduled polls can be unscheduled.");
  if (!db.unschedulePoll(poll.id)) throw new Error("This poll has already opened.");
  return poll;
}

/** Admin-only copy of any poll as a new draft; the caller's browser becomes admin of the copy. */
export function duplicatePollOrThrow(slug: string, cookies: Cookies): { id: string; adminToken: string } {
  const db = getStore();
  const poll = db.getPollBySlug(slug);
  if (!poll) throw new Error("Poll not found.");
  requirePollAdmin(cookies, poll.id);
  const adminToken = crypto.randomUUID();
  const copy = db.duplicatePoll(poll.id, adminToken);
  cookies.set(adminTokenCookie(copy.id), adminToken, TOKEN_COOKIE_OPTIONS);
  return { id: copy.slug, adminToken };
}

export function closePollOrThrow(slug: string, cookies: Cookies) {
  const db = getStore();
  const poll = db.getPollBySlug(slug);
  if (!poll) throw new Error("Poll not found.");
  requirePollAdmin(cookies, poll.id);
  if (poll.status === "draft") throw new Error("Open the draft before closing it.");
  if (poll.status === "scheduled") throw new Error("This poll has not opened yet. Unschedule it or delete it instead.");
  db.closePoll(poll.id);
  return poll;
}

export function deletePollOrThrow(slug: string, cookies: Cookies) {
  const db = getStore();
  const poll = db.getPollBySlug(slug);
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
      reason: vote.reason,
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

export function ensurePoll(slug: string): Poll {
  const poll = getStore().getPollBySlug(slug);
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

  if (isProposalType(type)) {
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

/**
 * Time-poll labels are instants stored as ISO 8601 UTC. Accepts full ISO with a
 * zone (what the editor sends) and, for the no-JS fallback, `YYYY-MM-DD HH:MM`
 * (or with `T`, optional seconds) read as UTC. Rewrites labels in place.
 */
function normalizeTimeOptions(options: Array<{ label: string; meaning: string }>) {
  const seen = new Set<string>();
  for (const option of options) {
    let date = parseSlot(option.label);
    const naive = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(option.label);
    if (!date && naive) {
      const [year, month, day, hour, minute, second] = naive.slice(1).map((part) => Number(part ?? 0)) as [number, number, number, number, number, number];
      const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
      if (utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day && utc.getUTCHours() === hour) date = utc;
    }
    if (!date) throw new Error(`Timeslot "${option.label}" is not a valid date and time (for example 2026-10-05T14:00:00Z).`);
    option.label = date.toISOString();
    if (seen.has(option.label)) throw new Error("Each timeslot must be different.");
    seen.add(option.label);
  }
}

function parseConfig(type: PollType, data: Record<string, unknown>): PollConfig {
  const config = { ...defaultConfigFor(type) };
  config.anonymous = boolField(data.anonymous);
  config.voterMode = stringField(data.voterMode) === "invite" ? "invite" : "open";
  config.allowVoteChanges = boolField(data.allowVoteChanges);
  config.hideResults = ["off", "after_vote", "after_close"].includes(stringField(data.hideResults)) ? stringField(data.hideResults) as PollConfig["hideResults"] : baseConfig.hideResults;
  config.reasonMode = ["optional", "required", "disabled"].includes(stringField(data.reasonMode)) ? stringField(data.reasonMode) as PollConfig["reasonMode"] : baseConfig.reasonMode;
  config.quorumPercent = intField(data.quorumPercent, 0, 0, 100);
  // Invite mode counts the invitees instead; drop the typed value so it cannot disagree.
  config.eligibleVoterCount = config.voterMode === "invite" ? 0 : intField(data.eligibleVoterCount, 0, 0, 1_000_000);
  config.shuffleOptions = !isProposalType(type) && boolField(data.shuffleOptions);
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
  if (isProposalType(poll.type)) return { optionId: numberField(data.optionId, 0) };
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
  return checkOptions(options);
}

function checkOptions(options: Array<{ label: string; meaning: string }>): Array<{ label: string; meaning: string }> {
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

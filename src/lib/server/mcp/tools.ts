import type { Cookies } from "@sveltejs/kit";
import {
  adminCookieToken,
  ballotOptionsFor,
  canChangeVote,
  canShowResults,
  closePollOrThrow,
  createPollWithAdmin,
  deletePollOrThrow,
  duplicatePollOrThrow,
  exportVotes,
  getStore,
  grantAdminFromUrl,
  grantInviteFromUrl,
  addInviteesOrThrow,
  inputFromData,
  InviteRequiredError,
  invitationsFor,
  involvedPolls,
  isOperator,
  isPollAdmin,
  openPollOrThrow,
  publicTally,
  schedulePollOrThrow,
  submitVoteData,
  tallyFor,
  unschedulePollOrThrow,
  updateDraftOrThrow,
  viewerContext,
  VOTE_LOCKED_MESSAGE,
  voteTokenCookie,
  voterNameCookie
} from "../app";
import { correctionRows, correctionStats, trainingJsonl } from "../corrections";
import { filterFromInput, readEvents } from "../events";
import { defaultConfigFor, templateByType, templates } from "../../../templates";
import { isProposalType, POLL_TYPES, type Option, type Poll, type PollConfig, type Vote } from "../../../types";
import { formatSlot, isClosed, isOpen, parseSlot } from "../../shared";

/**
 * MCP tools: the same decisions a person makes through the web pages, for
 * agents. Every tool runs the same server functions as the pages and JSON API,
 * against a cookie jar standing in for the agent's browser (see ./server.ts),
 * so admin rights, invite-only voting, final votes and hidden results behave
 * exactly as they do for people.
 */

/** A problem the agent can fix; reported as a tool error rather than a protocol error. */
export class ToolError extends Error {}

export interface ToolContext {
  /** The agent's capability cookies: per MCP session, or per request without one. */
  jar: Cookies;
  /** Public origin for absolute links, e.g. https://poll.example. */
  origin: string;
}

type Args = Record<string, unknown>;
type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Rate-limit bucket, as for the equivalent web request. Reads are unlimited. */
  bucket?: "create" | "mutate";
  run(args: Args, ctx: ToolContext): Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Arguments

function text(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolError(`\`${key}\` must be a string.`);
  return value;
}

function required(args: Args, key: string): string {
  const value = text(args, key)?.trim();
  if (!value) throw new ToolError(`\`${key}\` is required.`);
  return value;
}

function list(args: Args, key: string): unknown[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value : [value];
}

function record(args: Args, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new ToolError(`\`${key}\` must be an object mapping options to values.`);
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Polls and credentials

const POLL_ARG: JsonSchema = {
  type: "string",
  description: "The poll: its id (e.g. \"4WZegrFSou\") or any link to it. Admin links (?admin=...) and personal invite links (?invite=...) also grant that access for this session."
};
const ADMIN_TOKEN_ARG: JsonSchema = { type: "string", description: "The poll's admin token (returned by create_poll), or the instance operator token. Not needed if this session created the poll or already used it." };
const INVITE_TOKEN_ARG: JsonSchema = { type: "string", description: "Personal invite token for invite-only polls (the ?invite= part of an invite link). Not needed if you pass the invite link as `poll`." };
const VOTE_TOKEN_ARG: JsonSchema = { type: "string", description: "The vote token returned by an earlier cast_vote, to see or update that ballot from a new session." };

function pollPath(poll: Poll): string {
  return `/poll/${poll.slug}`;
}

/**
 * Resolves a poll id or link. Tokens in a link are exchanged for session
 * capabilities, as when a person opens the link in their browser.
 */
function resolvePoll(ref: unknown, ctx: ToolContext): Poll {
  const raw = typeof ref === "string" ? ref.trim() : "";
  if (!raw) throw new ToolError("`poll` is required: the poll's id (e.g. 4WZegrFSou) or a link to it.");
  let slug = raw;
  let adminToken = "";
  let inviteToken = "";
  if (raw.includes("/") || raw.includes("?")) {
    let url: URL;
    try {
      url = new URL(raw, ctx.origin);
    } catch {
      throw new ToolError(`"${raw}" is not a poll id or link.`);
    }
    const match = /\/poll\/([^/?#]+)/.exec(url.pathname);
    if (!match?.[1]) throw new ToolError(`"${raw}" is not a poll link (expected .../poll/<id>).`);
    slug = decodeURIComponent(match[1]);
    adminToken = url.searchParams.get("admin") ?? "";
    inviteToken = url.searchParams.get("invite") ?? "";
  }
  const poll = getStore().getPollBySlug(slug);
  if (!poll) throw new ToolError(`Poll "${slug}" not found. Check the id or link.`);
  if (adminToken && !grantAdminFromUrl(ctx.jar, poll.id, adminToken)) throw new ToolError("The admin token in that link is not valid for this poll.");
  if (inviteToken && !grantInviteFromUrl(ctx.jar, poll, inviteToken)) throw new ToolError("The invite in that link is not valid for this poll.");
  return poll;
}

/** Adds explicitly passed tokens to the session, rejecting ones that do not belong to the poll. */
function applyCredentials(poll: Poll, args: Args, ctx: ToolContext) {
  const adminToken = text(args, "adminToken")?.trim();
  if (adminToken && !grantAdminFromUrl(ctx.jar, poll.id, adminToken)) throw new ToolError("That admin token is not valid for this poll.");
  const inviteToken = text(args, "inviteToken")?.trim();
  if (inviteToken && !grantInviteFromUrl(ctx.jar, poll, inviteToken)) throw new ToolError("That invite token is not valid for this poll.");
  const voteToken = text(args, "voteToken")?.trim();
  if (voteToken) {
    const name = getStore().voterNameForToken(poll.id, voteToken);
    if (name === null) throw new ToolError("That vote token does not match any ballot in this poll.");
    ctx.jar.set(voteTokenCookie(poll.id), voteToken, { path: "/" });
    ctx.jar.set(voterNameCookie(poll.id), encodeURIComponent(name), { path: "/" });
  }
}

function pollFor(args: Args, ctx: ToolContext): Poll {
  const poll = resolvePoll(args.poll, ctx);
  applyCredentials(poll, args, ctx);
  return poll;
}

function requireAdmin(poll: Poll, ctx: ToolContext) {
  if (!isPollAdmin(ctx.jar, poll.id)) {
    throw new ToolError("Only the poll's admin can do this. Pass its `adminToken` (returned by create_poll) or its admin link as `poll`.");
  }
}

// ---------------------------------------------------------------------------
// Options and ballots

function optionKeys(options: Option[]): Map<number, string> {
  const counts = new Map<string, number>();
  for (const option of options) counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
  return new Map(options.map((option) => [option.id, (counts.get(option.label) ?? 0) > 1 ? `#${option.id}` : option.label]));
}

/** Finds an option by id (number or "#12"), label (exact, then case-insensitive) or, for timeslots, any spelling of the same instant. */
function optionFinder(poll: Poll, options: Option[]) {
  const describe = () => options.map((option) => `${option.id} "${option.label}"`).join(", ");
  return (ref: unknown): Option => {
    if (typeof ref === "number") {
      const byId = options.find((option) => option.id === ref);
      if (byId) return byId;
      throw new ToolError(`No option has id ${ref}. Options: ${describe()}.`);
    }
    if (typeof ref !== "string" || !ref.trim()) throw new ToolError(`Options are referred to by id or label. Options: ${describe()}.`);
    const wanted = ref.trim();
    const hash = /^#(\d+)$/.exec(wanted);
    if (hash) return optionFinder(poll, options)(Number(hash[1]));
    const exact = options.filter((option) => option.label === wanted);
    const loose = exact.length ? exact : options.filter((option) => option.label.trim().toLowerCase() === wanted.toLowerCase());
    if (loose.length > 1) throw new ToolError(`More than one option is labelled "${wanted}"; use its id instead. Options: ${describe()}.`);
    if (loose[0]) return loose[0];
    if (poll.type === "time_poll") {
      const time = new Date(wanted).getTime();
      const slot = Number.isNaN(time) ? undefined : options.find((option) => parseSlot(option.label)?.getTime() === time);
      if (slot) return slot;
    }
    if (/^\d+$/.test(wanted)) return optionFinder(poll, options)(Number(wanted));
    throw new ToolError(`Unknown option "${wanted}". Options: ${describe()}.`);
  };
}

const AVAILABILITY_ALIASES: Record<string, string> = {
  available: "available",
  yes: "available",
  if_needed: "if_needed",
  "if needed": "if_needed",
  "if-needed": "if_needed",
  maybe: "if_needed",
  unavailable: "unavailable",
  no: "unavailable"
};

function availabilityValue(value: unknown, where: string): string {
  const answer = AVAILABILITY_ALIASES[String(value ?? "").trim().toLowerCase()];
  if (!answer) throw new ToolError(`${where}: availability must be "available", "if_needed" or "unavailable".`);
  return answer;
}

/**
 * Turns the tool's friendly ballot fields into the form fields the web ballot
 * posts (`optionId`, `selected`, `score_<id>`, `rank_<n>`, ...), so the vote
 * goes through the exact same parsing and validation.
 */
function ballotFields(poll: Poll, options: Option[], args: Args): Record<string, unknown> {
  const find = optionFinder(poll, options);
  const missing = (field: string) => new ToolError(`This ${templateByType.get(poll.type)?.label ?? poll.type} poll takes \`${field}\`. ${ballotGuide(poll, options).summary}`);
  const data: Record<string, unknown> = {};

  if (isProposalType(poll.type)) {
    if (args.choice === undefined || args.choice === null) throw missing("choice");
    data.optionId = find(args.choice).id;
    return data;
  }

  if (poll.type === "choose" || poll.type === "approval") {
    const selected = list(args, "selected");
    if (!selected) throw missing("selected");
    data.selected = selected.map((ref) => find(ref).id);
    return data;
  }

  if (poll.type === "score") {
    const scores = record(args, "scores");
    if (!scores) throw missing("scores");
    const given = new Map<number, number>();
    for (const [ref, value] of Object.entries(scores)) {
      const option = find(ref);
      const score = Number(value);
      if (!Number.isFinite(score)) throw new ToolError(`Score for "${option.label}" must be a number.`);
      given.set(option.id, score);
    }
    const unscored = options.filter((option) => !given.has(option.id));
    if (unscored.length) throw new ToolError(`Score every option. Missing: ${unscored.map((option) => `"${option.label}"`).join(", ")}.`);
    for (const [id, score] of given) data[`score_${id}`] = score;
    return data;
  }

  if (poll.type === "allocate") {
    const allocations = record(args, "allocations");
    if (!allocations) throw missing("allocations");
    for (const [ref, value] of Object.entries(allocations)) {
      const option = find(ref);
      data[`allocation_${option.id}`] = Number(value);
    }
    return data;
  }

  if (poll.type === "rank" || poll.type === "irv" || poll.type === "stv") {
    const ranking = list(args, "ranking");
    if (!ranking) throw missing("ranking");
    const limit = poll.type === "rank" ? (poll.config.rankCount ?? options.length) : options.length;
    if (ranking.length > limit) throw new ToolError(`Rank at most ${limit} option${limit === 1 ? "" : "s"}.`);
    ranking.forEach((ref, index) => {
      data[`rank_${index + 1}`] = find(ref).id;
    });
    return data;
  }

  if (poll.type === "time_poll") {
    const availability = record(args, "availability") ?? {};
    const fallback = args.defaultAvailability === undefined || args.defaultAvailability === null ? null : availabilityValue(args.defaultAvailability, "defaultAvailability");
    if (!Object.keys(availability).length && !fallback) throw missing("availability");
    for (const [ref, value] of Object.entries(availability)) {
      const option = find(ref);
      data[`availability_${option.id}`] = availabilityValue(value, `"${option.label}"`);
    }
    const unmarked = options.filter((option) => !data[`availability_${option.id}`]);
    if (unmarked.length && !fallback) {
      throw new ToolError(`Mark every timeslot, or set \`defaultAvailability\`. Missing: ${unmarked.map((option) => `"${option.label}"`).join(", ")}.`);
    }
    for (const option of unmarked) data[`availability_${option.id}`] = fallback;
    return data;
  }

  throw new ToolError("Unsupported poll type.");
}

/** A stored ballot in the same shape cast_vote accepts, with options named by label. */
function describeBallot(poll: Poll, options: Option[], ballot: unknown): Record<string, unknown> {
  const keys = optionKeys(options);
  const name = (id: unknown) => keys.get(Number(id)) ?? `#${String(id)}`;
  const object = (ballot && typeof ballot === "object" ? ballot : {}) as Record<string, unknown>;
  const entries = (value: unknown) => Object.entries((value && typeof value === "object" ? value : {}) as Record<string, unknown>);
  if (isProposalType(poll.type)) return { choice: name(object.optionId) };
  if (poll.type === "choose" || poll.type === "approval") return { selected: (Array.isArray(object.selected) ? object.selected : []).map(name) };
  if (poll.type === "score") return { scores: Object.fromEntries(entries(object.scores).map(([id, score]) => [name(id), score])) };
  if (poll.type === "allocate") return { allocations: Object.fromEntries(entries(object.allocations).filter(([, points]) => Number(points) > 0).map(([id, points]) => [name(id), points])) };
  if (poll.type === "rank" || poll.type === "irv" || poll.type === "stv") return { ranking: (Array.isArray(object.rankings) ? object.rankings : []).map(name) };
  if (poll.type === "time_poll") return { availability: Object.fromEntries(entries(object.availability).map(([id, answer]) => [name(id), answer])) };
  return object;
}

/** How to fill in this poll's ballot, in words plus a valid example for cast_vote. */
function ballotGuide(poll: Poll, options: Option[]): { summary: string; example: Record<string, unknown> } {
  const config = poll.config;
  const keys = optionKeys(options);
  const labels = options.map((option) => keys.get(option.id) ?? option.label);
  const quoted = labels.map((label) => `"${label}"`).join(", ");
  let summary: string;
  let example: Record<string, unknown>;
  switch (poll.type) {
    case "sense_check":
    case "consent":
    case "consensus":
    case "majority":
      summary = `Pick exactly one position with \`choice\`: ${quoted}.`;
      example = { choice: labels[0] };
      break;
    case "choose": {
      const min = config.minChoices ?? 1;
      const max = config.maxChoices ?? 1;
      summary = min === max ? `Pick exactly ${min} option${min === 1 ? "" : "s"} with \`selected\`.` : `Pick between ${min} and ${max} options with \`selected\`.`;
      example = { selected: labels.slice(0, Math.max(1, min)) };
      break;
    }
    case "approval":
      summary = "List every option you would be happy with in `selected` (any number, including none).";
      example = { selected: labels.slice(0, Math.min(2, labels.length)) };
      break;
    case "score": {
      const min = config.scoreMin ?? 0;
      const max = config.scoreMax ?? 5;
      summary = `Score every option from ${min} to ${max} with \`scores\` (option -> number). Options are ranked by mean score.`;
      example = { scores: Object.fromEntries(labels.map((label, index) => [label, Math.max(min, max - index)])) };
      break;
    }
    case "allocate": {
      const budget = config.pointBudget ?? 8;
      summary = `Split up to ${budget} whole points across options with \`allocations\` (option -> points). Options you leave out get 0.`;
      example = { allocations: labels[0] ? { [labels[0]]: budget } : {} };
      break;
    }
    case "rank": {
      const count = Math.min(config.rankCount ?? labels.length, labels.length);
      summary = `Order up to ${count} option${count === 1 ? "" : "s"} in \`ranking\`, most preferred first. Scoring is Borda-style: higher places earn more points.`;
      example = { ranking: labels.slice(0, count) };
      break;
    }
    case "irv":
      summary = "Order candidates in `ranking`, most preferred first (rank as many as you like). If your top choice is eliminated, your vote moves to your next choice.";
      example = { ranking: labels };
      break;
    case "stv": {
      const seats = config.seats ?? 1;
      summary = `Order candidates in \`ranking\`, most preferred first (rank as many as you like). ${seats} seat${seats === 1 ? " is" : "s are"} filled; surplus and eliminated votes transfer to your next choice.`;
      example = { ranking: labels };
      break;
    }
    case "time_poll":
      summary = "Mark every timeslot \"available\", \"if_needed\" or \"unavailable\" with `availability` (timeslot -> answer), or set `defaultAvailability` for the slots you leave out. Timeslots are UTC instants; any ISO spelling of the same time works.";
      example = { availability: labels[0] ? { [labels[0]]: "available" } : {}, defaultAvailability: "unavailable" };
      break;
    default:
      summary = "";
      example = {};
  }
  if (config.voterMode === "invite") summary += ` You vote as your invitee name; \`voterName\` is ignored.${config.anonymous ? " The poll is anonymous: its admin sees that you voted, not how." : ""}`;
  else if (config.anonymous) summary += " The poll is anonymous: no `voterName` is needed (any given is ignored), and no one, including its admin, can see how you voted.";
  else example = { voterName: "Your display name", ...example };
  if (config.reasonMode === "required") {
    summary += " A `reason` is required.";
    example.reason = "Why you voted this way.";
  } else if (config.reasonMode === "optional") {
    summary += " A `reason` is optional but helps others understand your vote.";
  } else {
    summary += " Reasons are turned off for this poll.";
  }
  if (!config.allowVoteChanges) summary += " Votes are final once cast.";
  return { summary, example };
}

// ---------------------------------------------------------------------------
// Views

function lifecycle(poll: Poll): "draft" | "scheduled" | "open" | "closed" {
  if (poll.status === "draft" || poll.status === "scheduled") return poll.status;
  return isClosed(poll) ? "closed" : "open";
}

function optionView(poll: Poll, option: Option) {
  const view: Record<string, unknown> = { id: option.id, label: option.label };
  if (option.meaning) view.description = option.meaning;
  const start = poll.type === "time_poll" ? parseSlot(option.label) : null;
  if (start) {
    const minutes = poll.config.meetingDurationMinutes ?? 60;
    view.start = start.toISOString();
    view.end = new Date(start.getTime() + Math.max(1, minutes) * 60_000).toISOString();
    view.display = formatSlot(option.label, minutes, "UTC");
  }
  return view;
}

/** Only the settings that mean something for this poll's type. */
function settingsView(poll: Poll): Partial<PollConfig> {
  const defaults = defaultConfigFor(poll.type);
  const keep = new Set(["anonymous", "voterMode", "hideResults", "allowVoteChanges", "reasonMode", "quorumPercent", "eligibleVoterCount", "shuffleOptions", ...Object.keys(defaults)]);
  if (poll.type === "choose") keep.add("minChoices").add("maxChoices");
  if (isProposalType(poll.type)) keep.delete("shuffleOptions");
  if (poll.config.voterMode === "invite") keep.delete("eligibleVoterCount");
  return Object.fromEntries(Object.entries(poll.config).filter(([key]) => keep.has(key)));
}

function resultsFor(poll: Poll, options: Option[], votes: Vote[], viewerVote: Vote | null, isAdmin: boolean, ctx: ToolContext): { results: Record<string, unknown> | null; resultsNote?: string } {
  const state = lifecycle(poll);
  if (state === "draft" || state === "scheduled") return { results: null, resultsNote: "There are no results until voting opens." };
  if (!canShowResults(poll, viewerVote, isAdmin)) {
    return {
      results: null,
      resultsNote: poll.config.hideResults === "after_vote" ? "Results are shown to voters after they vote, and to everyone once the poll closes." : "Results are hidden until the poll closes."
    };
  }
  const results: Record<string, unknown> = { ...publicTally(tallyFor(poll, options, votes)) };
  if (poll.config.anonymous) results.anonymous = true;
  if (state === "closed" && poll.type === "time_poll" && options.length && options.every((option) => parseSlot(option.label))) {
    results.calendarUrl = `${ctx.origin}${pollPath(poll)}/event.ics`;
  }
  return { results };
}

function cannotVoteReason(poll: Poll, inviteRequired: boolean, locked: boolean, isAdmin: boolean): string | null {
  const state = lifecycle(poll);
  if (state === "draft") return isAdmin ? "This poll is still a draft. Open it with open_poll (or schedule_poll) to start voting." : "This poll is still a draft; voting starts when its admin opens it.";
  if (state === "scheduled") return `Voting opens at ${poll.opensAt}.`;
  if (state === "closed") return "Voting has closed.";
  if (!isOpen(poll)) return poll.opensAt ? `Voting starts at ${poll.opensAt}.` : "Voting is not open.";
  if (inviteRequired) return "This poll is invite-only. Pass your personal invite link as `poll` (or its token as `inviteToken`).";
  if (locked) return VOTE_LOCKED_MESSAGE;
  return null;
}

/** Everything a person sees on the poll page, from this session's point of view. */
function pollView(poll: Poll, ctx: ToolContext): Record<string, unknown> {
  const db = getStore();
  const jar = ctx.jar;
  const fresh = db.getPoll(poll.id) ?? poll;
  const isAdmin = isPollAdmin(jar, fresh.id);
  const adminToken = adminCookieToken(jar, fresh.id);
  const options = db.getOptions(fresh.id);
  const votes = db.getVotes(fresh.id);
  const { inviteMode, invite, viewerName, viewerVote } = viewerContext(fresh, jar);
  // A scheduled poll shows visitors only when it opens, like the web page.
  const hideBallot = fresh.status === "scheduled" && !isAdmin;
  const ballotOptions = hideBallot ? [] : ballotOptionsFor(fresh, options, jar);
  const inviteRequired = inviteMode && !invite;
  const locked = !canChangeVote(fresh, viewerVote, isAdmin);
  const reason = cannotVoteReason(fresh, inviteRequired, locked, isAdmin);
  const state = lifecycle(fresh);
  const template = templateByType.get(fresh.type);
  const voteToken = jar.get(voteTokenCookie(fresh.id)) ?? "";

  const view: Record<string, unknown> = {
    id: fresh.slug,
    url: `${ctx.origin}${pollPath(fresh)}`,
    title: fresh.title,
    details: fresh.details,
    type: fresh.type,
    typeLabel: template?.label ?? fresh.type,
    typeDescription: template ? `${template.description} ${template.resultShape}` : "",
    status: state,
    opensAt: fresh.opensAt,
    closesAt: fresh.closesAt,
    openedAt: fresh.openedAt,
    closedAt: fresh.closedAt,
    createdAt: fresh.createdAt,
    settings: settingsView(fresh),
    options: ballotOptions.map((option) => optionView(fresh, option)),
    voteCount: votes.length,
    you: {
      role: adminToken ? "admin" : isAdmin ? "operator" : invite ? "invitee" : viewerVote ? "voter" : "visitor",
      isAdmin,
      // Anonymous open-link ballots carry only an internal key; never show it.
      votingAs: viewerName ? (fresh.config.anonymous && fresh.config.voterMode !== "invite" ? "Anonymous" : viewerName) : null,
      yourVote: viewerVote ? { ...describeBallot(fresh, options, viewerVote.ballot), reason: viewerVote.reason, updatedAt: viewerVote.updatedAt } : null,
      ...(viewerVote && voteToken && !invite ? { voteToken } : {}),
      canVote: reason === null,
      ...(reason ? { cannotVoteReason: reason } : {})
    },
    ...(hideBallot ? {} : { howToVote: ballotGuide(fresh, ballotOptions) }),
    ...resultsFor(fresh, options, votes, viewerVote, isAdmin, ctx),
    version: db.pollVersion(fresh.slug) ?? ""
  };
  if (fresh.status !== "draft" && fresh.status !== "scheduled") view.resultsUrl = `${ctx.origin}${pollPath(fresh)}/results`;
  if (adminToken) {
    view.adminToken = adminToken;
    view.adminLink = `${ctx.origin}${pollPath(fresh)}?admin=${encodeURIComponent(adminToken)}`;
  }
  if (isAdmin && inviteMode) {
    const invitations = invitationsFor(fresh, votes, adminToken).map((entry) => ({ ...entry, link: entry.link ? `${ctx.origin}${entry.link}` : null }));
    view.invitations = invitations;
    view.invitationSummary = `${invitations.filter((entry) => entry.voted).length} of ${invitations.length} invitees have voted.`;
  }
  if (isAdmin) view.adminActions = adminActions(fresh);
  return view;
}

function adminActions(poll: Poll): string[] {
  const state = lifecycle(poll);
  if (state === "draft") return ["update_draft", "open_poll", ...(poll.opensAt ? ["schedule_poll"] : []), "duplicate_poll", "delete_poll", ...(poll.config.voterMode === "invite" ? ["add_invitees"] : [])];
  if (state === "scheduled") return ["unschedule_poll", "duplicate_poll", "delete_poll", ...(poll.config.voterMode === "invite" ? ["add_invitees"] : [])];
  if (state === "open") return ["close_poll", "duplicate_poll", "delete_poll", ...(poll.config.voterMode === "invite" ? ["add_invitees"] : [])];
  return ["export_results", "duplicate_poll", "delete_poll"];
}

// ---------------------------------------------------------------------------
// Poll setup

const SETTINGS_SCHEMA: JsonSchema = {
  type: "object",
  description: "Optional settings; anything left out uses the poll type's default (see list_poll_types).",
  properties: {
    anonymous: { type: "boolean", description: "Voters give no name (open polls) and no one, including the admin, can see how anyone voted; reasons are shown without names. Invite-only polls still show the admin who has voted, not how." },
    hideResults: { type: "string", enum: ["off", "after_vote", "after_close"], description: "When results become visible. Default after_vote (voters see results once they have voted; the admin always does)." },
    allowVoteChanges: { type: "boolean", description: "Let voters change a ballot after casting it. Default false (votes are final)." },
    reasonMode: { type: "string", enum: ["optional", "required", "disabled"], description: "Whether voters give a written reason. Default optional." },
    quorumPercent: { type: "integer", minimum: 0, maximum: 100, description: "Share of eligible voters who must vote for the result to count. 0 = no quorum." },
    eligibleVoterCount: { type: "integer", minimum: 0, description: "Electorate size for quorum (open polls only; invite-only polls use the invitee count)." },
    shuffleOptions: { type: "boolean", description: "Show options in a different random order to each voter (not for proposals)." },
    minChoices: { type: "integer", minimum: 0, description: "choose: fewest options a voter must pick. Default 1." },
    maxChoices: { type: "integer", minimum: 1, description: "choose: most options a voter may pick. Default 1." },
    scoreMin: { type: "integer", description: "score: lowest score. Default 0." },
    scoreMax: { type: "integer", description: "score: highest score. Default 5." },
    pointBudget: { type: "integer", minimum: 1, description: "allocate: points each voter can split. Default 8." },
    rankCount: { type: "integer", minimum: 1, description: "rank: how many options each voter ranks. Default 3." },
    seats: { type: "integer", minimum: 1, description: "stv: number of winners. Default 1." },
    stvMethod: { type: "string", enum: ["scottish", "meek"], description: "stv: counting method. Default scottish." },
    quotaType: { type: "string", enum: ["droop", "hare"], description: "stv: quota. Default droop." },
    meetingDurationMinutes: { type: "integer", minimum: 1, description: "time_poll: meeting length in minutes. Default 60." }
  },
  additionalProperties: false
};

const OPTIONS_SCHEMA: JsonSchema = {
  type: "array",
  description: "The options, in order. Each is a label or {label, description}. Proposal types (sense_check, consent, consensus, majority) have fixed positions and can be left out. Time-poll labels are date-times: ISO 8601 with a zone (e.g. 2026-10-05T14:00:00Z), or YYYY-MM-DD HH:MM read as UTC.",
  items: {
    anyOf: [
      { type: "string" },
      { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"], additionalProperties: false }
    ]
  }
};

export const SETTING_KEYS = Object.keys((SETTINGS_SCHEMA.properties ?? {}) as Record<string, unknown>);

function parseOptionList(value: unknown[]): Array<{ label: string; meaning: string }> {
  return value.map((item, index) => {
    const entry = typeof item === "string" ? { label: item } : item && typeof item === "object" ? item as Record<string, unknown> : null;
    const label = entry && typeof entry.label === "string" ? entry.label : "";
    const meaning = entry && typeof entry.description === "string" ? entry.description : "";
    if (!label.trim()) throw new ToolError(`Option ${index + 1} needs a label.`);
    if (/[\r\n]/.test(label)) throw new ToolError(`Option ${index + 1}: labels must be a single line.`);
    return { label, meaning };
  });
}

function parseInviteeList(value: unknown[]): string[] {
  return value.map((name, index) => {
    if (typeof name !== "string") throw new ToolError(`Invitee ${index + 1} must be a name.`);
    if (/[\r\n]/.test(name)) throw new ToolError(`Invitee ${index + 1}: names must be a single line.`);
    return name;
  });
}

function dateArg(args: Args, key: string): string | null | undefined {
  if (!(key in args)) return undefined;
  const value = args[key];
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new ToolError(`\`${key}\` must be an ISO 8601 date-time string, or null to clear it.`);
  return value;
}

/**
 * The form-shaped record `inputFromData` reads, built from a base (the current
 * draft, or nothing) overlaid with the tool's arguments.
 */
function setupData(args: Args, base: { type: string; title: string; details: string; config: Partial<PollConfig>; opensAt: string | null; closesAt: string | null; invitees: string[] }) {
  const settings = record(args, "settings") ?? {};
  const unknown = Object.keys(settings).filter((key) => !SETTING_KEYS.includes(key));
  if (unknown.length) throw new ToolError(`Unknown setting${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Known settings: ${SETTING_KEYS.join(", ")}.`);
  const inviteeArg = list(args, "invitees");
  const invitees = inviteeArg ? parseInviteeList(inviteeArg) : base.invitees;
  const opensAt = dateArg(args, "opensAt");
  const closesAt = dateArg(args, "closesAt");
  return {
    ...base.config,
    ...settings,
    type: text(args, "type") ?? base.type,
    title: text(args, "title") ?? base.title,
    details: text(args, "details") ?? base.details,
    opensAt: opensAt === undefined ? base.opensAt ?? "" : opensAt ?? "",
    closesAt: closesAt === undefined ? base.closesAt ?? "" : closesAt ?? "",
    voterMode: invitees.length ? "invite" : "open",
    inviteesText: invitees.join("\n")
  };
}

function defaultOptions(type: string): Array<{ label: string; meaning: string }> {
  const template = templateByType.get(type as Poll["type"]);
  return (template?.defaultOptions ?? []).map((option) => ({ label: option.label, meaning: option.meaning ?? "" }));
}

/** Runs a server action, turning its user-facing errors into tool errors. */
function attempt<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (error instanceof InviteRequiredError) throw new ToolError("This poll is invite-only. Pass your personal invite link as `poll` (or its token as `inviteToken`).");
    throw new ToolError(error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Tools

const CREATE_PROPERTIES: Record<string, JsonSchema> = {
  type: { type: "string", enum: [...POLL_TYPES], description: "The decision method. Call list_poll_types to compare them." },
  title: { type: "string", description: "The question or proposal, e.g. \"Adopt the new house agreement?\" (max 200 characters)." },
  details: { type: "string", description: "Background and context for voters (plain text, max 10,000 characters)." },
  options: OPTIONS_SCHEMA,
  settings: SETTINGS_SCHEMA,
  invitees: { type: "array", items: { type: "string" }, description: "Names of the only people who may vote. Giving any makes the poll invite-only, and each invitee gets a personal link to pass on. Leave out for an open poll anyone with the link can vote in." },
  opensAt: { type: ["string", "null"], description: "When voting opens (ISO 8601). Used by schedule_poll." },
  closesAt: { type: ["string", "null"], description: "When voting closes by itself (ISO 8601). Leave out to close manually." }
};

export const tools: ToolDefinition[] = [
  {
    name: "list_poll_types",
    title: "List decision methods",
    description: "Describe every kind of poll this app can run (proposals like consent and consensus, polls like approval, score and ranking, elections like IRV and STV, and scheduling), with when to use each, how results are decided, default options and settings. Use it to pick the right `type` for create_poll.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run() {
      return {
        pollTypes: templates.map((template) => ({
          type: template.type,
          label: template.label,
          category: template.category,
          description: template.description,
          whenToUse: template.example,
          howResultsWork: template.resultShape,
          fixedOptions: isProposalType(template.type),
          defaultOptions: template.defaultOptions.map((option) => option.meaning ? { label: option.label, description: option.meaning } : { label: option.label }),
          defaultSettings: defaultConfigFor(template.type),
          references: template.links
        }))
      };
    }
  },
  {
    name: "create_poll",
    title: "Create a poll",
    description: "Create a new poll as a draft and become its admin. Returns the poll (with ids for each option), its shareable link, and an `adminToken`: keep it, because it is the only way to manage the poll from a later session. Set `open: true` to start voting straight away (or, with a future `opensAt`, to schedule it). Invite-only polls return a personal link per invitee to pass on.",
    inputSchema: {
      type: "object",
      properties: {
        ...CREATE_PROPERTIES,
        open: { type: "boolean", description: "Open voting immediately after creating (or schedule it, if `opensAt` is in the future). Default false: the poll stays a draft you can review and edit." }
      },
      required: ["type", "title"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    bucket: "create",
    run(args, ctx) {
      const type = required(args, "type");
      const optionArg = list(args, "options");
      const options = optionArg ? parseOptionList(optionArg) : defaultOptions(type);
      const data = setupData(args, { type, title: "", details: "", config: {}, opensAt: null, closesAt: null, invitees: [] });
      const input = attempt(() => inputFromData(data, options));
      const { id } = createPollWithAdmin(input, ctx.jar);
      let poll = getStore().getPollBySlug(id) as Poll;
      if (args.open === true) {
        const future = poll.opensAt && poll.opensAt > new Date().toISOString();
        attempt(() => (future ? schedulePollOrThrow : openPollOrThrow)(poll.slug, ctx.jar));
        poll = getStore().getPollBySlug(id) as Poll;
      }
      return { created: true, ...pollView(poll, ctx), note: "Keep adminToken: it is the only way to manage this poll from another session. Share `url` with voters (or each invitee's personal link)." };
    }
  },
  {
    name: "get_poll",
    title: "Get a poll",
    description: "Read a poll the way a participant sees it: question, context, status, options (with ids), how to fill in the ballot, your own vote, whether you can vote, and results when they are visible to you. Admins also get invitation status and admin links. Pass personal invite links and admin links as `poll` to act as that invitee or admin.",
    inputSchema: {
      type: "object",
      properties: { poll: POLL_ARG, adminToken: ADMIN_TOKEN_ARG, inviteToken: INVITE_TOKEN_ARG, voteToken: VOTE_TOKEN_ARG },
      required: ["poll"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run(args, ctx) {
      return pollView(pollFor(args, ctx), ctx);
    }
  },
  {
    name: "cast_vote",
    title: "Cast or update a vote",
    description: "Vote in an open poll. Fill in the one ballot field for the poll's type (get_poll's `howToVote` says which, with an example): `choice` for proposals, `selected` for choose/approval, `scores` for score, `allocations` for allocate, `ranking` for rank/irv/stv, `availability` for time polls. Options can be named by label or id. Open polls need a `voterName`, except anonymous ones, which take no name; invite-only polls vote as the invitee whose link you used. Each session votes as one person; votes are final unless the poll allows changes. Returns a `voteToken` to update this ballot later from another session.",
    inputSchema: {
      type: "object",
      properties: {
        poll: POLL_ARG,
        voterName: { type: "string", description: "Your display name (open polls; max 80 characters). Ignored in invite-only and anonymous polls." },
        reason: { type: "string", description: "Why you voted this way. Optional, required, or disabled depending on the poll." },
        choice: { type: ["string", "integer"], description: "Proposals (sense_check, consent, consensus, majority): the one position you take, e.g. \"Agree\"." },
        selected: { type: "array", items: { type: ["string", "integer"] }, description: "choose / approval: the options you pick." },
        scores: { type: "object", additionalProperties: { type: "number" }, description: "score: a score for every option, e.g. {\"Venue A\": 4, \"Venue B\": 2}." },
        allocations: { type: "object", additionalProperties: { type: "integer", minimum: 0 }, description: "allocate: whole points per option, within the budget; omitted options get 0." },
        ranking: { type: "array", items: { type: ["string", "integer"] }, description: "rank / irv / stv: options in order of preference, favourite first." },
        availability: { type: "object", additionalProperties: { type: "string", enum: ["available", "if_needed", "unavailable"] }, description: "time_poll: your availability per timeslot (label, ISO time or id)." },
        defaultAvailability: { type: "string", enum: ["available", "if_needed", "unavailable"], description: "time_poll: answer for any timeslot not in `availability`." },
        adminToken: ADMIN_TOKEN_ARG,
        inviteToken: INVITE_TOKEN_ARG,
        voteToken: VOTE_TOKEN_ARG
      },
      required: ["poll"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    bucket: "mutate",
    run(args, ctx) {
      const poll = pollFor(args, ctx);
      const db = getStore();
      if (!isOpen(poll)) {
        const reason = cannotVoteReason(poll, false, false, isPollAdmin(ctx.jar, poll.id));
        throw new ToolError(reason ?? "Voting is not open.");
      }
      const options = db.getOptions(poll.id);
      const data: Record<string, unknown> = { ...ballotFields(poll, options, args), voterName: text(args, "voterName") ?? "", reason: text(args, "reason") ?? "" };
      if (poll.config.voterMode !== "invite" && !String(data.voterName).trim()) {
        // Recasting from the same session keeps the name already on the ballot.
        const previous = viewerContext(poll, ctx.jar).viewerName;
        if (previous) data.voterName = previous;
      }
      attempt(() => submitVoteData(poll, options, data, ctx.jar));
      const view = pollView(poll, ctx);
      const you = view.you as Record<string, unknown>;
      const voteToken = poll.config.voterMode === "invite" ? undefined : ctx.jar.get(voteTokenCookie(poll.id));
      return {
        voted: true,
        votingAs: you.votingAs,
        yourVote: you.yourVote,
        ...(voteToken ? { voteToken, note: "Keep voteToken to see or update this ballot from another session." } : {}),
        canChangeVote: you.canVote,
        poll: view
      };
    }
  },
  {
    name: "get_results",
    title: "Get results",
    description: "The current tally for a poll, if results are visible to you: the outcome, quorum, per-option counts or scores, round-by-round transfers for IRV/STV, and voters' names and reasons (anonymous polls show reasons only, without names, in alphabetical order as \`anonymousReasons\`). Visibility follows the poll's rules (for example only after you vote, or only once it closes).",
    inputSchema: {
      type: "object",
      properties: { poll: POLL_ARG, adminToken: ADMIN_TOKEN_ARG, inviteToken: INVITE_TOKEN_ARG, voteToken: VOTE_TOKEN_ARG },
      required: ["poll"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run(args, ctx) {
      const poll = pollFor(args, ctx);
      const db = getStore();
      const options = db.getOptions(poll.id);
      const votes = db.getVotes(poll.id);
      const { viewerVote } = viewerContext(poll, ctx.jar);
      return {
        id: poll.slug,
        title: poll.title,
        type: poll.type,
        status: lifecycle(poll),
        voteCount: votes.length,
        ...resultsFor(poll, options, votes, viewerVote, isPollAdmin(ctx.jar, poll.id), ctx)
      };
    }
  },
  {
    name: "list_my_polls",
    title: "List my polls",
    description: "Polls this session has created, voted in, or been invited to (plus every poll, for the instance operator), grouped as drafts, active and closed. A new session starts empty: open polls through get_poll with their id or link.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run(_args, ctx) {
      const items = involvedPolls(ctx.jar).map(({ poll, role }) => ({
        id: poll.slug,
        title: poll.title,
        type: poll.type,
        status: lifecycle(poll),
        role: role ?? "operator",
        url: `${ctx.origin}${pollPath(poll)}`,
        ...(poll.status === "scheduled" ? { opensAt: poll.opensAt } : {}),
        ...(poll.closesAt ? { closesAt: poll.closesAt } : {})
      }));
      return {
        drafts: items.filter((item) => item.status === "draft" || item.status === "scheduled"),
        active: items.filter((item) => item.status === "open"),
        closed: items.filter((item) => item.status === "closed")
      };
    }
  },
  {
    name: "get_usage_events",
    title: "Read the usage log",
    description: "Instance operator only (connect with the operator token as the bearer token). The usage log, newest first: descriptions sent to Jev with the model's answers, polls created, changed, opened and closed (linked to the description they came from through suggestionId), votes cast (anonymous polls without any voter or session), agent tool calls, exports, and browser page views and clicks. Filter by kind or kindPrefix (describe, poll_, vote_, mcp_, client_), poll id, session, source, text and time; page with `before`. Also returns counts per day and kind.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "One event kind, e.g. describe, poll_created, vote_cast, mcp_tool, client_click." },
        kindPrefix: { type: "string", description: "Kinds starting with this, e.g. \"poll_\" or \"client_\"." },
        poll: { type: "string", description: "A poll id (slug) to follow one poll through its life." },
        session: { type: "string", description: "A browser or MCP session id from an earlier event." },
        source: { type: "string", enum: ["web", "api", "mcp", "browser", "internal"] },
        text: { type: "string", description: "Substring to find in the event's data (prompts, titles, paths...)." },
        since: { type: "string", description: "ISO date or time; events at or after." },
        until: { type: "string", description: "ISO date or time; events before." },
        before: { type: "integer", description: "Only events with an id below this: the `next` value of the previous page." },
        limit: { type: "integer", description: "Events per page, 1 to 500 (default 100)." }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run(args, ctx) {
      if (!isOperator(ctx.jar)) throw new ToolError("Only the instance operator can read the usage log. Connect with the operator token as the bearer token.");
      const filter = filterFromInput((key) => args[key]);
      const limit = Math.min(filter.limit ?? 100, 500);
      const rows = readEvents({ ...filter, limit: limit + 1 });
      const events = rows.slice(0, limit);
      return {
        events,
        next: rows.length > limit ? (events[events.length - 1]?.id ?? null) : null,
        summary: getStore().eventSummary({ ...filter, before: undefined })
      };
    }
  },
  {
    name: "get_jev_corrections",
    title: "Read how the model's readings were corrected",
    description: "Instance operator only. Every plain-language description joined to what became of it: the model's reading (Clef or Jev; voting method with confidence, title, options, settings), the poll the person finally saved, and the field-level corrections between them (including settings the model missed), with an outcome per description (accepted, corrected, rephrased, abandoned, pending). Returns summary statistics (per-model comparison, correction rate by field, voting-method confusions, confidence calibration) and rows. Set format to \"jsonl\" for training-ready lines of prompt, the model's prediction and the corrected labels.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO date or time; descriptions at or after." },
        until: { type: "string", description: "ISO date or time; descriptions before." },
        limit: { type: "integer", description: "Most recent descriptions to include, 1 to 500 (default 100)." },
        outcome: { type: "string", enum: ["accepted", "corrected", "rephrased", "abandoned", "pending"] },
        format: { type: "string", enum: ["json", "jsonl"], description: "json (default) returns rows and statistics; jsonl returns the training export as text." }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run(args, ctx) {
      if (!isOperator(ctx.jar)) throw new ToolError("Only the instance operator can read the model corrections. Connect with the operator token as the bearer token.");
      const limit = Math.min(Math.max(Math.trunc(Number(args.limit)) || 100, 1), 500);
      const all = correctionRows({ since: typeof args.since === "string" ? args.since : undefined, until: typeof args.until === "string" ? args.until : undefined, limit });
      const rows = typeof args.outcome === "string" ? all.filter((row) => row.outcome === args.outcome) : all;
      if (args.format === "jsonl") return { jsonl: trainingJsonl(rows), rows: rows.length };
      return { statistics: correctionStats(all), rows };
    }
  },
  {
    name: "update_draft",
    title: "Edit a draft",
    description: "Change a draft poll's setup (admin only; setup is frozen once a poll is scheduled or opened). Only the fields you pass change; `options` and `invitees` replace the whole list, and `settings` are merged into the current ones. Changing `type` without `options` switches to that type's default options. Pass `invitees: []` to make the poll open to anyone with the link.",
    inputSchema: {
      type: "object",
      properties: { poll: POLL_ARG, ...CREATE_PROPERTIES, adminToken: ADMIN_TOKEN_ARG },
      required: ["poll"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    bucket: "mutate",
    run(args, ctx) {
      const poll = pollFor(args, ctx);
      requireAdmin(poll, ctx);
      if (poll.status !== "draft") throw new ToolError(poll.status === "scheduled" ? "This poll is scheduled, so its setup is frozen. Unschedule it first to edit it." : "Only draft polls can be edited; this one has already opened.");
      const db = getStore();
      const type = text(args, "type") ?? poll.type;
      const optionArg = list(args, "options");
      const options = optionArg
        ? parseOptionList(optionArg)
        : type === poll.type
          ? db.getOptions(poll.id).map((option) => ({ label: option.label, meaning: option.meaning }))
          : defaultOptions(type);
      // parseConfig reads only the keys the (possibly new) type uses, so the
      // current config can always be the base; stale type-specific keys drop out.
      const data = setupData(args, {
        type: poll.type,
        title: poll.title,
        details: poll.details,
        config: poll.config,
        opensAt: poll.opensAt,
        closesAt: poll.closesAt,
        invitees: poll.config.voterMode === "invite" ? db.getInvites(poll.id).map((invite) => invite.name) : []
      });
      attempt(() => updateDraftOrThrow(poll, inputFromData(data, options), ctx.jar));
      return { updated: true, ...pollView(poll, ctx) };
    }
  },
  {
    name: "open_poll",
    title: "Open voting",
    description: "Open a draft poll for voting now (admin only). Its setup is frozen from then on. To open later instead, use schedule_poll.",
    inputSchema: { type: "object", properties: { poll: POLL_ARG, adminToken: ADMIN_TOKEN_ARG }, required: ["poll"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    bucket: "mutate",
    run(args, ctx) {
      const poll = pollFor(args, ctx);
      requireAdmin(poll, ctx);
      attempt(() => openPollOrThrow(poll.slug, ctx.jar));
      return { opened: true, ...pollView(poll, ctx) };
    }
  },
  {
    name: "schedule_poll",
    title: "Schedule opening",
    description: "Make a draft open by itself at a future time (admin only). Pass `opensAt` to set the time in the same step. The setup is frozen while scheduled; unschedule_poll turns it back into an editable draft.",
    inputSchema: {
      type: "object",
      properties: { poll: POLL_ARG, opensAt: { type: "string", description: "When voting opens (ISO 8601, in the future). Defaults to the draft's current opensAt." }, adminToken: ADMIN_TOKEN_ARG },
      required: ["poll"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    bucket: "mutate",
    run(args, ctx) {
      const poll = pollFor(args, ctx);
      requireAdmin(poll, ctx);
      const opensAt = dateArg(args, "opensAt");
      if (opensAt) {
        if (poll.status !== "draft") throw new ToolError("Only draft polls can be scheduled.");
        const db = getStore();
        const data = setupData({ opensAt }, {
          type: poll.type,
          title: poll.title,
          details: poll.details,
          config: poll.config,
          opensAt: poll.opensAt,
          closesAt: poll.closesAt,
          invitees: poll.config.voterMode === "invite" ? db.getInvites(poll.id).map((invite) => invite.name) : []
        });
        const options = db.getOptions(poll.id).map((option) => ({ label: option.label, meaning: option.meaning }));
        attempt(() => updateDraftOrThrow(poll, inputFromData(data, options), ctx.jar));
      }
      attempt(() => schedulePollOrThrow(poll.slug, ctx.jar));
      return { scheduled: true, ...pollView(poll, ctx) };
    }
  },
  {
    name: "unschedule_poll",
    title: "Cancel scheduled opening",
    description: "Turn a scheduled poll back into an editable draft before it opens (admin only).",
    inputSchema: { type: "object", properties: { poll: POLL_ARG, adminToken: ADMIN_TOKEN_ARG }, required: ["poll"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    bucket: "mutate",
    run(args, ctx) {
      const poll = pollFor(args, ctx);
      requireAdmin(poll, ctx);
      attempt(() => unschedulePollOrThrow(poll.slug, ctx.jar));
      return { unscheduled: true, ...pollView(poll, ctx) };
    }
  },
  {
    name: "close_poll",
    title: "Close voting",
    description: "End voting now and fix the result (admin only). Closed polls cannot be reopened; results then become visible to everyone who can see the poll, and exports become available.",
    inputSchema: { type: "object", properties: { poll: POLL_ARG, adminToken: ADMIN_TOKEN_ARG }, required: ["poll"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    bucket: "mutate",
    run(args, ctx) {
      const poll = pollFor(args, ctx);
      requireAdmin(poll, ctx);
      attempt(() => closePollOrThrow(poll.slug, ctx.jar));
      return { closed: true, ...pollView(poll, ctx) };
    }
  },
  {
    name: "delete_poll",
    title: "Delete a poll",
    description: "Permanently delete a poll with all its votes and invitations (admin only). This cannot be undone; confirm with whoever you act for first.",
    inputSchema: { type: "object", properties: { poll: POLL_ARG, adminToken: ADMIN_TOKEN_ARG }, required: ["poll"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    bucket: "mutate",
    run(args, ctx) {
      const poll = pollFor(args, ctx);
      requireAdmin(poll, ctx);
      attempt(() => deletePollOrThrow(poll.slug, ctx.jar));
      return { deleted: true, id: poll.slug, title: poll.title };
    }
  },
  {
    name: "duplicate_poll",
    title: "Duplicate a poll",
    description: "Copy any poll you admin (in any state) into a new draft titled \"Copy of ...\", with the same type, details, settings, options and invitee names (invitees get new links). Votes and times are not copied. You become admin of the copy; returns its new `adminToken`.",
    inputSchema: { type: "object", properties: { poll: POLL_ARG, adminToken: ADMIN_TOKEN_ARG }, required: ["poll"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    bucket: "create",
    run(args, ctx) {
      const poll = pollFor(args, ctx);
      requireAdmin(poll, ctx);
      const { id } = attempt(() => duplicatePollOrThrow(poll.slug, ctx.jar));
      return { duplicated: true, from: poll.slug, ...pollView(getStore().getPollBySlug(id) as Poll, ctx) };
    }
  },
  {
    name: "add_invitees",
    title: "Invite more people",
    description: "Add people to an invite-only poll that has not closed (admin only). Existing invitees are never removed or renamed. Returns each new invitee's personal link: send each person their own link.",
    inputSchema: {
      type: "object",
      properties: { poll: POLL_ARG, invitees: { type: "array", items: { type: "string" }, minItems: 1, description: "Names to invite (max 80 characters each; duplicates are skipped, ignoring case)." }, adminToken: ADMIN_TOKEN_ARG },
      required: ["poll", "invitees"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    bucket: "mutate",
    run(args, ctx) {
      const poll = pollFor(args, ctx);
      requireAdmin(poll, ctx);
      const names = parseInviteeList(list(args, "invitees") ?? []);
      const { added } = attempt(() => addInviteesOrThrow(poll.slug, ctx.jar, names.join("\n")));
      const view = pollView(poll, ctx);
      const invitations = (view.invitations as Array<{ name: string; link: string | null }> | undefined) ?? [];
      return { added, newInvitations: invitations.filter((entry) => added.includes(entry.name)), poll: view };
    }
  },
  {
    name: "export_results",
    title: "Export results",
    description: "Full export of a closed poll (admin only): the poll, its options, the complete tally, and every ballot. Anonymous polls replace names with \"Voter N\", drop timestamps, and shuffle ballot order; reasons stay beside their unnamed ballots. Same data as the web JSON export.",
    inputSchema: { type: "object", properties: { poll: POLL_ARG, adminToken: ADMIN_TOKEN_ARG }, required: ["poll"], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run(args, ctx) {
      const poll = pollFor(args, ctx);
      requireAdmin(poll, ctx);
      if (!isClosed(poll)) throw new ToolError("Exports are available only after this poll closes.");
      const db = getStore();
      const options = db.getOptions(poll.id);
      const votes = db.getVotes(poll.id);
      const { id: _internal, ...publicPoll } = poll;
      return {
        poll: { ...publicPoll, id: poll.slug },
        options: options.map((option) => optionView(poll, option)),
        tally: tallyFor(poll, options, votes),
        votes: exportVotes(poll, votes).map((vote) => ({ ...vote, ballot: describeBallot(poll, options, vote.ballot) }))
      };
    }
  }
];

export const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

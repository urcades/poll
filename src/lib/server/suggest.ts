import { templateByType } from "../../templates";
import { isProposalType, POLL_TYPES, type PollConfig, type PollType } from "../../types";
import type { Suggestion } from "../suggestion";

export type { Suggestion };

/**
 * Turns a plain-language description ("which two films for Friday: A, B, C or
 * D?") into a pre-filled poll: the voting method, settings the wording implies,
 * and the options. Code does the mechanical parts (finding candidate options
 * and numbers, writing the title); a decision model (Cloudflare's Clef, or
 * TypeSafe's Jev, which speak the same API) makes only the judgment calls, all
 * in ONE request of closed questions (it answers with choices and
 * probabilities, never free text):
 *   - which voting method fits (a choice over the 12 types),
 *   - which settings the wording asks for (yes/no questions),
 *   - what each number in the text means (a choice per number),
 *   - which candidate items are real options (a yes/no per item).
 * Nothing is created; the result pre-fills the editor, which the person checks.
 */

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_MODEL = "jev-latest";
export const CLEF_MODEL_ID = "@cf/cloudflare/clef";
export const MAX_PROMPT_LENGTH = 2000;

/** Probability an answer needs before it changes the form. */
const SETTING_THRESHOLD = 0.7;
const ROLE_THRESHOLD = 0.7;
const ITEM_THRESHOLD = 0.5;
const MAX_NUMBERS = 4;
const MAX_ITEMS = 12;

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string };

export interface SystemOneRequest {
  model: string;
  state: unknown;
  questions: Record<string, Question>;
}

type ChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
type NoulAnswer = { type: "noul"; noul: number };
export interface SystemOneResponse {
  answers: Record<string, ChoiceAnswer | NoulAnswer | { type: string }>;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

/** Sends one request to the model. Swappable so tests need no network. */
export type Ask = ((request: SystemOneRequest) => Promise<SystemOneResponse>) & {
  /** Which model answered, for the usage log: "clef", "jev" (or whatever a test sets). */
  providerName?: string;
};

export class SuggestError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export function typesafeApiKey(): string {
  return (process.env.TYPESAFE_API_KEY ?? "").trim();
}

/** The one thing the client needs from fetch (and what tests replace). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function typesafeAsk(apiKey: string, fetchImpl: FetchLike = fetch): Ask {
  const ask: Ask = async (request) => {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(TYPESAFE_ENDPOINT, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(20_000)
        });
      } catch {
        throw new SuggestError("Couldn't reach the description service. Try again, or start from New vote/proposal.", 503);
      }
      if (response.ok) return (await response.json()) as SystemOneResponse;
      // Rate limited or overloaded: one short retry, then give up.
      if ((response.status === 429 || response.status === 529) && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        continue;
      }
      console.error(`TypeSafe request failed with HTTP ${response.status}`);
      if (response.status === 401) throw new SuggestError("This server's TypeSafe API key was rejected.", 503);
      if (response.status === 429 || response.status === 529) throw new SuggestError("The description service is busy. Try again in a moment.", 503);
      throw new SuggestError("The description service couldn't read that. Try rephrasing, or start from New vote/proposal.");
    }
  };
  ask.providerName = "jev";
  return ask;
}

/** The Workers AI binding's one method (only present inside the Cloudflare Worker). */
export interface WorkersAi {
  run(model: string, input: unknown): Promise<unknown>;
}

/** Replies come back bare from the binding and wrapped in `{ result }` from the REST API. */
function unwrap(reply: unknown): SystemOneResponse {
  const body = reply as { result?: unknown; answers?: unknown } | null;
  const inner = (body && typeof body === "object" && "result" in body && body.result ? body.result : body) as SystemOneResponse | null;
  if (!inner || typeof inner !== "object" || typeof inner.answers !== "object") throw new SuggestError("The description service didn't return a usable answer. Try rephrasing.");
  return inner;
}

function busyOrFailed(status: number | null): never {
  if (status === 401 || status === 403) throw new SuggestError("This server's Cloudflare credentials were rejected.", 503);
  if (status === 429 || status === 529 || status === 503) throw new SuggestError("The description service is busy. Try again in a moment.", 503);
  throw new SuggestError("The description service couldn't read that. Try rephrasing, or start from New vote/proposal.");
}

/** Clef through the Workers AI binding: no credentials to manage inside the Worker. */
export function clefBindingAsk(ai: WorkersAi): Ask {
  const ask: Ask = async (request) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return unwrap(await ai.run(CLEF_MODEL_ID, { ...request, model: "clef" }));
      } catch (error) {
        if (error instanceof SuggestError) throw error;
        const status = Number((error as { status?: unknown }).status) || (/\b(429|529|503)\b/.exec(String((error as Error)?.message))?.[1] ? 429 : null);
        if (status === 429 && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 700));
          continue;
        }
        console.error("Workers AI request failed", error instanceof Error ? error.message : error);
        busyOrFailed(status);
      }
    }
  };
  ask.providerName = "clef";
  return ask;
}

/** Clef over the Workers AI REST API, for running anywhere else (Node, Fly, local development). */
export function clefRestAsk(accountId: string, apiToken: string, fetchImpl: FetchLike = fetch): Ask {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${CLEF_MODEL_ID}`;
  const ask: Ask = async (request) => {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" }, body: JSON.stringify({ ...request, model: "clef" }), signal: AbortSignal.timeout(20_000) });
      } catch {
        throw new SuggestError("Couldn't reach the description service. Try again, or start from New vote/proposal.", 503);
      }
      if (response.ok) return unwrap(await response.json());
      if ((response.status === 429 || response.status === 529) && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        continue;
      }
      console.error(`Workers AI request failed with HTTP ${response.status}`);
      busyOrFailed(response.status);
    }
  };
  ask.providerName = "clef";
  return ask;
}

let askOverride: Ask | null = null;
/** Tests replace the model; pass null to restore the real one. */
export function setAskForTesting(ask: Ask | null) {
  askOverride = ask;
}

/**
 * Which model reads descriptions. Clef when the Worker has its AI binding or
 * CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN are set; otherwise Jev when
 * TYPESAFE_API_KEY is. DESCRIBE_PROVIDER=jev (or clef) forces one, which is the
 * quick way back if a model misbehaves.
 */
export function currentAsk(): Ask | null {
  if (askOverride) return askOverride;
  const forced = (process.env.DESCRIBE_PROVIDER ?? "").trim().toLowerCase();
  const ai = (globalThis as { __pollAi?: WorkersAi }).__pollAi;
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const apiToken = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
  const clef = ai ? clefBindingAsk(ai) : accountId && apiToken ? clefRestAsk(accountId, apiToken) : null;
  const key = typesafeApiKey();
  const jev = key ? typesafeAsk(key) : null;
  if (forced === "jev") return jev;
  if (forced === "clef") return clef;
  return clef ?? jev;
}

// ---- What each voting method is for, as the model sees it ----------------

const TYPE_GUIDE: Record<PollType, string> = {
  sense_check: "A proposal still being shaped: gauge sentiment (looks good, could be better, needs a rethink) with no pass or fail result.",
  consent: "A proposal that goes ahead unless someone has a concrete objection; used for 'safe enough to try' decisions.",
  consensus: "A proposal needing strong shared agreement, where anyone can block; voters agree, abstain, disagree or block.",
  majority: "A plain yes or no question decided by whether Yes gets at least half the votes.",
  choose: "Pick one, or up to a set number, from a short list of options (for example which two films to watch).",
  approval: "Approve every option you would be happy with, with no limit; the most-approved option leads.",
  score: "Rate every option on a numeric scale, such as 0 to 5; the highest average wins.",
  allocate: "Split a fixed budget of points across the options to show how much each matters.",
  rank: "Put a few top choices in order of preference (a ranked top 3), counted by points rather than runoff.",
  irv: "Pick ONE winner among candidates by ranking them, with a runoff that eliminates the weakest (ranked-choice voting).",
  stv: "Elect SEVERAL people at once by ranking candidates (single transferable vote, committees, boards, organizers).",
  time_poll: "Find a time that works: people mark each proposed time slot as available, if needed, or unavailable."
};

const NUMBER_ROLES: Record<string, string> = {
  max_picks: "The most options each voter may pick",
  seats: "How many winners or people are being elected",
  points: "The total points voters get to split between options",
  scale_max: "The top of a rating scale (for example rate from 0 to 5)",
  ranks: "How many ranked choices each voter gives",
  minutes: "How long a meeting lasts, in minutes",
  hours: "How long a meeting lasts, in hours",
  option_count: "How many options or candidates there are to choose between",
  other: "Anything else: a date, a time, a price, an age, a quantity of something"
};

const COUNT_BUCKETS: Record<string, [string, number | null]> = {
  two: ["Exactly two options or candidates", 2],
  three: ["Three options or candidates", 3],
  four: ["Four options or candidates", 4],
  five: ["Five options or candidates", 5],
  six_to_eight: ["Six to eight options or candidates", 7],
  nine_to_twelve: ["Nine to twelve options or candidates", 10],
  more_than_twelve: ["More than twelve options or candidates", 15],
  unknown: ["The number of options is not stated or implied", null]
};

// ---- Mechanical extraction -------------------------------------------------

const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

interface FoundNumber {
  text: string;
  value: number;
  context: string;
}

export function findNumbers(prompt: string): FoundNumber[] {
  const found: FoundNumber[] = [];
  for (const match of prompt.matchAll(/\b(\d{1,5})\b|\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi)) {
    const text = match[0];
    const value = match[1] ? Number(match[1]) : NUMBER_WORDS[text.toLowerCase()];
    if (!Number.isFinite(value) || value === undefined) continue;
    const at = match.index ?? 0;
    const start = Math.max(0, at - 36);
    const context = `${start > 0 ? "…" : ""}${prompt.slice(start, at + text.length + 36).trim()}${at + text.length + 36 < prompt.length ? "…" : ""}`.replace(/\s+/g, " ");
    found.push({ text, value, context });
    if (found.length === MAX_NUMBERS) break;
  }
  return found;
}

const LIST_SPLIT = /\s*(?:,|;|\/|\n|\s+(?:or|and|vs\.?|versus)\s+)\s*/i;

function cleanItem(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:and|or)\s+/i, "")
    .replace(/^["'“‘(]+|["'”’)?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Candidate option names in the text: bullet lines, a list after a colon or "between/among/from", or a list in the closing sentence. */
export function candidateItems(prompt: string): { items: string[]; before: string } {
  const lines = prompt.split(/\r?\n/);
  const bullets = lines.map((line) => /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line)?.[1]).filter((item): item is string => Boolean(item));
  let before = prompt;
  let items: string[] = [];
  if (bullets.length >= 2) {
    items = bullets;
    before = lines.filter((line) => !/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)).join(" ");
  } else {
    // A list ends where its sentence does ("…, Diana and Eli. Rank your choices.").
    const firstSentence = (segment: string) => segment.split(/[.?!](?=\s|$)/)[0] ?? "";
    const colon = /:\s/.exec(prompt);
    const preposition = /\b(?:between|among|amongst|from|choose from|pick from)\s+(.+)$/is.exec(prompt);
    const sentences = prompt.trim().split(/(?<=[.?!])\s+/);
    if (colon && colon.index !== undefined) {
      items = firstSentence(prompt.slice(colon.index + 1)).split(LIST_SPLIT);
      before = prompt.slice(0, colon.index);
    } else if (preposition && preposition.index !== undefined) {
      items = firstSentence(preposition[1] ?? "").split(LIST_SPLIT);
      before = prompt.slice(0, preposition.index);
    } else if (sentences.length >= 2) {
      items = firstSentence(sentences[sentences.length - 1] ?? "").split(LIST_SPLIT);
      before = sentences.slice(0, -1).join(" ");
    }
  }
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of items) {
    const item = cleanItem(raw);
    const key = item.toLowerCase();
    if (!item || item.length > 60 || item.split(" ").length > 6 || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(item);
  }
  // A closing sentence only counts as a list when it is mostly short names.
  const mostlyShort = cleaned.length >= 2 && cleaned.length >= items.filter((item) => item.trim()).length - 1;
  return mostlyShort ? { items: cleaned.slice(0, 20), before } : { items: [], before: prompt };
}

export function titleFor(prompt: string, before: string): string {
  const source = (before.trim() || prompt.trim()).replace(/\s+/g, " ");
  const sentence = /^.*?[.?!](?=\s|$)/.exec(source)?.[0] ?? source;
  let title = sentence.trim().replace(/[:;,\s]+$/, "");
  // A long run-on opening clause makes a poor title; keep the part before its first comma.
  const comma = title.indexOf(", ");
  if (title.length > 70 && comma >= 15) title = title.slice(0, comma);
  if (!title) title = "New vote";
  return title.length > 200 ? `${title.slice(0, 199)}…` : title;
}

function letterRows(type: PollType, count: number): string {
  const noun = type === "irv" || type === "stv" ? "Candidate" : "Option";
  return Array.from({ length: count }, (_, index) => `${noun} ${count <= 26 ? String.fromCharCode(65 + index) : index + 1}`).join("\n");
}

// ---- The interpreter -------------------------------------------------------

function choiceAnswer(response: SystemOneResponse, id: string): ChoiceAnswer | null {
  const answer = response.answers?.[id];
  return answer && answer.type === "choice" && typeof (answer as ChoiceAnswer).choice === "string" ? (answer as ChoiceAnswer) : null;
}

function noulAnswer(response: SystemOneResponse, id: string): number | null {
  const answer = response.answers?.[id];
  return answer && answer.type === "noul" && typeof (answer as NoulAnswer).noul === "number" ? (answer as NoulAnswer).noul : null;
}

function probabilityOf(answer: ChoiceAnswer | null): number {
  return answer ? (answer.probabilities?.[answer.choice] ?? answer.confidence ?? 0) : 0;
}

export async function suggestPoll(rawPrompt: string, ask: Ask): Promise<Suggestion> {
  const prompt = rawPrompt.trim();
  if (!prompt) throw new SuggestError("Describe the vote first.", 400);
  if (prompt.length > MAX_PROMPT_LENGTH) throw new SuggestError(`That's too long (max ${MAX_PROMPT_LENGTH} characters).`, 400);

  const numbers = findNumbers(prompt);
  const { items, before } = candidateItems(prompt);
  const candidates = items.slice(0, MAX_ITEMS);

  const questions: Record<string, Question> = {
    type: {
      type: "choice",
      instructions: "A person describes something their group needs to decide. Which way of voting fits it best? Judge by HOW the decision should be made, not by the topic.",
      criteria: Object.fromEntries(POLL_TYPES.map((type) => [type, TYPE_GUIDE[type]]))
    },
    anonymous: { type: "noul", instructions: "Does the request ask for votes to be anonymous, secret or private, so nobody can see who voted for what?" },
    changes: { type: "noul", instructions: "Does the request say people should be able to change their vote after they have voted?" },
    reason: { type: "noul", instructions: "Does the request say voters must explain or give a reason for their vote?" },
    option_count: {
      type: "choice",
      instructions: "How many options or candidates will people be choosing between, going only by what the request states or clearly implies?",
      criteria: Object.fromEntries(Object.entries(COUNT_BUCKETS).map(([key, [description]]) => [key, description]))
    }
  };
  numbers.forEach((found, index) => {
    questions[`number_${index}`] = {
      type: "choice",
      instructions: `The request contains the number "${found.text}" (${found.context}). What does that number mean?`,
      criteria: NUMBER_ROLES
    };
  });
  candidates.forEach((item, index) => {
    questions[`item_${index}`] = {
      type: "noul",
      instructions: `Is "${item}" one of the specific choices people will vote between (a name, place, thing, candidate or option), rather than a date, a description of the vote, or other framing?`
    };
  });

  const response = await ask({ model: TYPESAFE_MODEL, state: { request: prompt }, questions });

  // 1. The voting method.
  const typeAnswer = choiceAnswer(response, "type");
  const type = typeAnswer && (POLL_TYPES as readonly string[]).includes(typeAnswer.choice) ? (typeAnswer.choice as PollType) : null;
  if (!type || !typeAnswer) throw new SuggestError("The description service didn't return a usable answer. Try rephrasing.");
  const confidence = probabilityOf(typeAnswer);
  const alternatives = Object.entries(typeAnswer.probabilities ?? {})
    .filter(([key, value]) => key !== type && (POLL_TYPES as readonly string[]).includes(key) && value >= 0.15)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, value]) => ({ type: key as PollType, label: templateByType.get(key as PollType)?.label ?? key, percent: Math.round(value * 100) }));

  const label = templateByType.get(type)?.label ?? type;
  const notes: string[] = [`Voting method: ${label}${confidence ? ` (${Math.round(confidence * 100)}% sure)` : ""}`];
  const config: Partial<PollConfig> = {};

  // 2. Options (proposal types have fixed positions; time polls need real dates, which stay for the editor).
  let optionsText: string | null = null;
  let optionCount: number | null = null;
  const editableOptions = !isProposalType(type) && type !== "time_poll";
  if (editableOptions) {
    const kept = candidates.filter((_, index) => (noulAnswer(response, `item_${index}`) ?? 0) >= ITEM_THRESHOLD);
    const minimum = type === "irv" || type === "stv" ? 2 : 1;
    if (kept.length >= Math.max(2, minimum)) {
      optionsText = kept.join("\n");
      optionCount = kept.length;
      notes.push(`${kept.length} options taken from your description`);
    }
  }

  // 3. Numbers, by what the model says each one means.
  const roles = new Map<string, number>();
  numbers.forEach((found, index) => {
    const answer = choiceAnswer(response, `number_${index}`);
    if (answer && answer.choice !== "other" && probabilityOf(answer) >= ROLE_THRESHOLD && !roles.has(answer.choice)) roles.set(answer.choice, found.value);
  });

  // 4. How many placeholder rows, when the text names no options.
  if (editableOptions && optionCount === null) {
    const statedCount = roles.get("option_count");
    const bucket = choiceAnswer(response, "option_count");
    const fromBucket = bucket && probabilityOf(bucket) >= ROLE_THRESHOLD ? (COUNT_BUCKETS[bucket.choice]?.[1] ?? null) : null;
    const count = statedCount ?? fromBucket;
    if (count !== null && count >= 2 && count <= 20) {
      optionsText = letterRows(type, count);
      optionCount = count;
      notes.push(`${count} blank ${type === "irv" || type === "stv" ? "candidates" : "options"} to name`);
    }
  }
  const rows = optionCount ?? defaultRowCount(type);

  // 5. Settings that depend on the type, kept inside what the editor allows.
  const maxPicks = roles.get("max_picks");
  if (type === "choose" && maxPicks !== undefined && maxPicks >= 1) {
    config.maxChoices = Math.min(maxPicks, rows);
    notes.push(`Voters pick up to ${config.maxChoices}`);
  }
  const seats = roles.get("seats");
  if (type === "stv" && seats !== undefined && seats >= 1 && seats < rows) {
    config.seats = seats;
    notes.push(`${seats} seat${seats === 1 ? "" : "s"} to fill`);
  }
  const points = roles.get("points");
  if (type === "allocate" && points !== undefined && points >= 1 && points <= 100_000) {
    config.pointBudget = points;
    notes.push(`${points} points to split`);
  }
  const scaleMax = roles.get("scale_max");
  if (type === "score" && scaleMax !== undefined && scaleMax >= 1 && scaleMax <= 1000) {
    config.scoreMax = scaleMax;
    notes.push(`Scores run 0 to ${scaleMax}`);
  }
  const ranks = roles.get("ranks");
  if (type === "rank" && ranks !== undefined && ranks >= 1) {
    config.rankCount = Math.min(ranks, rows);
    notes.push(`Voters rank their top ${config.rankCount}`);
  }
  if (type === "time_poll") {
    const minutes = roles.get("minutes") ?? (roles.has("hours") ? (roles.get("hours") ?? 0) * 60 : undefined);
    if (minutes !== undefined && minutes >= 1 && minutes <= 10_080) {
      config.meetingDurationMinutes = minutes;
      notes.push(`Meeting length ${minutes} minutes`);
    }
    notes.push("Pick the time slots yourself; dates aren't read from the description");
  }

  // 6. Settings the wording asked for.
  if ((noulAnswer(response, "anonymous") ?? 0) >= SETTING_THRESHOLD) {
    config.anonymous = true;
    notes.push("Anonymous voting on");
  }
  if ((noulAnswer(response, "changes") ?? 0) >= SETTING_THRESHOLD) {
    config.allowVoteChanges = true;
    notes.push("Voters can change their vote");
  }
  if ((noulAnswer(response, "reason") ?? 0) >= SETTING_THRESHOLD) {
    config.reasonMode = "required";
    notes.push("A reason is required with each vote");
  }

  return { id: crypto.randomUUID().replaceAll("-", "").slice(0, 16), type, title: titleFor(prompt, before), optionsText, config, confidence, alternatives, notes };
}

function defaultRowCount(type: PollType): number {
  return templateByType.get(type)?.defaultOptions.length ?? 3;
}

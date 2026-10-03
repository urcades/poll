import type { EventRow } from "../../db";
import { suggestionChanges, type FieldChange, type SavedLike, type SuggestionLike } from "../suggestionDiff";
import { getStore } from "./app";

/**
 * Jev's corrections: every description joined to what became of it, computed
 * from the usage log (describe -> poll_created -> poll_updated -> poll_opened).
 * The saved poll's final state is the label; the person correcting Jev is the
 * teacher. Nothing here is stored: it is recomputed from the events.
 */

export type Outcome =
  /** Saved a poll and opened it, or kept it as a draft, with nothing changed. */
  | "accepted"
  /** Saved a poll after changing at least one thing Jev filled in or missed. */
  | "corrected"
  /** Described again soon after, without saving: the first reading was probably unusable. */
  | "rephrased"
  /** Nothing saved and no retry (more than an hour ago, so unlikely to still be in progress). */
  | "abandoned"
  /** Too recent to tell. */
  | "pending";

export interface CorrectionRow {
  describeEventId: number;
  ts: string;
  session: string;
  suggestionId: string;
  prompt: string;
  /** Which model read it: "clef", "jev" (also what events logged before models were recorded are assumed to be). */
  provider: string;
  jev: SuggestionLike & { confidence: number; alternatives: Array<{ type: string; percent: number }>; probabilities: Record<string, number> | null };
  outcome: Outcome;
  pollSlug: string;
  /** The poll as last saved (the draft edits after creation count: they are corrections too). */
  final: SavedLike | null;
  /** Opened for voting, rather than left as a draft or deleted. */
  opened: boolean;
  deleted: boolean;
  changes: FieldChange[];
  /** The method the person switched to was one Jev had listed as a close second. */
  pickedAlternative: boolean;
  /** The next thing they typed, if they rephrased. */
  rephrasedTo: string | null;
}

const HOUR = 3_600_000;
const REPHRASE_WINDOW = 30 * 60_000;

function asSaved(data: Record<string, unknown>): SavedLike {
  return { type: data.type as SavedLike["type"], title: String(data.title ?? ""), config: data.config as SavedLike["config"], options: (data.options ?? []) as SavedLike["options"] };
}

function suggestionOf(describe: EventRow): CorrectionRow["jev"] {
  const suggestion = (describe.data.suggestion ?? {}) as Record<string, unknown>;
  const answers = (describe.data.modelAnswers ?? {}) as Record<string, { probabilities?: Record<string, number> }>;
  return {
    type: suggestion.type as SuggestionLike["type"],
    title: String(suggestion.title ?? ""),
    optionsText: typeof suggestion.optionsText === "string" ? suggestion.optionsText : null,
    config: (suggestion.config ?? {}) as SuggestionLike["config"],
    confidence: Number(suggestion.confidence ?? 0),
    alternatives: ((suggestion.alternatives ?? []) as Array<{ type: string; percent: number }>).map((alt) => ({ type: alt.type, percent: alt.percent })),
    probabilities: answers.type?.probabilities ?? null
  };
}

export function correctionRows(options: { since?: string; until?: string; limit?: number; now?: number } = {}): CorrectionRow[] {
  const store = getStore();
  const now = options.now ?? Date.now();
  const describes = store.listEvents({ kind: "describe", since: options.since, until: options.until, limit: options.limit ?? 500 });
  return describes.map((describe): CorrectionRow => {
    const suggestionId = String(describe.data.suggestionId ?? "");
    const jev = suggestionOf(describe);
    const created = suggestionId ? store.findEvent("poll_created", "suggestionId", suggestionId) : null;
    let final: SavedLike | null = null;
    let opened = false;
    let deleted = false;
    let changes: FieldChange[] = [];
    if (created) {
      const latest = store.listEvents({ kind: "poll_updated", pollSlug: created.pollSlug, limit: 1 })[0] ?? created;
      final = asSaved(latest.data);
      opened = store.listEvents({ kind: "poll_opened", pollSlug: created.pollSlug, limit: 1 }).length > 0;
      deleted = store.listEvents({ kind: "poll_deleted", pollSlug: created.pollSlug, limit: 1 }).length > 0;
      changes = suggestionChanges(jev, final);
    }
    let rephrasedTo: string | null = null;
    if (!created && describe.session) {
      const later = store
        .listEvents({ kind: "describe", session: describe.session, since: describe.ts, limit: 20 })
        .filter((other) => other.id > describe.id && Date.parse(other.ts) - Date.parse(describe.ts) <= REPHRASE_WINDOW)
        .at(-1);
      rephrasedTo = later ? String(later.data.prompt ?? "") : null;
    }
    const outcome: Outcome = created ? (changes.length ? "corrected" : "accepted") : rephrasedTo !== null ? "rephrased" : now - Date.parse(describe.ts) > HOUR ? "abandoned" : "pending";
    const typeChange = changes.find((change) => change.field === "type");
    return {
      describeEventId: describe.id,
      ts: describe.ts,
      session: describe.session,
      suggestionId,
      prompt: String(describe.data.prompt ?? ""),
      provider: String(describe.data.provider ?? "jev"),
      jev,
      outcome,
      pollSlug: created?.pollSlug ?? "",
      final,
      opened,
      deleted,
      changes,
      pickedAlternative: Boolean(typeChange && jev.alternatives.some((alt) => alt.type === typeChange.final)),
      rephrasedTo
    };
  });
}

export interface CorrectionStats {
  descriptions: number;
  outcomes: Record<Outcome, number>;
  /** Of the saved ones: share saved exactly as Jev filled it. */
  acceptedShare: number | null;
  /** How often each field was corrected, among saved polls. */
  fieldCorrections: Array<{ field: string; count: number; share: number; missed: number }>;
  /** Jev's method -> the method that was saved, when they differ. */
  typeConfusions: Array<{ jev: string; final: string; count: number }>;
  /** Did the method Jev picked survive, by how sure Jev was? */
  calibration: Array<{ bucket: string; saved: number; typeKept: number; typeKeptShare: number | null }>;
  /** The same headline numbers per model, to compare them. */
  providers: Array<{ provider: string; descriptions: number; saved: number; acceptedShare: number | null; typeKeptShare: number | null; meanConfidence: number | null }>;
}

export function correctionStats(rows: CorrectionRow[]): CorrectionStats {
  const outcomes: Record<Outcome, number> = { accepted: 0, corrected: 0, rephrased: 0, abandoned: 0, pending: 0 };
  for (const row of rows) outcomes[row.outcome] += 1;
  const saved = rows.filter((row) => row.final);

  const fields = new Map<string, { count: number; missed: number }>();
  const confusions = new Map<string, number>();
  for (const row of saved) {
    for (const change of row.changes) {
      const entry = fields.get(change.field) ?? { count: 0, missed: 0 };
      entry.count += 1;
      if (change.jevSet === false) entry.missed += 1;
      fields.set(change.field, entry);
      if (change.field === "type") confusions.set(`${change.jev}\u0000${change.final}`, (confusions.get(`${change.jev}\u0000${change.final}`) ?? 0) + 1);
    }
  }

  const buckets = [
    { bucket: "under 60%", test: (c: number) => c < 0.6 },
    { bucket: "60-80%", test: (c: number) => c >= 0.6 && c < 0.8 },
    { bucket: "80-95%", test: (c: number) => c >= 0.8 && c < 0.95 },
    { bucket: "95%+", test: (c: number) => c >= 0.95 }
  ];

  return {
    descriptions: rows.length,
    outcomes,
    acceptedShare: saved.length ? outcomes.accepted / saved.length : null,
    fieldCorrections: [...fields]
      .map(([field, entry]) => ({ field, count: entry.count, share: entry.count / saved.length, missed: entry.missed }))
      .sort((a, b) => b.count - a.count),
    typeConfusions: [...confusions]
      .map(([key, count]) => ({ jev: key.split("\u0000")[0]!, final: key.split("\u0000")[1]!, count }))
      .sort((a, b) => b.count - a.count),
    providers: [...new Set(rows.map((row) => row.provider))].sort().map((provider) => {
      const mine = rows.filter((row) => row.provider === provider);
      const mineSaved = mine.filter((row) => row.final);
      return {
        provider,
        descriptions: mine.length,
        saved: mineSaved.length,
        acceptedShare: mineSaved.length ? mineSaved.filter((row) => row.outcome === "accepted").length / mineSaved.length : null,
        typeKeptShare: mineSaved.length ? mineSaved.filter((row) => !row.changes.some((change) => change.field === "type")).length / mineSaved.length : null,
        meanConfidence: mine.length ? mine.reduce((sum, row) => sum + row.jev.confidence, 0) / mine.length : null
      };
    }),
    calibration: buckets.map(({ bucket, test }) => {
      const inBucket = saved.filter((row) => test(row.jev.confidence));
      const kept = inBucket.filter((row) => !row.changes.some((change) => change.field === "type")).length;
      return { bucket, saved: inBucket.length, typeKept: kept, typeKeptShare: inBucket.length ? kept / inBucket.length : null };
    })
  };
}

/**
 * One JSON object per line, ready for training or evaluating a classifier:
 * the prompt, what Jev predicted (with its probabilities), and what the person
 * ended up with. `labels` is the corrected truth; only saved polls have it.
 */
export function trainingJsonl(rows: CorrectionRow[]): string {
  return rows
    .map((row) =>
      JSON.stringify({
        id: row.suggestionId,
        ts: row.ts,
        prompt: row.prompt,
        outcome: row.outcome,
        provider: row.provider,
        jev: { type: row.jev.type, confidence: row.jev.confidence, probabilities: row.jev.probabilities, title: row.jev.title, optionsText: row.jev.optionsText, config: row.jev.config },
        labels: row.final ? { type: row.final.type, title: row.final.title, options: row.final.options.map((option) => option.label), config: row.final.config, opened: row.opened, deleted: row.deleted } : null,
        corrections: row.changes,
        pickedAlternative: row.pickedAlternative,
        rephrasedTo: row.rephrasedTo
      })
    )
    .join("\n");
}

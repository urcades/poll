import { defaultConfigFor } from "../templates";
import type { PollConfig, PollType } from "../types";

/** What Jev pre-filled (the stored `suggestion` of a describe event). */
export interface SuggestionLike {
  type: PollType;
  title: string;
  optionsText: string | null;
  config: Partial<PollConfig>;
}

/** What the person saved. */
export interface SavedLike {
  type: PollType;
  title: string;
  config: PollConfig;
  options: Array<{ label: string; meaning: string }>;
}

export interface FieldChange {
  /** "type", "title", "options", "optionCount" or "config.<setting>". */
  field: string;
  jev: unknown;
  final: unknown;
  /** For config settings: did Jev set it (so it was wrong), or leave it at the default (so it missed it)? */
  jevSet?: boolean;
  /** For options: what moved. */
  detail?: { added: string[]; removed: string[]; reordered: boolean };
}

const BLANK_ROW = /^(Option|Candidate) [A-Z0-9]+$/;

export function optionLabelsOf(optionsText: string): string[] {
  return optionsText.split("\n").map((line) => line.split("|")[0]?.trim() ?? "").filter(Boolean);
}

/**
 * Where a saved poll differs from what Jev suggested: the corrections.
 * Jev's claims only: its voting method, title, options (or how many) and the
 * settings it set; settings it left alone are compared against the type's
 * defaults, so "Jev missed that I wanted it anonymous" shows up too.
 */
export function suggestionChanges(suggestion: SuggestionLike, saved: SavedLike): FieldChange[] {
  const changes: FieldChange[] = [];
  if (suggestion.type !== saved.type) changes.push({ field: "type", jev: suggestion.type, final: saved.type });
  if (suggestion.title !== saved.title) changes.push({ field: "title", jev: suggestion.title, final: saved.title });

  // Options matter only for types where Jev can name them.
  if (suggestion.optionsText !== null && saved.type !== "time_poll") {
    const jev = optionLabelsOf(suggestion.optionsText);
    const final = saved.options.map((option) => option.label);
    if (jev.every((label) => BLANK_ROW.test(label))) {
      // Jev only knew how many; filling in the names is expected.
      if (jev.length !== final.length) changes.push({ field: "optionCount", jev: jev.length, final: final.length });
    } else if (JSON.stringify(jev) !== JSON.stringify(final)) {
      const added = final.filter((label) => !jev.includes(label));
      const removed = jev.filter((label) => !final.includes(label));
      changes.push({ field: "options", jev, final, detail: { added, removed, reordered: !added.length && !removed.length } });
    }
  }

  // Settings only make sense to compare while the voting method is the one Jev picked.
  if (suggestion.type === saved.type) {
    const jevConfig = { ...defaultConfigFor(suggestion.type), ...suggestion.config } as unknown as Record<string, unknown>;
    const finalConfig = saved.config as unknown as Record<string, unknown>;
    for (const key of Object.keys(finalConfig)) {
      if (!(key in jevConfig)) continue;
      if (JSON.stringify(jevConfig[key]) !== JSON.stringify(finalConfig[key])) {
        changes.push({ field: `config.${key}`, jev: jevConfig[key], final: finalConfig[key], jevSet: key in suggestion.config });
      }
    }
  }
  return changes;
}

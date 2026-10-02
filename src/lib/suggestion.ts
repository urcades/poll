import { defaultConfigFor, defaultOptionsText } from "../templates";
import type { PollConfig, PollType } from "../types";

/** A poll pre-filled from a plain-language description (see lib/server/suggest.ts). */
export interface Suggestion {
  type: PollType;
  title: string;
  /** One `label | meaning` per line; null keeps the type's default options. */
  optionsText: string | null;
  /** Only the settings the description implied; everything else stays default. */
  config: Partial<PollConfig>;
  /** Probability the model gave the chosen type, 0 to 1. */
  confidence: number;
  /** Other voting methods that also fit, most likely first. */
  alternatives: Array<{ type: PollType; label: string; percent: number }>;
  /** Plain-language list of what was filled in, for the person to check. */
  notes: string[];
}

export interface EditorValues {
  title: string;
  details: string;
  optionsText: string;
  opensAt: string;
  closesAt: string;
  inviteesText: string;
  config: PollConfig;
}

/** The new-poll editor's starting values, with a suggestion laid over them. */
export function editorValuesFor(suggestion: Suggestion, base?: Partial<EditorValues>): EditorValues {
  return {
    title: suggestion.title,
    details: "",
    optionsText: suggestion.optionsText ?? defaultOptionsText(suggestion.type),
    opensAt: "",
    closesAt: "",
    inviteesText: "",
    ...base,
    config: { ...defaultConfigFor(suggestion.type), ...suggestion.config }
  };
}

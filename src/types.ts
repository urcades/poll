export const POLL_TYPES = [
  "sense_check",
  "consent",
  "consensus",
  "majority",
  "choose",
  "approval",
  "score",
  "allocate",
  "rank",
  "irv",
  "stv",
  "time_poll"
] as const;

export type PollType = (typeof POLL_TYPES)[number];

export type PollStatus = "draft" | "open" | "closed";
export type HideResults = "off" | "after_vote" | "after_close";
export type ReasonMode = "optional" | "required" | "disabled";
export type QuotaType = "droop" | "hare";
export type StvMethod = "scottish" | "meek";
export type TimeAvailability = "available" | "if_needed" | "unavailable";

export interface PollConfig {
  anonymous: boolean;
  hideResults: HideResults;
  reasonMode: ReasonMode;
  quorumPercent: number;
  eligibleVoterCount: number;
  allowComments: boolean;
  allowReactions: boolean;
  shuffleOptions: boolean;
  minChoices?: number;
  maxChoices?: number;
  scoreMin?: number;
  scoreMax?: number;
  pointBudget?: number;
  rankCount?: number;
  seats?: number;
  stvMethod?: StvMethod;
  quotaType?: QuotaType;
  meetingDurationMinutes?: number;
}

export interface Poll {
  id: number;
  type: PollType;
  title: string;
  details: string;
  config: PollConfig;
  status: PollStatus;
  opensAt: string | null;
  closesAt: string | null;
  manuallyClosedAt: string | null;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface Option {
  id: number;
  pollId: number;
  label: string;
  meaning: string;
  sortOrder: number;
}

export interface Vote {
  id?: number;
  pollId: number;
  voterName: string;
  ballot: unknown;
  reason: string;
  updatedAt: string;
}

export interface ResultRow {
  optionId: number;
  label: string;
  meaning?: string;
  count?: number;
  points?: number;
  mean?: number;
  percent?: number;
  rank?: number;
  available?: number;
  ifNeeded?: number;
  unavailable?: number;
  firstPreferences?: number;
  finalTally?: number;
  electedRound?: number;
  surplus?: number;
  status?: string;
}

export interface RoundLog {
  round: number;
  action: string;
  tallies: Record<number, number>;
  note?: string;
}

export interface TallyResult {
  type: PollType;
  castVotes: number;
  exhaustedVotes?: number;
  quota?: number;
  quorumMet: boolean | null;
  quorumText: string;
  outcome: string;
  rows: ResultRow[];
  roundLogs?: RoundLog[];
  voteDetails?: Array<{ voterName: string; ballot: unknown; reason: string }>;
}

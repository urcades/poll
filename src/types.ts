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

/** Proposal types have fixed voting positions and a single-choice ballot. */
export const PROPOSAL_TYPES = ["sense_check", "consent", "consensus", "majority"] as const satisfies readonly PollType[];

export function isProposalType(type: PollType): boolean {
  return (PROPOSAL_TYPES as readonly PollType[]).includes(type);
}

export type PollStatus = "draft" | "open" | "closed";
export type HideResults = "off" | "after_vote" | "after_close";
export type ReasonMode = "optional" | "required" | "disabled";
export type QuotaType = "droop" | "hare";
export type StvMethod = "scottish" | "meek";
export type VoterMode = "open" | "invite";
export type TimeAvailability = "available" | "if_needed" | "unavailable";

export interface PollConfig {
  anonymous: boolean;
  /** "open": anyone with the link votes under a name they type. "invite": only named invitees, via personal links. */
  voterMode: VoterMode;
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
  /** Unguessable public id used in every URL and API path; `id` is internal. */
  slug: string;
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

/** An invited voter. The token hash and derived token never leave the server. */
export interface Invite {
  id: number;
  pollId: number;
  name: string;
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

/** Tally as sent to the browser: voter names and reasons only, never full ballots. */
export type PublicTallyResult = Omit<TallyResult, "voteDetails"> & {
  voteDetails?: Array<{ voterName: string; reason: string }>;
};

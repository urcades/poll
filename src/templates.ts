import type { PollConfig, PollType } from "./types";

export interface Template {
  type: PollType;
  label: string;
  category: "proposal" | "poll" | "election";
  description: string;
  example: string;
  resultShape: string;
  links: Array<{ label: string; href: string }>;
  defaultOptions: Array<{ label: string; meaning?: string }>;
  defaultConfig: Partial<PollConfig>;
}

export const baseConfig: PollConfig = {
  anonymous: false,
  hideResults: "off",
  reasonMode: "optional",
  quorumPercent: 0,
  eligibleVoterCount: 0,
  allowComments: false,
  allowReactions: false,
  shuffleOptions: false
};

export const templates: Template[] = [
  {
    type: "sense_check",
    label: "Sense check",
    category: "proposal",
    description: "Feedback distribution only; no pass/fail result.",
    example: "Use this when a proposal is still soft: “Should we keep exploring the Friday dinner idea?” Voters indicate whether it looks good, could be better, or needs a rethink.",
    resultShape: "You get a sentiment spread and written reasons, not a binding outcome.",
    links: [
      { label: "Loomio proposal docs", href: "https://help.loomio.com/en/user_manual/polls/proposals/index.html" },
      { label: "Consensus decision-making", href: "https://en.wikipedia.org/wiki/Consensus_decision-making" }
    ],
    defaultOptions: [
      { label: "Looks good", meaning: "I am comfortable with this direction." },
      { label: "Could be better", meaning: "I see issues or improvements." },
      { label: "Needs a rethink", meaning: "I have substantial concerns." }
    ],
    defaultConfig: {}
  },
  {
    type: "consent",
    label: "Consent",
    category: "proposal",
    description: "Passes only when there are no objections.",
    example: "Use this for a “safe enough to try” decision: “Try rotating hosts for the next month.” People consent unless they see a concrete objection.",
    resultShape: "One objection stops the proposal; no objections means it can proceed.",
    links: [
      { label: "Loomio proposal docs", href: "https://help.loomio.com/en/user_manual/polls/proposals/index.html" },
      { label: "Sociocracy", href: "https://en.wikipedia.org/wiki/Sociocracy" }
    ],
    defaultOptions: [
      { label: "Consent", meaning: "Safe enough to try." },
      { label: "Objection", meaning: "I see a reason this is not safe to try." }
    ],
    defaultConfig: {}
  },
  {
    type: "consensus",
    label: "Consensus",
    category: "proposal",
    description: "Summarizes agreement; fails when any voter blocks.",
    example: "Use this for a stronger shared commitment: “Adopt this house agreement.” Voters can agree, abstain, disagree, or block.",
    resultShape: "Blocks are treated as stop signals; other positions show the strength and texture of support.",
    links: [
      { label: "Loomio proposal docs", href: "https://help.loomio.com/en/user_manual/polls/proposals/index.html" },
      { label: "Consensus decision-making", href: "https://en.wikipedia.org/wiki/Consensus_decision-making" }
    ],
    defaultOptions: [
      { label: "Agree", meaning: "I support this proposal." },
      { label: "Abstain", meaning: "I can stand aside." },
      { label: "Disagree", meaning: "I do not support this, but I will not block it." },
      { label: "Block", meaning: "I believe this should not proceed." }
    ],
    defaultConfig: {}
  },
  {
    type: "majority",
    label: "Majority",
    category: "proposal",
    description: "Passes when Yes is at least 50% of cast votes.",
    example: "Use this for a simple yes/no call: “Should we book the 7pm reservation?” Everyone votes Yes or No.",
    resultShape: "The proposal passes when Yes is at least half of submitted votes.",
    links: [
      { label: "Loomio proposal docs", href: "https://help.loomio.com/en/user_manual/polls/proposals/index.html" },
      { label: "Majority rule", href: "https://en.wikipedia.org/wiki/Majority_rule" }
    ],
    defaultOptions: [
      { label: "Yes", meaning: "Approve." },
      { label: "No", meaning: "Do not approve." }
    ],
    defaultConfig: {}
  },
  {
    type: "choose",
    label: "Choose",
    category: "poll",
    description: "Select between a configured minimum and maximum number of options.",
    example: "Use this for picking one or several acceptable options: “Which movies would you watch?” Configure it as pick-one, pick-up-to-three, or similar.",
    resultShape: "Each selected option gets one count from that voter; totals show the most broadly acceptable choices.",
    links: [
      { label: "Loomio poll docs", href: "https://help.loomio.com/en/user_manual/polls/proposal_types/" },
      { label: "Approval voting", href: "https://en.wikipedia.org/wiki/Approval_voting" }
    ],
    defaultOptions: [
      { label: "Option A" },
      { label: "Option B" },
      { label: "Option C" }
    ],
    defaultConfig: { minChoices: 1, maxChoices: 1, shuffleOptions: false }
  },
  {
    type: "approval",
    label: "Approval",
    category: "poll",
    description: "Approve any number of options; the most-approved option leads.",
    example: "Use this when several choices could work: “Which restaurants are acceptable for Friday?” Voters approve every option they would be happy with.",
    resultShape: "Each approved option gets one count per voter; results show approval counts and approval rate by cast ballots.",
    links: [
      { label: "OpaVote methods overview", href: "https://opavote.com/methods/overview" },
      { label: "Approval voting", href: "https://en.wikipedia.org/wiki/Approval_voting" }
    ],
    defaultOptions: [
      { label: "Option A" },
      { label: "Option B" },
      { label: "Option C" }
    ],
    defaultConfig: { minChoices: 0, shuffleOptions: false }
  },
  {
    type: "score",
    label: "Score",
    category: "poll",
    description: "Score every option on a configured numeric scale.",
    example: "Use this when intensity matters: “Rate each venue from 0 to 5.” A place that many people mildly like can beat a polarizing favorite.",
    resultShape: "Options are ordered by average score, with totals and voter counts shown.",
    links: [
      { label: "Loomio poll docs", href: "https://help.loomio.com/en/user_manual/polls/proposal_types/" },
      { label: "Score voting", href: "https://en.wikipedia.org/wiki/Score_voting" }
    ],
    defaultOptions: [
      { label: "Option A" },
      { label: "Option B" },
      { label: "Option C" }
    ],
    defaultConfig: { scoreMin: 0, scoreMax: 5, shuffleOptions: false }
  },
  {
    type: "allocate",
    label: "Allocate",
    category: "poll",
    description: "Allocate a fixed budget of integer points across options.",
    example: "Use this for budgeting attention or resources: “Split 8 points across weekend plans.” Voters can put everything on one option or spread points around.",
    resultShape: "Options are ordered by total points, with share of all allocated points shown.",
    links: [
      { label: "Loomio poll docs", href: "https://help.loomio.com/en/user_manual/polls/proposal_types/" },
      { label: "Dot voting", href: "https://en.wikipedia.org/wiki/Dot-voting" }
    ],
    defaultOptions: [
      { label: "Option A" },
      { label: "Option B" },
      { label: "Option C" }
    ],
    defaultConfig: { pointBudget: 8 }
  },
  {
    type: "rank",
    label: "Rank",
    category: "poll",
    description: "Rank up to a configured number of options; results use Borda-style points.",
    example: "Use this for preference order without transfers: “Rank your top three trip ideas.” First place gets the most points, lower ranks get fewer.",
    resultShape: "The winner is the option with the most Borda-style points, not necessarily the most first-place votes.",
    links: [
      { label: "Loomio poll docs", href: "https://help.loomio.com/en/user_manual/polls/proposal_types/" },
      { label: "Borda count", href: "https://en.wikipedia.org/wiki/Borda_count" }
    ],
    defaultOptions: [
      { label: "Option A" },
      { label: "Option B" },
      { label: "Option C" }
    ],
    defaultConfig: { rankCount: 3, shuffleOptions: false }
  },
  {
    type: "irv",
    label: "IRV / Ranked-choice",
    category: "election",
    description: "Rank candidates for a single-winner instant-runoff count.",
    example: "Use this for picking one winner without spoiler effects: “Which friend should choose the next game?” Voters rank candidates, and low candidates are eliminated with ballots transferring.",
    resultShape: "The count elects one winner and shows each elimination/transfer round.",
    links: [
      { label: "OpaVote ranked-choice methods", href: "https://opavote.com/methods/instant-runoff-voting" },
      { label: "Instant-runoff voting", href: "https://en.wikipedia.org/wiki/Instant-runoff_voting" }
    ],
    defaultOptions: [
      { label: "Candidate A" },
      { label: "Candidate B" },
      { label: "Candidate C" },
      { label: "Candidate D" }
    ],
    defaultConfig: { shuffleOptions: false }
  },
  {
    type: "stv",
    label: "STV Election",
    category: "election",
    description: "Rank candidates for a multi-winner STV count.",
    example: "Use this for electing one or more people: “Choose two organizers from five candidates.” Ballots transfer when candidates are elected or eliminated.",
    resultShape: "The count produces elected candidates plus a round-by-round transfer log.",
    links: [
      { label: "Loomio STV docs", href: "https://help.loomio.com/en/user_manual/polls/stv/index.html" },
      { label: "Single transferable vote", href: "https://en.wikipedia.org/wiki/Single_transferable_vote" }
    ],
    defaultOptions: [
      { label: "Candidate A" },
      { label: "Candidate B" },
      { label: "Candidate C" },
      { label: "Candidate D" }
    ],
    defaultConfig: { seats: 1, stvMethod: "scottish", quotaType: "droop" }
  },
  {
    type: "time_poll",
    label: "Time poll",
    category: "poll",
    description: "Mark each timeslot as available, if-needed, or unavailable.",
    example: "Use this for scheduling: “When can everyone make dinner?” Each person marks every slot as available, if-needed, or unavailable.",
    resultShape: "Timeslots are ordered by availability, with if-needed counted as weaker support.",
    links: [
      { label: "Loomio meeting poll docs", href: "https://help.loomio.com/en/user_manual/polls/meeting_polls/index.html" },
      { label: "Loomio poll docs", href: "https://help.loomio.com/en/user_manual/polls/proposal_types/" }
    ],
    defaultOptions: [
      { label: "2026-06-05 10:00" },
      { label: "2026-06-05 14:00" },
      { label: "2026-06-06 10:00" }
    ],
    defaultConfig: { meetingDurationMinutes: 60 }
  }
];

export const templateByType = new Map<PollType, Template>(
  templates.map((template) => [template.type, template])
);

export function defaultConfigFor(type: PollType): PollConfig {
  return { ...baseConfig, ...(templateByType.get(type)?.defaultConfig ?? {}) };
}

export function defaultOptionsText(type: PollType): string {
  return (templateByType.get(type)?.defaultOptions ?? [])
    .map((option) => option.meaning ? `${option.label} | ${option.meaning}` : option.label)
    .join("\n");
}

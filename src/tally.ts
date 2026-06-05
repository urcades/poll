import type {
  Option,
  Poll,
  PollConfig,
  QuotaType,
  ResultRow,
  RoundLog,
  TallyResult,
  Vote
} from "./types";

const EPSILON = 1e-7;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function orderedOptions(options: Option[]): Option[] {
  return [...options].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

function rowFor(option: Option): ResultRow {
  return { optionId: option.id, label: option.label, meaning: option.meaning };
}

function rankedRows(rows: ResultRow[], score: (row: ResultRow) => number): ResultRow[] {
  return [...rows]
    .sort((a, b) => score(b) - score(a) || a.optionId - b.optionId)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function checkQuorum(config: PollConfig, castVotes: number): { quorumMet: boolean | null; quorumText: string } {
  if (!config.quorumPercent || !config.eligibleVoterCount) {
    return { quorumMet: null, quorumText: "No quorum target" };
  }
  const needed = Math.ceil(config.eligibleVoterCount * (config.quorumPercent / 100));
  return {
    quorumMet: castVotes >= needed,
    quorumText: `${castVotes}/${needed} votes for ${config.quorumPercent}% quorum`
  };
}

function selectedOptionId(ballot: unknown): number | null {
  const object = asObject(ballot);
  const id = num(object.optionId, NaN);
  return Number.isFinite(id) ? id : null;
}

function optionIndex(options: Option[]): Map<number, number> {
  return new Map(options.map((option, index) => [option.id, index]));
}

export function calculateQuota(validVotes: number, seats: number, quotaType: QuotaType): number {
  if (seats <= 0) return 0;
  return quotaType === "hare" ? validVotes / seats : Math.floor(validVotes / (seats + 1)) + 1;
}

export function validateBallot(poll: Poll, options: Option[], ballot: unknown): string | null {
  const ids = new Set(options.map((option) => option.id));
  const object = asObject(ballot);

  if (["sense_check", "consent", "consensus", "majority"].includes(poll.type)) {
    const id = selectedOptionId(ballot);
    return id && ids.has(id) ? null : "Choose one voting option.";
  }

  if (poll.type === "choose" || poll.type === "approval") {
    const selected = Array.isArray(object.selected) ? object.selected.map((value) => num(value, NaN)).filter(Number.isFinite) : [];
    const unique = new Set(selected);
    if ([...unique].some((id) => !ids.has(id))) return "Choose only valid options.";
    if (poll.type === "approval") return null;
    const min = poll.config.minChoices ?? 1;
    const max = poll.config.maxChoices ?? 1;
    if (unique.size < min || unique.size > max) return `Choose between ${min} and ${max} options.`;
    return null;
  }

  if (poll.type === "score") {
    const scores = asObject(object.scores);
    const min = poll.config.scoreMin ?? 0;
    const max = poll.config.scoreMax ?? 5;
    for (const option of options) {
      const score = num(scores[String(option.id)], NaN);
      if (!Number.isFinite(score) || score < min || score > max) return `Score every option from ${min} to ${max}.`;
    }
    return null;
  }

  if (poll.type === "allocate") {
    const allocations = asObject(object.allocations);
    const budget = poll.config.pointBudget ?? 8;
    let total = 0;
    for (const option of options) {
      const points = num(allocations[String(option.id)], 0);
      if (!Number.isInteger(points) || points < 0) return "Allocate whole-number points only.";
      total += points;
    }
    return total <= budget ? null : `Allocated points must not exceed ${budget}.`;
  }

  if (poll.type === "rank" || poll.type === "irv" || poll.type === "stv") {
    const rankings = Array.isArray(object.rankings) ? object.rankings.map((value) => num(value, NaN)).filter(Number.isFinite) : [];
    const unique = new Set(rankings);
    if (unique.size !== rankings.length) return "Rank each option at most once.";
    if ([...unique].some((id) => !ids.has(id))) return "Rank only valid options.";
    if (poll.type === "rank" && rankings.length > (poll.config.rankCount ?? options.length)) return "Too many ranked options.";
    return rankings.length > 0 ? null : "Rank at least one option.";
  }

  if (poll.type === "time_poll") {
    const availability = asObject(object.availability);
    const allowed = new Set(["available", "if_needed", "unavailable"]);
    for (const option of options) {
      if (!allowed.has(String(availability[String(option.id)]))) return "Mark availability for every timeslot.";
    }
    return null;
  }

  return "Unsupported poll type.";
}

export function tallyPoll(poll: Poll, optionsInput: Option[], votes: Vote[]): TallyResult {
  const options = orderedOptions(optionsInput);
  const castVotes = votes.length;
  const quorum = checkQuorum(poll.config, castVotes);
  let result: Omit<TallyResult, "type" | "castVotes" | "quorumMet" | "quorumText">;

  switch (poll.type) {
    case "sense_check":
    case "consent":
    case "consensus":
    case "majority":
      result = tallyProposal(poll, options, votes);
      break;
    case "choose":
      result = tallyChoose(options, votes);
      break;
    case "approval":
      result = tallyApproval(options, votes);
      break;
    case "score":
      result = tallyScore(options, votes);
      break;
    case "allocate":
      result = tallyAllocate(options, votes);
      break;
    case "rank":
      result = tallyRank(poll, options, votes);
      break;
    case "irv":
      result = tallyIrv(options, votes);
      break;
    case "stv":
      result = tallyStv(poll, options, votes);
      break;
    case "time_poll":
      result = tallyTimePoll(options, votes);
      break;
  }

  return {
    type: poll.type,
    castVotes,
    quorumMet: quorum.quorumMet,
    quorumText: quorum.quorumText,
    ...result,
    voteDetails: poll.config.anonymous
      ? undefined
      : votes.map((vote) => ({ voterName: vote.voterName, ballot: vote.ballot, reason: vote.reason }))
  };
}

function tallyProposal(poll: Poll, options: Option[], votes: Vote[]) {
  const counts = new Map(options.map((option) => [option.id, 0]));
  for (const vote of votes) {
    const id = selectedOptionId(vote.ballot);
    if (id !== null && counts.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const rows = options.map((option) => {
    const count = counts.get(option.id) ?? 0;
    return { ...rowFor(option), count, percent: votes.length ? (count / votes.length) * 100 : 0 };
  });

  const labelCount = (label: string) => rows.find((row) => row.label.toLowerCase() === label.toLowerCase())?.count ?? 0;
  let outcome = "Distribution only";
  if (poll.type === "majority") {
    const yes = labelCount("Yes");
    outcome = votes.length && yes / votes.length >= 0.5 ? "Passes: Yes is at least 50% of cast votes" : "Does not pass";
  } else if (poll.type === "consent") {
    outcome = labelCount("Objection") > 0 ? "Fails: at least one objection" : "Passes: no objections";
  } else if (poll.type === "consensus") {
    outcome = labelCount("Block") > 0 ? "Fails: at least one block" : "No blocks";
  }

  return { rows, outcome };
}

function tallyChoose(options: Option[], votes: Vote[]) {
  const counts = new Map(options.map((option) => [option.id, 0]));
  for (const vote of votes) {
    const selected = Array.isArray(asObject(vote.ballot).selected) ? asObject(vote.ballot).selected as unknown[] : [];
    for (const id of new Set(selected.map((value) => num(value, NaN)).filter(Number.isFinite))) {
      if (counts.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const rows = rankedRows(options.map((option) => ({
    ...rowFor(option),
    count: counts.get(option.id) ?? 0,
    percent: votes.length ? ((counts.get(option.id) ?? 0) / votes.length) * 100 : 0
  })), (row) => row.count ?? 0);
  return { rows, outcome: rows[0] ? `Leading: ${rows[0].label}` : "No options" };
}

function tallyApproval(options: Option[], votes: Vote[]) {
  const counts = new Map(options.map((option) => [option.id, 0]));
  for (const vote of votes) {
    const selected = Array.isArray(asObject(vote.ballot).selected) ? asObject(vote.ballot).selected as unknown[] : [];
    for (const id of new Set(selected.map((value) => num(value, NaN)).filter(Number.isFinite))) {
      if (counts.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const rows = rankedRows(options.map((option) => ({
    ...rowFor(option),
    count: counts.get(option.id) ?? 0,
    percent: votes.length ? ((counts.get(option.id) ?? 0) / votes.length) * 100 : 0
  })), (row) => row.count ?? 0);
  return { rows, outcome: rows[0] ? `Most approvals: ${rows[0].label}` : "No options" };
}

function tallyScore(options: Option[], votes: Vote[]) {
  const totals = new Map(options.map((option) => [option.id, 0]));
  const counts = new Map(options.map((option) => [option.id, 0]));
  for (const vote of votes) {
    const scores = asObject(asObject(vote.ballot).scores);
    for (const option of options) {
      const score = num(scores[String(option.id)], NaN);
      if (Number.isFinite(score)) {
        totals.set(option.id, (totals.get(option.id) ?? 0) + score);
        counts.set(option.id, (counts.get(option.id) ?? 0) + 1);
      }
    }
  }
  const rows = rankedRows(options.map((option) => {
    const points = totals.get(option.id) ?? 0;
    const count = counts.get(option.id) ?? 0;
    return { ...rowFor(option), points, count, mean: count ? points / count : 0 };
  }), (row) => row.mean ?? 0);
  return { rows, outcome: rows[0] ? `Highest mean score: ${rows[0].label}` : "No options" };
}

function tallyAllocate(options: Option[], votes: Vote[]) {
  const totals = new Map(options.map((option) => [option.id, 0]));
  const voters = new Map(options.map((option) => [option.id, 0]));
  let totalPoints = 0;
  for (const vote of votes) {
    const allocations = asObject(asObject(vote.ballot).allocations);
    for (const option of options) {
      const points = num(allocations[String(option.id)], 0);
      if (points > 0) voters.set(option.id, (voters.get(option.id) ?? 0) + 1);
      totals.set(option.id, (totals.get(option.id) ?? 0) + points);
      totalPoints += points;
    }
  }
  const rows = rankedRows(options.map((option) => {
    const points = totals.get(option.id) ?? 0;
    return {
      ...rowFor(option),
      points,
      count: voters.get(option.id) ?? 0,
      percent: totalPoints ? (points / totalPoints) * 100 : 0,
      mean: votes.length ? points / votes.length : 0
    };
  }), (row) => row.points ?? 0);
  return { rows, outcome: rows[0] ? `Most points: ${rows[0].label}` : "No options" };
}

function tallyRank(poll: Poll, options: Option[], votes: Vote[]) {
  const totals = new Map(options.map((option) => [option.id, 0]));
  const rankCount = poll.config.rankCount ?? options.length;
  for (const vote of votes) {
    const rankings = Array.isArray(asObject(vote.ballot).rankings) ? asObject(vote.ballot).rankings as unknown[] : [];
    rankings.slice(0, rankCount).forEach((value, index) => {
      const id = num(value, NaN);
      if (totals.has(id)) totals.set(id, (totals.get(id) ?? 0) + (rankCount - index));
    });
  }
  const maxPoints = votes.length * rankCount;
  const rows = rankedRows(options.map((option) => {
    const points = totals.get(option.id) ?? 0;
    return {
      ...rowFor(option),
      points,
      percent: maxPoints ? (points / maxPoints) * 100 : 0,
      mean: votes.length ? points / votes.length : 0
    };
  }), (row) => row.points ?? 0);
  return { rows, outcome: rows[0] ? `Top ranked: ${rows[0].label}` : "No options" };
}

function tallyTimePoll(options: Option[], votes: Vote[]) {
  const rows = rankedRows(options.map((option) => {
    let available = 0;
    let ifNeeded = 0;
    let unavailable = 0;
    for (const vote of votes) {
      const state = String(asObject(asObject(vote.ballot).availability)[String(option.id)] ?? "unavailable");
      if (state === "available") available += 1;
      else if (state === "if_needed") ifNeeded += 1;
      else unavailable += 1;
    }
    return {
      ...rowFor(option),
      available,
      ifNeeded,
      unavailable,
      points: available + ifNeeded * 0.5
    };
  }), (row) => row.points ?? 0);
  return { rows, outcome: rows[0] ? `Best timeslot: ${rows[0].label}` : "No timeslots" };
}

interface StvBallot {
  rankings: number[];
  weight: number;
  owner: number | null;
}

function firstPreferences(options: Option[], votes: Vote[]): Map<number, number> {
  const totals = new Map(options.map((option) => [option.id, 0]));
  for (const vote of votes) {
    const rankings = Array.isArray(asObject(vote.ballot).rankings) ? asObject(vote.ballot).rankings as unknown[] : [];
    const first = num(rankings[0], NaN);
    if (totals.has(first)) totals.set(first, (totals.get(first) ?? 0) + 1);
  }
  return totals;
}

function makeStvBallots(votes: Vote[]): StvBallot[] {
  return votes.map((vote) => ({
    rankings: (Array.isArray(asObject(vote.ballot).rankings) ? asObject(vote.ballot).rankings as unknown[] : [])
      .map((value) => num(value, NaN))
      .filter(Number.isFinite),
    weight: 1,
    owner: null
  })).filter((ballot) => ballot.rankings.length > 0);
}

function nextAvailable(ballot: StvBallot, running: Set<number>): number | null {
  return ballot.rankings.find((id) => running.has(id)) ?? null;
}

function recordTallies(options: Option[], ballots: StvBallot[], fixedTotals = new Map<number, number>()): Record<number, number> {
  const tallies: Record<number, number> = {};
  for (const option of options) tallies[option.id] = fixedTotals.get(option.id) ?? 0;
  for (const ballot of ballots) {
    if (ballot.owner !== null) tallies[ballot.owner] = (tallies[ballot.owner] ?? 0) + ballot.weight;
  }
  return tallies;
}

function tieBreakLowest(candidates: number[], history: RoundLog[], order: Map<number, number>): number {
  if (candidates.length === 1) return candidates[0]!;
  for (let i = 0; i < history.length; i += 1) {
    const tallies = history[i]!.tallies;
    const sorted = [...candidates].sort((a, b) => (tallies[a] ?? 0) - (tallies[b] ?? 0));
    const low = tallies[sorted[0]!] ?? 0;
    const high = tallies[sorted[sorted.length - 1]!] ?? 0;
    if (Math.abs(low - high) > EPSILON) return sorted[0]!;
  }
  return [...candidates].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))[0]!;
}

function tieBreakHighest(candidates: number[], history: RoundLog[], order: Map<number, number>): number {
  if (candidates.length === 1) return candidates[0]!;
  for (let i = 0; i < history.length; i += 1) {
    const tallies = history[i]!.tallies;
    const sorted = [...candidates].sort((a, b) => (tallies[b] ?? 0) - (tallies[a] ?? 0));
    const high = tallies[sorted[0]!] ?? 0;
    const low = tallies[sorted[sorted.length - 1]!] ?? 0;
    if (Math.abs(high - low) > EPSILON) return sorted[0]!;
  }
  return [...candidates].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))[0]!;
}

function tallyStv(poll: Poll, options: Option[], votes: Vote[]) {
  const seats = Math.max(1, Math.min(poll.config.seats ?? 1, options.length));
  const quotaType = poll.config.quotaType ?? "droop";
  return (poll.config.stvMethod ?? "scottish") === "meek"
    ? tallyMeekStv(poll, options, votes, seats, quotaType)
    : tallyScottishStv(poll, options, votes, seats, quotaType);
}

function tallyIrv(options: Option[], votes: Vote[]) {
  const order = optionIndex(options);
  const running = new Set(options.map((option) => option.id));
  const firstPrefs = firstPreferences(options, votes);
  const ballots = makeStvBallots(votes);
  const logs: RoundLog[] = [];
  const elected = new Map<number, { round: number; finalTally: number }>();
  const eliminated = new Set<number>();
  let exhaustedVotes = 0;
  let round = 1;

  while (running.size > 0 && round < 100) {
    const tallies = Object.fromEntries(options.map((option) => [option.id, 0]));
    exhaustedVotes = 0;
    for (const ballot of ballots) {
      const id = ballot.rankings.find((candidate) => running.has(candidate));
      if (id === undefined) {
        exhaustedVotes += 1;
      } else {
        tallies[id] = (tallies[id] ?? 0) + 1;
      }
    }

    const continuingVotes = [...running].reduce((sum, id) => sum + (tallies[id] ?? 0), 0);
    logs.push({
      round,
      action: "count",
      tallies,
      note: `${continuingVotes} continuing vote${continuingVotes === 1 ? "" : "s"}`
    });

    if (continuingVotes <= 0) break;
    const winners = [...running].filter((id) => (tallies[id] ?? 0) > continuingVotes / 2);
    if (winners.length > 0) {
      const winner = tieBreakHighest(winners, logs, order);
      elected.set(winner, { round, finalTally: tallies[winner] ?? 0 });
      logs.push({
        round,
        action: `elect ${labelFor(options, winner)}`,
        tallies,
        note: `Majority threshold ${formatNumber(continuingVotes / 2)}`
      });
      break;
    }

    if (running.size === 1) {
      const [winner] = [...running];
      if (winner !== undefined) {
        elected.set(winner, { round, finalTally: tallies[winner] ?? 0 });
        logs.push({ round, action: `elect remaining ${labelFor(options, winner)}`, tallies });
      }
      break;
    }

    const low = Math.min(...[...running].map((id) => tallies[id] ?? 0));
    const lowest = [...running].filter((id) => Math.abs((tallies[id] ?? 0) - low) < EPSILON);
    const loser = tieBreakLowest(lowest, logs, order);
    running.delete(loser);
    eliminated.add(loser);
    logs.push({ round, action: `eliminate ${labelFor(options, loser)}`, tallies });
    round += 1;
  }

  const finalTallies = logs.at(-1)?.tallies ?? {};
  const rows = options.map((option) => {
    const info = elected.get(option.id);
    return {
      ...rowFor(option),
      firstPreferences: firstPrefs.get(option.id) ?? 0,
      finalTally: finalTallies[option.id] ?? 0,
      electedRound: info?.round,
      status: info ? "elected" : eliminated.has(option.id) ? "eliminated" : "not elected"
    };
  }).sort((a, b) => {
    if (a.status !== b.status) {
      if (a.status === "elected") return -1;
      if (b.status === "elected") return 1;
    }
    return (b.finalTally ?? 0) - (a.finalTally ?? 0) || (order.get(a.optionId) ?? 0) - (order.get(b.optionId) ?? 0);
  });

  const winner = rows.find((row) => row.status === "elected");
  return {
    rows,
    roundLogs: logs,
    exhaustedVotes,
    outcome: winner ? `Elected: ${winner.label}` : "No winner"
  };
}

// Scottish STV follows Loomio's documented WIGM shape:
// quota, first preferences, elect-at-quota, fractional surplus transfer, then lowest elimination.
// Reference: https://help.loomio.com/en/user_manual/polls/stv/index.html
// Reference: https://www.votingmatters.org.uk/RES/STV-WIGM.pdf
function tallyScottishStv(poll: Poll, options: Option[], votes: Vote[], seats: number, quotaType: QuotaType) {
  const order = optionIndex(options);
  const quota = calculateQuota(votes.length, seats, quotaType);
  const running = new Set(options.map((option) => option.id));
  const elected = new Map<number, { round: number; finalTally: number; surplus: number }>();
  const fixedTotals = new Map<number, number>();
  const firstPrefs = firstPreferences(options, votes);
  const ballots = makeStvBallots(votes);
  const logs: RoundLog[] = [];

  for (const ballot of ballots) ballot.owner = nextAvailable(ballot, running);

  let round = 1;
  while (elected.size < seats && running.size > 0 && round < 100) {
    const tallies = recordTallies(options, ballots, fixedTotals);
    logs.push({ round, action: "count", tallies, note: `Quota ${formatNumber(quota)}` });
    const winners = [...running].filter((id) => (tallies[id] ?? 0) + EPSILON >= quota);

    if (winners.length > 0) {
      const winner = tieBreakHighest(winners, logs, order);
      const total = tallies[winner] ?? 0;
      const surplus = Math.max(0, total - quota);
      elected.set(winner, { round, finalTally: total, surplus });
      running.delete(winner);
      fixedTotals.set(winner, Math.min(total, quota || total));
      const transferRatio = total > 0 ? surplus / total : 0;
      for (const ballot of ballots) {
        if (ballot.owner === winner) {
          ballot.weight *= transferRatio;
          ballot.owner = transferRatio > EPSILON ? nextAvailable(ballot, running) : null;
        }
      }
      logs.push({
        round,
        action: `elect ${labelFor(options, winner)}`,
        tallies: recordTallies(options, ballots, fixedTotals),
        note: `Surplus ${formatNumber(surplus)} transferred at ${formatNumber(transferRatio)}`
      });
    } else {
      const talliedRunning = [...running].map((id) => ({ id, tally: tallies[id] ?? 0 }));
      const low = Math.min(...talliedRunning.map((entry) => entry.tally));
      const lowest = talliedRunning.filter((entry) => Math.abs(entry.tally - low) < EPSILON).map((entry) => entry.id);
      const eliminated = tieBreakLowest(lowest, logs, order);
      running.delete(eliminated);
      for (const ballot of ballots) {
        if (ballot.owner === eliminated) ballot.owner = nextAvailable(ballot, running);
      }
      logs.push({
        round,
        action: `eliminate ${labelFor(options, eliminated)}`,
        tallies: recordTallies(options, ballots, fixedTotals)
      });
    }

    if (elected.size + running.size <= seats) {
      for (const id of [...running]) {
        const tallies = recordTallies(options, ballots, fixedTotals);
        elected.set(id, { round, finalTally: tallies[id] ?? 0, surplus: Math.max(0, (tallies[id] ?? 0) - quota) });
        running.delete(id);
        logs.push({ round, action: `elect remaining ${labelFor(options, id)}`, tallies });
      }
    }
    round += 1;
  }

  const finalTallies = logs.at(-1)?.tallies ?? {};
  const rows = options.map((option) => {
    const electedInfo = elected.get(option.id);
    return {
      ...rowFor(option),
      firstPreferences: firstPrefs.get(option.id) ?? 0,
      finalTally: finalTallies[option.id] ?? fixedTotals.get(option.id) ?? 0,
      electedRound: electedInfo?.round,
      surplus: electedInfo?.surplus,
      status: electedInfo ? "elected" : "not elected"
    };
  }).sort((a, b) => {
    if (a.status !== b.status) return a.status === "elected" ? -1 : 1;
    return (a.electedRound ?? 999) - (b.electedRound ?? 999) || (b.finalTally ?? 0) - (a.finalTally ?? 0);
  });

  return {
    rows,
    roundLogs: logs,
    quota,
    exhaustedVotes: ballots.filter((ballot) => ballot.owner === null && ballot.weight > EPSILON).length,
    outcome: `Elected: ${rows.filter((row) => row.status === "elected").map((row) => row.label).join(", ") || "none"}`
  };
}

// Meek STV uses iterative keep factors for elected candidates until candidate totals settle near quota.
// This is intentionally self-contained for the v0 app, not a dependency wrapper.
// Reference: https://accuratedemocracy.com/archive/stv/meekm.htm
function distributeMeekBallot(rankings: number[], hopeful: Set<number>, elected: Set<number>, keepFactors: Map<number, number>) {
  const totals = new Map<number, number>();
  let remainder = 1;
  for (const id of rankings) {
    if (!hopeful.has(id) && !elected.has(id)) continue;
    const keep = elected.has(id) ? keepFactors.get(id) ?? 1 : 1;
    const kept = remainder * keep;
    totals.set(id, (totals.get(id) ?? 0) + kept);
    remainder -= kept;
    if (remainder <= EPSILON) break;
  }
  return totals;
}

function meekTotals(ballots: StvBallot[], options: Option[], hopeful: Set<number>, elected: Set<number>, keepFactors: Map<number, number>) {
  const totals = new Map(options.map((option) => [option.id, 0]));
  for (const ballot of ballots) {
    const distributed = distributeMeekBallot(ballot.rankings, hopeful, elected, keepFactors);
    for (const [id, value] of distributed) totals.set(id, (totals.get(id) ?? 0) + value);
  }
  return totals;
}

function tallyMeekStv(poll: Poll, options: Option[], votes: Vote[], seats: number, quotaType: QuotaType) {
  const order = optionIndex(options);
  const quota = calculateQuota(votes.length, seats, quotaType);
  const ballots = makeStvBallots(votes);
  const hopeful = new Set(options.map((option) => option.id));
  const elected = new Set<number>();
  const keepFactors = new Map(options.map((option) => [option.id, 1]));
  const electedInfo = new Map<number, { round: number; finalTally: number; surplus: number }>();
  const firstPrefs = firstPreferences(options, votes);
  const logs: RoundLog[] = [];
  let round = 1;

  while (elected.size < seats && hopeful.size > 0 && round < 100) {
    let totals = meekTotals(ballots, options, hopeful, elected, keepFactors);
    let changed = false;

    for (let iteration = 0; iteration < 200; iteration += 1) {
      const winners = [...hopeful].filter((id) => (totals.get(id) ?? 0) + EPSILON >= quota);
      if (winners.length) {
        for (const id of winners) {
          hopeful.delete(id);
          elected.add(id);
          changed = true;
        }
      }

      let maxDelta = 0;
      for (const id of elected) {
        const total = totals.get(id) ?? 0;
        if (total > quota + EPSILON) {
          const oldKeep = keepFactors.get(id) ?? 1;
          const nextKeep = oldKeep * (quota / total);
          keepFactors.set(id, nextKeep);
          maxDelta = Math.max(maxDelta, Math.abs(oldKeep - nextKeep));
        }
      }

      const nextTotals = meekTotals(ballots, options, hopeful, elected, keepFactors);
      const totalDelta = [...nextTotals].reduce((delta, [id, value]) => Math.max(delta, Math.abs(value - (totals.get(id) ?? 0))), 0);
      totals = nextTotals;
      if (maxDelta < EPSILON && totalDelta < EPSILON) break;
    }

    const tallyRecord = Object.fromEntries(options.map((option) => [option.id, totals.get(option.id) ?? 0]));
    for (const id of elected) {
      if (!electedInfo.has(id)) {
        electedInfo.set(id, { round, finalTally: totals.get(id) ?? 0, surplus: Math.max(0, (totals.get(id) ?? 0) - quota) });
      }
    }
    logs.push({ round, action: changed ? "elect by Meek quota" : "Meek count", tallies: tallyRecord, note: keepFactorNote(keepFactors, elected) });

    if (elected.size >= seats) break;
    if (elected.size + hopeful.size <= seats) {
      for (const id of hopeful) {
        elected.add(id);
        electedInfo.set(id, { round, finalTally: totals.get(id) ?? 0, surplus: Math.max(0, (totals.get(id) ?? 0) - quota) });
      }
      hopeful.clear();
      break;
    }
    if (!changed) {
      const low = Math.min(...[...hopeful].map((id) => totals.get(id) ?? 0));
      const lowest = [...hopeful].filter((id) => Math.abs((totals.get(id) ?? 0) - low) < EPSILON);
      const eliminated = tieBreakLowest(lowest, logs, order);
      hopeful.delete(eliminated);
      logs.push({ round, action: `eliminate ${labelFor(options, eliminated)}`, tallies: tallyRecord });
    }
    round += 1;
  }

  const finalTallies = logs.at(-1)?.tallies ?? {};
  const rows = options.map((option) => {
    const info = electedInfo.get(option.id);
    return {
      ...rowFor(option),
      firstPreferences: firstPrefs.get(option.id) ?? 0,
      finalTally: finalTallies[option.id] ?? 0,
      electedRound: info?.round,
      surplus: info?.surplus,
      status: info ? "elected" : "not elected"
    };
  }).sort((a, b) => {
    if (a.status !== b.status) return a.status === "elected" ? -1 : 1;
    return (a.electedRound ?? 999) - (b.electedRound ?? 999) || (b.finalTally ?? 0) - (a.finalTally ?? 0);
  });

  return {
    rows,
    roundLogs: logs,
    quota,
    outcome: `Elected: ${rows.filter((row) => row.status === "elected").map((row) => row.label).join(", ") || "none"}`
  };
}

function labelFor(options: Option[], id: number): string {
  return options.find((option) => option.id === id)?.label ?? `Option ${id}`;
}

function keepFactorNote(keepFactors: Map<number, number>, elected: Set<number>): string {
  const parts = [...elected].map((id) => `${id}:${formatNumber(keepFactors.get(id) ?? 1)}`);
  return parts.length ? `Keep factors ${parts.join(", ")}` : "No keep factors yet";
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.abs(value - Math.round(value)) < EPSILON ? String(Math.round(value)) : value.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
}

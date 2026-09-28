import { describe, expect, test } from "bun:test";
import { calculateQuota, tallyPoll, validateBallot } from "../src/tally";
import { defaultConfigFor } from "../src/templates";
import type { Option, Poll, PollType, Vote } from "../src/types";

const baseOptions: Option[] = [
  { id: 1, pollId: 1, label: "A", meaning: "", sortOrder: 0 },
  { id: 2, pollId: 1, label: "B", meaning: "", sortOrder: 1 },
  { id: 3, pollId: 1, label: "C", meaning: "", sortOrder: 2 },
  { id: 4, pollId: 1, label: "D", meaning: "", sortOrder: 3 }
];

function poll(type: PollType, config = {}): Poll {
  return {
    id: 1,
    slug: "fixture",
    type,
    title: "Fixture",
    details: "",
    config: { ...defaultConfigFor(type), ...config },
    status: "open",
    opensAt: null,
    closesAt: null,
    manuallyClosedAt: null,
    openedAt: new Date(0).toISOString(),
    closedAt: null,
    createdAt: new Date(0).toISOString()
  };
}

function vote(voterName: string, ballot: unknown): Vote {
  return { pollId: 1, voterName, ballot, reason: "", updatedAt: new Date(0).toISOString() };
}

describe("proposal tallies", () => {
  test("majority passes at yes / castVotes >= 0.5", () => {
    const result = tallyPoll(poll("majority"), [
      { ...baseOptions[0]!, label: "Yes" },
      { ...baseOptions[1]!, label: "No" }
    ], [
      vote("Ada", { optionId: 1 }),
      vote("Ben", { optionId: 2 })
    ]);
    expect(result.outcome).toContain("Passes");
  });

  test("consent fails on any objection", () => {
    const result = tallyPoll(poll("consent"), [
      { ...baseOptions[0]!, label: "Consent" },
      { ...baseOptions[1]!, label: "Objection" }
    ], [
      vote("Ada", { optionId: 1 }),
      vote("Ben", { optionId: 2 })
    ]);
    expect(result.outcome).toContain("Fails");
  });

  test("consensus fails on any block and sense check is distribution only", () => {
    const consensus = tallyPoll(poll("consensus"), [
      { ...baseOptions[0]!, label: "Agree" },
      { ...baseOptions[1]!, label: "Abstain" },
      { ...baseOptions[2]!, label: "Disagree" },
      { ...baseOptions[3]!, label: "Block" }
    ], [vote("Ada", { optionId: 4 })]);
    const sense = tallyPoll(poll("sense_check"), baseOptions.slice(0, 3), [vote("Ada", { optionId: 1 })]);
    expect(consensus.outcome).toContain("Fails");
    expect(sense.outcome).toBe("Distribution only");
  });
});

describe("poll tallies", () => {
  test("choose counts selected options", () => {
    const result = tallyPoll(poll("choose", { minChoices: 1, maxChoices: 2 }), baseOptions.slice(0, 3), [
      vote("Ada", { selected: [1, 2] }),
      vote("Ben", { selected: [2] })
    ]);
    expect(result.rows[0]!.optionId).toBe(2);
    expect(result.rows[0]!.count).toBe(2);
  });

  test("approval counts any approved options", () => {
    const result = tallyPoll(poll("approval"), baseOptions.slice(0, 3), [
      vote("Ada", { selected: [1, 2] }),
      vote("Ben", { selected: [2, 3] }),
      vote("Cam", { selected: [] })
    ]);
    expect(validateBallot(poll("approval"), baseOptions.slice(0, 3), { selected: [] })).toBeNull();
    expect(result.rows[0]!.label).toBe("B");
    expect(result.rows[0]!.count).toBe(2);
    expect(result.rows[0]!.percent).toBeCloseTo(66.666, 2);
  });

  test("score totals and averages every option", () => {
    const result = tallyPoll(poll("score", { scoreMin: 0, scoreMax: 5 }), baseOptions.slice(0, 2), [
      vote("Ada", { scores: { 1: 5, 2: 1 } }),
      vote("Ben", { scores: { 1: 3, 2: 5 } })
    ]);
    expect(result.rows[0]!.label).toBe("A");
    expect(result.rows[0]!.mean).toBe(4);
  });

  test("allocate ranks by points and validates budget", () => {
    const p = poll("allocate", { pointBudget: 4 });
    const invalid = validateBallot(p, baseOptions.slice(0, 2), { allocations: { 1: 3, 2: 2 } });
    const result = tallyPoll(p, baseOptions.slice(0, 2), [
      vote("Ada", { allocations: { 1: 3, 2: 1 } }),
      vote("Ben", { allocations: { 1: 0, 2: 4 } })
    ]);
    expect(invalid).toContain("must not exceed");
    expect(result.rows[0]!.label).toBe("B");
  });

  test("rank applies Borda-style points", () => {
    const result = tallyPoll(poll("rank", { rankCount: 3 }), baseOptions.slice(0, 3), [
      vote("Ada", { rankings: [1, 2, 3] }),
      vote("Ben", { rankings: [2, 3, 1] })
    ]);
    expect(result.rows[0]!.label).toBe("B");
    expect(result.rows[0]!.points).toBe(5);
  });

  test("time poll scores available above if-needed", () => {
    const result = tallyPoll(poll("time_poll"), baseOptions.slice(0, 2), [
      vote("Ada", { availability: { 1: "available", 2: "if_needed" } }),
      vote("Ben", { availability: { 1: "unavailable", 2: "available" } })
    ]);
    expect(result.rows[0]!.label).toBe("B");
  });
});

describe("STV", () => {
  test("calculates Droop and Hare quotas", () => {
    expect(calculateQuota(100, 4, "droop")).toBe(21);
    expect(calculateQuota(100, 4, "hare")).toBe(25);
  });

  test("Scottish STV transfers surplus", () => {
    const result = tallyPoll(poll("stv", { seats: 2, stvMethod: "scottish", quotaType: "droop" }), baseOptions.slice(0, 3), [
      vote("a1", { rankings: [1, 2] }),
      vote("a2", { rankings: [1, 2] }),
      vote("a3", { rankings: [1, 2] }),
      vote("a4", { rankings: [1, 2] }),
      vote("b1", { rankings: [2, 1] }),
      vote("b2", { rankings: [2, 1] }),
      vote("c1", { rankings: [3, 2] })
    ]);
    expect(result.quota).toBe(3);
    expect(result.rows.filter((row) => row.status === "elected").map((row) => row.label)).toEqual(["A", "B"]);
    expect(result.roundLogs?.some((log) => log.action.includes("elect A") && log.note?.includes("Surplus"))).toBe(true);
  });

  test("Meek STV converges with keep-factor logs", () => {
    const result = tallyPoll(poll("stv", { seats: 2, stvMethod: "meek", quotaType: "hare" }), baseOptions.slice(0, 3), [
      vote("a1", { rankings: [1, 2] }),
      vote("a2", { rankings: [1, 2] }),
      vote("a3", { rankings: [1, 3] }),
      vote("b1", { rankings: [2, 1] }),
      vote("b2", { rankings: [2, 3] }),
      vote("c1", { rankings: [3, 2] })
    ]);
    expect(result.quota).toBe(3);
    expect(result.rows.filter((row) => row.status === "elected")).toHaveLength(2);
    expect(result.roundLogs?.some((log) => log.note?.includes("Keep factors"))).toBe(true);
  });

  test("tie breaks deterministically by option order when no prior unequal round exists", () => {
    const result = tallyPoll(poll("stv", { seats: 1, stvMethod: "scottish", quotaType: "droop" }), baseOptions.slice(0, 2), [
      vote("Ada", { rankings: [1] }),
      vote("Ben", { rankings: [2] })
    ]);
    expect(result.roundLogs?.some((log) => log.action.includes("eliminate A"))).toBe(true);
    expect(result.rows.find((row) => row.status === "elected")?.label).toBe("B");
  });

  test("exhausted ballots are tracked when rankings run out", () => {
    const result = tallyPoll(poll("stv", { seats: 1, stvMethod: "scottish", quotaType: "droop" }), baseOptions.slice(0, 3), [
      vote("Ada", { rankings: [1] }),
      vote("Ben", { rankings: [2, 3] }),
      vote("Cam", { rankings: [3, 2] })
    ]);
    expect(result.exhaustedVotes).toBeGreaterThan(0);
  });
});

describe("IRV", () => {
  test("elects a first-round majority winner", () => {
    const result = tallyPoll(poll("irv"), baseOptions.slice(0, 3), [
      vote("Ada", { rankings: [1, 2, 3] }),
      vote("Ben", { rankings: [1, 3, 2] }),
      vote("Cam", { rankings: [2, 1, 3] })
    ]);
    expect(result.outcome).toBe("Elected: A");
    expect(result.roundLogs?.some((log) => log.action.includes("elect A"))).toBe(true);
  });

  test("eliminates and transfers until a candidate has a majority", () => {
    const result = tallyPoll(poll("irv"), baseOptions.slice(0, 3), [
      vote("a", { rankings: [1, 2] }),
      vote("b1", { rankings: [2, 1, 3] }),
      vote("b2", { rankings: [2, 1, 3] }),
      vote("c1", { rankings: [3, 1, 2] }),
      vote("c2", { rankings: [3, 1, 2] })
    ]);
    expect(result.roundLogs?.some((log) => log.action.includes("eliminate A"))).toBe(true);
    expect(result.rows.find((row) => row.status === "elected")?.label).toBe("B");
  });

  test("tracks exhausted ballots and breaks ties by option order", () => {
    const result = tallyPoll(poll("irv"), baseOptions.slice(0, 3), [
      vote("Ada", { rankings: [1] }),
      vote("Ben", { rankings: [2] }),
      vote("Cam", { rankings: [3, 2] })
    ]);
    expect(result.roundLogs?.some((log) => log.action.includes("eliminate A"))).toBe(true);
    expect(result.exhaustedVotes).toBeGreaterThan(0);
  });
});

function namedOptions(labels: string[]): Option[] {
  return labels.map((label, index) => ({ id: index + 1, pollId: 1, label, meaning: "", sortOrder: index }));
}

function repeat(count: number, prefix: string, rankings: number[]): Vote[] {
  return Array.from({ length: count }, (_, i) => vote(`${prefix}${i}`, { rankings }));
}

describe("Scottish STV simultaneous quotas", () => {
  // 10 voters, 3 seats, Droop quota floor(10/4)+1 = 3.
  // A=5 and B=3 both reach quota in round 1. A's surplus is 2 (ratio 2/5); every A ballot ranks B second,
  // but B is already elected, so the transfer skips to C: C = 1 + 5*0.4 = 3 and is elected in round 2.
  test("elects every candidate at quota together and never transfers to them", () => {
    const options = namedOptions(["A", "B", "C", "D"]);
    const result = tallyPoll(poll("stv", { seats: 3, stvMethod: "scottish", quotaType: "droop" }), options, [
      ...repeat(5, "a", [1, 2, 3]),
      ...repeat(3, "b", [2]),
      ...repeat(1, "c", [3]),
      ...repeat(1, "d", [4])
    ]);
    expect(result.quota).toBe(3);
    const rows = result.rows.filter((row) => row.status === "elected");
    expect(rows.map((row) => [row.label, row.electedRound])).toEqual([["A", 1], ["B", 1], ["C", 2]]);
    const electA = result.roundLogs!.find((log) => log.action === "elect A")!;
    expect(electA.round).toBe(1);
    expect(electA.tallies[2]).toBe(3);
    expect(electA.tallies[3]).toBeCloseTo(3, 9);
    expect(electA.tallies[4]).toBe(1);
    expect(result.roundLogs!.find((log) => log.action === "elect B")!.tallies[2]).toBe(3);
    for (const row of rows) expect(row.finalTally).toBeCloseTo(3, 9);
    expect(rows.find((row) => row.label === "A")!.surplus).toBe(2);
    expect(rows.find((row) => row.label === "B")!.surplus).toBe(0);
  });
});

describe("reference examples", () => {
  // Wikipedia STV "food election": 20 voters, 3 seats, Droop quota 6.
  const food = namedOptions(["Oranges", "Pears", "Chocolate", "Strawberries", "Hamburgers"]);
  const foodVotes = [
    ...repeat(4, "o", [1, 2]),
    ...repeat(2, "p", [2, 1]),
    ...repeat(8, "cs", [3, 4]),
    ...repeat(4, "ch", [3, 5]),
    ...repeat(1, "s", [4]),
    ...repeat(1, "h", [5])
  ];

  test("Scottish STV: food election elects Chocolate, Oranges, Strawberries", () => {
    // R1: O4 P2 C12 S1 H1. Chocolate elected, surplus 6 (ratio 1/2): S = 1+8*.5 = 5, H = 1+4*.5 = 3.
    // R2: nobody at 6; Pears (2) eliminated -> both ballots go to Oranges: O = 6.
    // R3: Oranges elected exactly at quota. R4: Hamburgers (3) eliminated, Strawberries (5) remain -> elected.
    const result = tallyPoll(poll("stv", { seats: 3, stvMethod: "scottish", quotaType: "droop" }), food, foodVotes);
    expect(result.quota).toBe(6);
    const elected = result.rows.filter((row) => row.status === "elected");
    expect(elected.map((row) => row.label)).toEqual(["Chocolate", "Oranges", "Strawberries"]);
    expect(elected.map((row) => row.electedRound)).toEqual([1, 3, 4]);
    expect(elected[0]!.surplus).toBe(6);
    expect(elected[0]!.finalTally).toBe(6);
    expect(elected[1]!.finalTally).toBe(6);
    const round2 = result.roundLogs!.find((log) => log.round === 2 && log.action === "count")!;
    expect(round2.tallies).toEqual({ 1: 4, 2: 2, 3: 6, 4: 5, 5: 3 });
    expect(result.roundLogs!.some((log) => log.action === "eliminate Pears")).toBe(true);
    expect(result.roundLogs!.some((log) => log.action === "eliminate Hamburgers")).toBe(true);
  });

  test("Meek STV: food election elects the same winners", () => {
    // Chocolate keep factor converges to 6/12 = 0.5; the rest of the count matches the Scottish trace.
    const result = tallyPoll(poll("stv", { seats: 3, stvMethod: "meek", quotaType: "droop" }), food, foodVotes);
    expect(result.quota).toBe(6);
    expect(result.rows.filter((row) => row.status === "elected").map((row) => row.label)).toEqual(["Chocolate", "Oranges", "Strawberries"]);
    const note = result.roundLogs!.map((log) => log.note ?? "").find((n) => n.includes("Chocolate:0.5"));
    expect(note).toBeDefined();
    expect(note).not.toMatch(/\b3:0\.5/);
  });

  test("IRV: multiple eliminations, exhausted ballots, exact tallies", () => {
    // 14 ballots: A5 [A,B]; B4 [B,C]; C: 2 [C,B] + 1 [C]; D2 [D].
    // R1 A5 B4 C3 D2 (no majority of 14) -> eliminate D, 2 ballots exhausted.
    // R2 A5 B4 C3, 12 continuing (need >6) -> eliminate C: 2 go to B, 1 [C] exhausted.
    // R3 A5 B6, 11 continuing (need >5.5) -> B elected, 3 exhausted.
    const options = namedOptions(["A", "B", "C", "D"]);
    const result = tallyPoll(poll("irv"), options, [
      ...repeat(5, "a", [1, 2]),
      ...repeat(4, "b", [2, 3]),
      ...repeat(2, "c", [3, 2]),
      ...repeat(1, "cx", [3]),
      ...repeat(2, "d", [4])
    ]);
    expect(result.outcome).toBe("Elected: B");
    expect(result.exhaustedVotes).toBe(3);
    const counts = result.roundLogs!.filter((log) => log.action === "count");
    expect(counts.map((log) => log.tallies)).toEqual([
      { 1: 5, 2: 4, 3: 3, 4: 2 },
      { 1: 5, 2: 4, 3: 3, 4: 0 },
      { 1: 5, 2: 6, 3: 0, 4: 0 }
    ]);
    expect(result.roundLogs!.filter((log) => log.action.startsWith("eliminate")).map((log) => log.action)).toEqual(["eliminate D", "eliminate C"]);
    const byLabel = Object.fromEntries(result.rows.map((row) => [row.label, row]));
    expect(byLabel.B!.finalTally).toBe(6);
    expect(byLabel.A!.finalTally).toBe(5);
    expect(byLabel.B!.electedRound).toBe(3);
    expect(byLabel.A!.firstPreferences).toBe(5);
  });

  test("IRV with 30 candidates completes with a single winner", () => {
    const options = namedOptions(Array.from({ length: 30 }, (_, i) => `C${i + 1}`));
    const votes = Array.from({ length: 30 }, (_, i) =>
      vote(`v${i}`, { rankings: Array.from({ length: 30 }, (_, j) => ((i + j) % 30) + 1) })
    );
    const result = tallyPoll(poll("irv"), options, votes);
    expect(result.rows.filter((row) => row.status === "elected")).toHaveLength(1);
    expect(result.roundLogs!.some((log) => log.action.startsWith("elect"))).toBe(true);
  });

  test("IRV with 100 candidates is not cut off by the round cap", () => {
    const options = namedOptions(Array.from({ length: 100 }, (_, i) => `C${i + 1}`));
    const votes = Array.from({ length: 100 }, (_, i) => vote(`v${i}`, { rankings: [i + 1] }));
    const result = tallyPoll(poll("irv"), options, votes);
    expect(result.outcome).toBe("Elected: C100");
  });
});

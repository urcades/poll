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

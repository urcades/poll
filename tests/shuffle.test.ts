import { describe, expect, test } from "bun:test";
import { hashSeed, mulberry32, seededShuffle } from "../src/lib/shuffle";
import { resultBars, roundStages } from "../src/lib/shared";
import { tallyPoll } from "../src/tally";
import { defaultConfigFor } from "../src/templates";
import type { Option, Poll, Vote } from "../src/types";

describe("seededShuffle", () => {
  const items = Array.from({ length: 12 }, (_, index) => index + 1);

  test("is deterministic for the same seed", () => {
    expect(seededShuffle(items, "abc:seed")).toEqual(seededShuffle(items, "abc:seed"));
    expect(hashSeed("x")).toBe(hashSeed("x"));
    const a = mulberry32(5);
    const b = mulberry32(5);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  test("is a permutation and does not mutate its input", () => {
    for (const seed of ["a", "b", "c", "d", "e"]) {
      const shuffled = seededShuffle(items, seed);
      expect([...shuffled].sort((x, y) => x - y)).toEqual(items);
    }
    const copy = [...items];
    seededShuffle(items, "z");
    expect(items).toEqual(copy);
    expect(seededShuffle([], "s")).toEqual([]);
    expect(seededShuffle([1], "s")).toEqual([1]);
  });

  test("different seeds give different orders", () => {
    const orders = new Set(["a", "b", "c", "d", "e", "f"].map((seed) => seededShuffle(items, seed).join(",")));
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("chart helpers", () => {
  const options: Option[] = ["A", "B", "C"].map((label, index) => ({ id: index + 1, pollId: 1, label, meaning: "", sortOrder: index }));
  const poll = (type: Poll["type"]): Poll => ({ id: 1, slug: "s", type, title: "t", details: "", config: defaultConfigFor(type), status: "open", opensAt: null, closesAt: null, manuallyClosedAt: null, openedAt: null, closedAt: null, createdAt: "" });
  const vote = (rankings: number[]): Vote => ({ pollId: 1, voterName: "v", ballot: { rankings }, reason: "", updatedAt: "" });

  test("IRV round stages mark eliminations and the winner", () => {
    const votes = [vote([1, 2, 3]), vote([1, 3, 2]), vote([2, 3, 1]), vote([3, 2, 1]), vote([3, 2, 1])];
    const p = poll("irv");
    const tally = tallyPoll(p, options, votes);
    const stages = roundStages(tally);
    expect(stages.length).toBeGreaterThan(1);
    expect(stages[0]!.bars).toHaveLength(3);
    expect(stages.flatMap((stage) => stage.bars).some((bar) => bar.mark === "eliminated")).toBe(true);
    expect(stages.at(-1)!.bars.some((bar) => bar.mark === "elected")).toBe(true);
    expect(stages[0]!.threshold).toBe(2.5);
  });

  test("bars stay within 0-100 and time polls stack to 100", () => {
    const tally = tallyPoll(poll("irv"), options, [vote([1, 2]), vote([2, 1])]);
    for (const bar of resultBars(tally, poll("irv"))) for (const segment of bar.segments) expect(segment.percent).toBeLessThanOrEqual(100);
    const timePoll = tallyPoll(poll("time_poll"), options, [{ pollId: 1, voterName: "v", ballot: { availability: { 1: "available", 2: "if_needed", 3: "unavailable" } }, reason: "", updatedAt: "" }]);
    for (const bar of resultBars(timePoll, poll("time_poll"))) expect(bar.segments.reduce((sum, segment) => sum + segment.percent, 0)).toBeCloseTo(100);
  });
});

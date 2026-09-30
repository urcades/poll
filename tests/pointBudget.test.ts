import { describe, expect, test } from "bun:test";
import { pointsLeftText, pointsState } from "../src/lib/pointBudget";

describe("point budget counter", () => {
  test("reads as points left, all spent, or over", () => {
    expect(pointsLeftText(7, 10)).toBe("7 of 10 points left");
    expect(pointsLeftText(1, 1)).toBe("1 of 1 point left");
    expect(pointsLeftText(0, 10)).toBe("All 10 points spent");
    expect(pointsLeftText(-3, 10)).toBe("3 over: 10 is the most you can spend");
  });

  test("state follows what's left", () => {
    expect(pointsState(2)).toBe("open");
    expect(pointsState(0)).toBe("spent");
    expect(pointsState(-1)).toBe("over");
  });
});

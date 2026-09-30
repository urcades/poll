import { describe, expect, test } from "bun:test";
import { LIMITS } from "../src/lib/server/app";
import { optionPattern, PATTERN_FAMILY_COUNT, patternFamily } from "../src/lib/patterns";

describe("option patterns", () => {
  test("are deterministic per seed", () => {
    for (const seed of [0, 1, 7, 42, 999]) expect(optionPattern(seed)).toBe(optionPattern(seed));
  });

  test("consecutive seeds never share a family", () => {
    for (let seed = 0; seed < 100; seed += 1) {
      expect(patternFamily(seed)).not.toBe(patternFamily(seed + 1));
    }
  });

  test("every option a poll can hold gets its own texture", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < LIMITS.optionCount; seed += 1) seen.add(optionPattern(seed));
    expect(seen.size).toBe(LIMITS.optionCount);
  });

  test("every family appears within one cycle", () => {
    const families = new Set(Array.from({ length: PATTERN_FAMILY_COUNT }, (_, seed) => patternFamily(seed)));
    expect(families.size).toBe(PATTERN_FAMILY_COUNT);
  });

  test("emit a CSS url with an encoded SVG and no raw markup characters", () => {
    for (let seed = 0; seed < PATTERN_FAMILY_COUNT * 3; seed += 1) {
      const css = optionPattern(seed);
      expect(css.startsWith(`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'`)).toBe(true);
      expect(css.endsWith(`%3C/svg%3E")`)).toBe(true);
      const payload = css.slice(5, -2);
      expect(payload).not.toMatch(/[<>#"]/);
      expect(payload).not.toContain("NaN");
      expect(payload).not.toContain("undefined");
    }
  });
});

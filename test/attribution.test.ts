import { describe, it, expect } from "vitest";
import { allocate, apportion, isSelfCitation, type ScoredSource } from "../src/attribution.js";

const src = (n: number, score: number, domain = `d${n}.com`, flagged = false): ScoredSource => ({ n, score, justification: "x", domain, flagged });
const opts = { feeCents: 50, minScore: 0.15, injectionPenalty: 0.5 };

describe("apportion", () => {
  it("sums exactly to the total (largest remainder)", () => {
    for (const total of [1, 25, 50, 99, 100]) {
      const w = [0.9, 0.7, 0.3, 0.25, 0.5];
      const out = apportion(w, total);
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
      expect(out.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    }
  });
  it("handles degenerate inputs", () => {
    expect(apportion([0, 0], 50)).toEqual([0, 0]);
    expect(apportion([1], 0)).toEqual([0]);
  });
});

describe("allocate", () => {
  it("normalizes kept sources to 100% and exact cents", () => {
    const r = allocate([src(1, 0.8), src(2, 0.4), src(3, 0.4)], opts);
    expect(r.reduce((a, x) => a + x.shareCents, 0)).toBe(50);
    expect(r.reduce((a, x) => a + x.sharePct, 0)).toBeCloseTo(100, 0);
    expect(r[0].shareCents).toBe(25);
  });
  it("drops sources under the threshold and re-normalizes the rest", () => {
    const r = allocate([src(1, 0.9), src(2, 0.05), src(3, 0.9)], opts);
    expect(r[1].dropped).toBe(true);
    expect(r[1].dropReason).toMatch(/background/);
    expect(r[1].shareCents).toBe(0);
    expect(r[0].shareCents + r[2].shareCents).toBe(50);
    expect(r[0].shareCents).toBe(25);
  });
  it("penalizes flagged (prompt-injection) sources", () => {
    const r = allocate([src(1, 0.6), src(2, 0.6, "evil.com", true)], opts);
    expect(r[1].adjustedScore).toBeCloseTo(0.3);
    expect(r[1].shareCents).toBeLessThan(r[0].shareCents);
  });
  it("drops a flagged source whose penalized score falls under the threshold", () => {
    const r = allocate([src(1, 0.6), src(2, 0.25, "evil.com", true)], opts);
    expect(r[1].dropped).toBe(true);
    expect(r[1].dropReason).toMatch(/injection penalty/);
    expect(r[0].shareCents).toBe(50);
  });
  it("ignores self-citation of the asker's own domain", () => {
    const r = allocate([src(1, 0.9, "me.com"), src(2, 0.9, "blog.me.com"), src(3, 0.9, "other.com")], { ...opts, ownDomain: "https://www.me.com/about" });
    expect(r[0].dropped && r[1].dropped).toBe(true);
    expect(r[2].shareCents).toBe(50);
    expect(isSelfCitation("notme.com", "me.com")).toBe(false);
  });
  it("returns everything dropped when no source qualifies", () => {
    const r = allocate([src(1, 0.01), src(2, 0.02)], opts);
    expect(r.every((x) => x.dropped)).toBe(true);
  });
  it("clamps garbage scores", () => {
    const r = allocate([src(1, 7), src(2, NaN), src(3, -3)], opts);
    expect(r[0].adjustedScore).toBe(1);
    expect(r[1].dropped && r[2].dropped).toBe(true);
  });
  it("drops sources that would earn under one cent", () => {
    const r = allocate([src(1, 1), src(2, 0.2)], { ...opts, feeCents: 4 });
    expect(r.reduce((a, x) => a + x.shareCents, 0)).toBe(4);
    expect(r.filter((x) => !x.dropped).every((x) => x.shareCents >= 1)).toBe(true);
  });
});

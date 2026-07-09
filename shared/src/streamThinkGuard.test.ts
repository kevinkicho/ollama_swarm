import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkThinkStream,
  createThinkGuardSession,
  createThinkStreamGuard,
  detectRepetitiveTail,
  THINK_STREAM_SOFT_MAX_CHARS,
} from "./streamThinkGuard.js";

describe("detectRepetitiveTail", () => {
  it("detects repeated tail segments", () => {
    const chunk = "a plan for experimental protocols? (3501) ";
    const text = chunk.repeat(12);
    const rep = detectRepetitiveTail(text);
    assert.ok(rep);
    assert.ok(rep.repeats >= 5);
  });
});

describe("createThinkStreamGuard", () => {
  it("trips on think-only char cap", () => {
    const guard = createThinkStreamGuard();
    const big = `<think>${"x".repeat(170_000)}</think>`;
    assert.match(guard.check(big) ?? "", /exceeded/);
  });

  it("allows streams with visible output", () => {
    const guard = createThinkStreamGuard();
    assert.equal(guard.check("<think>lots</think>{\"ok\":true}"), null);
  });
});

function nonRepeatingThink(chars: number): string {
  const parts: string[] = [];
  let len = 0;
  for (let i = 0; len < chars; i++) {
    const piece = `step-${i}-${(i * 7919) % 1_000_003} `;
    parts.push(piece);
    len += piece.length;
  }
  return `<think>${parts.join("").slice(0, chars)}</think>`;
}

describe("checkThinkStream", () => {
  it("refereeOn=false does not trip below hard char cap (130k regression)", () => {
    const session = createThinkGuardSession();
    const raw = nonRepeatingThink(130_000);
    assert.equal(checkThinkStream(raw, session, { refereeOn: false }), null);
  });

  it("refereeOn=true trips at soft char cap when think is long enough", () => {
    const session = createThinkGuardSession();
    const raw = nonRepeatingThink(THINK_STREAM_SOFT_MAX_CHARS + 1_000);
    const trip = checkThinkStream(raw, session, { refereeOn: true, minThinkCharsForReferee: 30_000 });
    assert.ok(trip);
    assert.equal(trip!.tier, 1);
    assert.match(trip!.reason, /soft/i);
  });

  it("refereeOn=true suppresses soft tier when think is short and non-repetitive", () => {
    const session = createThinkGuardSession();
    const raw = nonRepeatingThink(50_000);
    const trip = checkThinkStream(raw, session, { refereeOn: true, minThinkCharsForReferee: 200_000 });
    assert.equal(trip, null);
  });

  it("refereeOn=true trips soft tier for large think block with visible tool output (mixed stream)", () => {
    const session = createThinkGuardSession();
    const think = nonRepeatingThink(THINK_STREAM_SOFT_MAX_CHARS + 500);
    const raw = `${think}\n\n[tool:grep] scanned src/\n{"draft": true}`;
    const trip = checkThinkStream(raw, session, { refereeOn: true, minThinkCharsForReferee: 30_000 });
    assert.ok(trip);
    assert.equal(trip!.tier, 1);
    assert.match(trip!.reason, /mixed stream/i);
  });
});
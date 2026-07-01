// 2026-05-02 (deliverables initiative): tests for the shared
// deliverable helper. Pure markdown builder + on-disk roundtrip
// against a temp directory.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDeliverableMarkdown,
  writeDeliverable,
  writeDeliverableAndEmit,
} from "./deliverable.js";
import type { SwarmEvent, TranscriptEntry } from "../types.js";

describe("buildDeliverableMarkdown — pure", () => {
  it("renders H1 + subtitle + sections in order", () => {
    const md = buildDeliverableMarkdown({
      preset: "council",
      runId: "abc12345-rest",
      clonePath: "/tmp/anything",
      title: "Council synthesis",
      subtitle: "3 drafters across 2 rounds",
      sections: [
        { title: "Final synthesis", body: "we agreed on X" },
        { title: "Round 1 drafts", body: "Agent 1: ...\n\nAgent 2: ..." },
      ],
    });
    assert.match(md, /^# Council synthesis/);
    assert.match(md, /_3 drafters across 2 rounds_/);
    assert.match(md, /## Final synthesis/);
    assert.match(md, /## Round 1 drafts/);
    // Order matters
    assert.ok(md.indexOf("Final synthesis") < md.indexOf("Round 1 drafts"));
  });

  it("auto-emits a Contents TOC when 3+ sections exist", () => {
    const md = buildDeliverableMarkdown({
      preset: "moa",
      runId: "r1",
      clonePath: "/tmp/x",
      title: "MoA synthesis",
      sections: [
        { title: "First", body: "a" },
        { title: "Second", body: "b" },
        { title: "Third", body: "c" },
      ],
    });
    assert.match(md, /## Contents/);
    assert.match(md, /\[First\]\(#first\)/);
    assert.match(md, /\[Second\]\(#second\)/);
    assert.match(md, /\[Third\]\(#third\)/);
  });

  it("OMITS the Contents TOC when fewer than 3 sections", () => {
    const md = buildDeliverableMarkdown({
      preset: "moa",
      runId: "r1",
      clonePath: "/tmp/x",
      title: "Small",
      sections: [
        { title: "Only", body: "a" },
        { title: "Two", body: "b" },
      ],
    });
    assert.doesNotMatch(md, /## Contents/);
  });

  it("renders empty body sections as '(no content)' placeholder", () => {
    const md = buildDeliverableMarkdown({
      preset: "p",
      runId: "r",
      clonePath: "/tmp/x",
      title: "T",
      sections: [{ title: "Empty", body: "   " }],
    });
    assert.match(md, /## Empty\n\n_\(no content\)_/);
  });

  it("includes preset + runId in the metadata line", () => {
    const md = buildDeliverableMarkdown({
      preset: "stigmergy",
      runId: "abcdef-rest",
      clonePath: "/tmp/x",
      title: "T",
      sections: [{ title: "S", body: "body" }],
    });
    assert.match(md, /preset: \*\*stigmergy\*\*/);
    assert.match(md, /run abcdef-rest/);
  });

  it("anchor slugs handle special characters + spaces correctly", () => {
    const md = buildDeliverableMarkdown({
      preset: "p",
      runId: "r",
      clonePath: "/tmp/x",
      title: "T",
      sections: [
        { title: "Round 1 — drafts (peer-hidden)", body: "x" },
        { title: "Final synthesis!", body: "y" },
        { title: "Section 3", body: "z" },
      ],
    });
    // Em-dash + parens stripped; spaces → hyphens.
    assert.match(md, /\[Round 1 — drafts \(peer-hidden\)\]\(#round-1-drafts-peer-hidden\)/);
    // Bang stripped.
    assert.match(md, /\[Final synthesis!\]\(#final-synthesis\)/);
  });
});

describe("writeDeliverable — on-disk roundtrip", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "deliverable-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("writes a markdown file at <clonePath>/deliverable-<preset>-<runIdPrefix>-<iso>.md", () => {
    const result = writeDeliverable({
      preset: "council",
      runId: "12345678-abcd-efgh-ijkl-mnopqrstuvwx",
      clonePath: workdir,
      title: "Test",
      sections: [{ title: "Body", body: "hello" }],
    });
    assert.equal(result.ok, true);
    assert.match(result.filename, /^deliverable-council-12345678-/);
    assert.ok(result.filename.endsWith(".md"));
    assert.ok(existsSync(result.fullPath));
    const content = readFileSync(result.fullPath, "utf8");
    assert.match(content, /# Test/);
    assert.match(content, /## Body/);
    assert.match(content, /hello/);
    assert.equal(result.bytes, content.length);
  });

  it("uses atomic write (tmp + rename) — no .tmp file lingers", () => {
    const result = writeDeliverable({
      preset: "moa",
      runId: "r",
      clonePath: workdir,
      title: "T",
      sections: [{ title: "S", body: "b" }],
    });
    assert.equal(result.ok, true);
    // Check for .tmp files in the deliverable directory
    const deliverableDir = join(workdir, "logs", "r", "deliverable");
    const entries = readdirSync(deliverableDir);
    assert.ok(!entries.some((f) => f.endsWith(".tmp")), "no .tmp file should remain");
    assert.ok(entries.some((f) => f === result.filename), "final file must be present");
  });

  it("never throws on filesystem failure — returns ok:false with reason", () => {
    const result = writeDeliverable({
      preset: "p",
      runId: "r",
      clonePath: "\0invalid-path",
      title: "T",
      sections: [{ title: "S", body: "b" }],
    });
    assert.equal(result.ok, false);
    assert.ok(typeof result.reason === "string" && result.reason.length > 0);
  });

  it("(T3.1) appends a memory entry to .swarm-memory.jsonl with extracted actions as lessons", async () => {
    const result = writeDeliverable({
      preset: "council",
      runId: "12345678-mem-test",
      clonePath: workdir,
      title: "Council deliverable",
      sections: [
        { title: "Answer to directive", body: "Team converged on X." },
        {
          title: "Next actions",
          body: "**HIGH priority:**\n- Add coverage for src/api/users.ts\n- Fix race in worker pool",
        },
      ],
    });
    assert.equal(result.ok, true);
    // appendMemoryEntry is fire-and-forget (async). Give it a tick to land.
    await new Promise((r) => setTimeout(r, 100));
    const memPath = join(workdir, ".swarm-memory.jsonl");
    assert.ok(existsSync(memPath), ".swarm-memory.jsonl must be created");
    const lines = readFileSync(memPath, "utf8").trim().split("\n");
    assert.ok(lines.length >= 1);
    const entry = JSON.parse(lines[lines.length - 1]!);
    assert.equal(entry.runId, "12345678-mem-test");
    assert.equal(entry.tier, 0);
    assert.equal(entry.commits, 0);
    assert.ok(Array.isArray(entry.lessons));
    assert.ok(entry.lessons.length >= 2);
    // Each lesson is preset-tagged so subsequent planner seeds know
    // which kind of run produced them.
    assert.ok(entry.lessons.every((l: string) => l.startsWith("[council]")));
  });

  it("(T3.1) skips memory append when no next-actions extractable (degenerate run)", async () => {
    const result = writeDeliverable({
      preset: "moa",
      runId: "no-actions-runId",
      clonePath: workdir,
      title: "Empty run",
      sections: [{ title: "Body", body: "no recognizable actions here" }],
    });
    assert.equal(result.ok, true);
    await new Promise((r) => setTimeout(r, 100));
    const memPath = join(workdir, ".swarm-memory.jsonl");
    // The earlier T3.1 test in this describe block may have created the
    // file; check that THIS specific runId didn't add an entry.
    if (existsSync(memPath)) {
      const lines = readFileSync(memPath, "utf8").trim().split("\n").filter((l) => l.length > 0);
      const entries = lines.map((l) => JSON.parse(l));
      assert.ok(
        !entries.some((e) => e.runId === "no-actions-runId"),
        "no entry should be written for the no-actions runId",
      );
    }
  });

  it("(T1.3) writes sibling next-actions-<preset>-<runIdPrefix>-<iso>.json with extracted actions", () => {
    const result = writeDeliverable({
      preset: "council",
      runId: "12345678-abcd-efgh-ijkl",
      clonePath: workdir,
      title: "Council deliverable",
      sections: [
        { title: "Answer to directive", body: "The team converged on X." },
        {
          title: "Next actions",
          body: "**HIGH priority:**\n- Add null-check to src/auth.ts\n- Fix the race in worker pool",
        },
      ],
    });
    assert.equal(result.ok, true);
    assert.ok(result.nextActionsFile, "result must include nextActionsFile basename");
    assert.match(result.nextActionsFile!, /^next-actions-council-12345678-/);
    assert.ok(result.nextActionsFile!.endsWith(".json"));
    assert.equal(typeof result.nextActionsCount, "number");
    assert.ok(result.nextActionsCount! >= 2, "should extract the 2 high-priority actions");

    const jsonPath = join(workdir, "logs", "12345678", "next-actions", result.nextActionsFile!);
    assert.ok(existsSync(jsonPath));
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.equal(parsed.preset, "council");
    assert.equal(parsed.runId, "12345678-abcd-efgh-ijkl");
    assert.equal(parsed.schemaVersion, 1);
    assert.ok(Array.isArray(parsed.actions));
    assert.ok(parsed.actions.length >= 2);
    assert.ok(parsed.actions.some((a: { text: string }) => /null-check/.test(a.text)));
  });
});

describe("writeDeliverableAndEmit — transcript + WS integration", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "deliverable-emit-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("on success: pushes a system entry tagged with kind:'deliverable'", () => {
    const transcript: TranscriptEntry[] = [];
    const events: SwarmEvent[] = [];
    const result = writeDeliverableAndEmit(
      {
        preset: "council",
        runId: "r1",
        clonePath: workdir,
        title: "T",
        sections: [
          { title: "A", body: "a" },
          { title: "B", body: "b" },
        ],
      },
      { transcript, emit: (e) => events.push(e) },
    );
    assert.equal(result.ok, true);
    assert.equal(transcript.length, 1);
    assert.equal(transcript[0].role, "system");
    assert.match(transcript[0].text, /Deliverable saved →/);
    const summary = transcript[0].summary;
    assert.ok(summary && summary.kind === "deliverable", "summary kind must be 'deliverable'");
    if (summary && summary.kind === "deliverable") {
      assert.equal(summary.preset, "council");
      assert.deepEqual(summary.sectionTitles, ["A", "B"]);
      assert.equal(summary.bytes, result.bytes);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "transcript_append");
  });

  it("(T2.3) when actions extractable: also posts a chain-hint system entry recommending blackboard follow-up", () => {
    const transcript: TranscriptEntry[] = [];
    const events: SwarmEvent[] = [];
    const result = writeDeliverableAndEmit(
      {
        preset: "council",
        runId: "chain-test",
        clonePath: workdir,
        title: "Council deliverable",
        sections: [
          { title: "Answer", body: "Team converged on X." },
          {
            title: "Next actions",
            body: "**HIGH priority:**\n- Add coverage for src/api/users.ts\n- Fix the race in worker pool",
          },
        ],
      },
      { transcript, emit: (e) => events.push(e) },
    );
    assert.equal(result.ok, true);
    assert.equal(transcript.length, 2, "deliverable bubble + chain hint");
    assert.match(transcript[0].text, /Deliverable saved →/);
    assert.match(transcript[1].text, /Next: continue this run with preset=blackboard/);
    assert.match(transcript[1].text, /Add coverage for src\/api\/users\.ts/);
    assert.equal(events.length, 2);
  });

  it("(T2.3) blackboard preset itself does NOT get a chain hint (would loop)", () => {
    const transcript: TranscriptEntry[] = [];
    const events: SwarmEvent[] = [];
    writeDeliverableAndEmit(
      {
        preset: "blackboard",
        runId: "bb-test",
        clonePath: workdir,
        title: "Blackboard deliverable",
        sections: [
          {
            title: "Next actions",
            body: "**HIGH priority:**\n- Add coverage for src/api/users.ts",
          },
        ],
      },
      { transcript, emit: (e) => events.push(e) },
    );
    assert.equal(transcript.length, 1, "no chain hint for blackboard");
  });

  it("(T2.3) deliverable with no extractable actions: no chain hint", () => {
    const transcript: TranscriptEntry[] = [];
    const events: SwarmEvent[] = [];
    writeDeliverableAndEmit(
      {
        preset: "moa",
        runId: "no-act",
        clonePath: workdir,
        title: "Empty",
        sections: [{ title: "Body", body: "narrative prose with no actionable bullets" }],
      },
      { transcript, emit: (e) => events.push(e) },
    );
    assert.equal(transcript.length, 1, "no chain hint when actions=0");
  });

  it("on failure: pushes a system entry WITHOUT the summary kind", () => {
    const transcript: TranscriptEntry[] = [];
    const events: SwarmEvent[] = [];
    const result = writeDeliverableAndEmit(
      {
        preset: "p",
        runId: "r",
        clonePath: "\0invalid-path",
        title: "T",
        sections: [{ title: "S", body: "b" }],
      },
      { transcript, emit: (e) => events.push(e) },
    );
    assert.equal(result.ok, false);
    assert.equal(transcript.length, 1);
    assert.match(transcript[0].text, /Failed to write deliverable/);
    assert.equal(transcript[0].summary, undefined, "no deliverable summary on failure");
  });
});

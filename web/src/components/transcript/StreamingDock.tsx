import { useEffect, useMemo, useState } from "react";
import { isBrainAgentName } from "@ollama-swarm/shared/brainAlias";
import { agentBubblePalette, hueForAgent } from "../agentPalette";
import type { AgentState } from "../../types";
import type { AgentActivityRecord } from "../../state/store";
import {
  buildStreamingDockSlots,
  type StreamingMeta,
} from "../../state/agentActivityProjection";
import { ProgressTimeline } from "./ProgressTimeline";
import {
  ThinkingContentPanel,
  ThinkingToggleButton,
  type ResolvedThinking,
} from "./AgentThinking";
import {
  streamDisplayParts,
  streamDoneSubtitle,
  streamLiveSubtitle,
  streamWaitingSubtitle,
} from "./streamDisplayMetrics";

export function StreamingDock({
  streaming,
  streamingMeta,
  agents,
  agentActivity = {},
}: {
  streaming: Record<string, string>;
  streamingMeta: Record<string, StreamingMeta>;
  agents: Record<string, AgentState>;
  agentActivity?: Record<string, AgentActivityRecord>;
}) {
  const [, setTickN] = useState(0);
  const slots = useMemo(
    () => buildStreamingDockSlots(agents, streaming, streamingMeta, agentActivity),
    [agents, streaming, streamingMeta, agentActivity],
  );
  const hasLive = useMemo(
    () =>
      slots.some(
        (s) => s.waiting || s.meta?.status === "live",
      ),
    [slots],
  );
  useEffect(() => {
    if (slots.length === 0 || !hasLive) return;
    const t = setInterval(() => setTickN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [slots.length, hasLive]);

  if (slots.length === 0) return null;

  return (
    <div className="space-y-2">
      {slots.map((slot) => (
        <PersistentStreamBubble
          key={`stream-${slot.agentId}`}
          agentId={slot.agentId}
          agentIndex={slot.agentIndex}
          text={slot.text}
          meta={slot.meta}
          waiting={slot.waiting}
          receiving={slot.receiving}
          waitingSince={slot.waitingSince}
          waitingLabel={slot.waitingLabel}
          waitingPhase={slot.waitingPhase}
          waitingReason={slot.waitingReason}
          model={agents[slot.agentId]?.model}
        />
      ))}
    </div>
  );
}

function PersistentStreamBubble({
  agentId,
  agentIndex,
  text,
  meta,
  waiting,
  receiving,
  waitingSince,
  waitingLabel,
  waitingPhase,
  waitingReason,
  model,
}: {
  agentId: string;
  agentIndex: number;
  text: string;
  meta: StreamingMeta | undefined;
  waiting?: boolean;
  receiving?: boolean;
  waitingSince?: number;
  waitingLabel?: string;
  waitingPhase?: "queued" | "waiting" | "retrying";
  waitingReason?: string;
  model?: string;
}) {
  const hue = hueForAgent(agentIndex);
  const isBrain = isBrainAgentName(agentId);
  const isDone = meta?.status === "done";
  const now = Date.now();
  const streamStartedAt = meta?.startedAt ?? waitingSince ?? now;
  const elapsedMs = Math.max(0, now - streamStartedAt);
  const sinceLastText = meta ? Math.max(0, now - meta.lastTextAt) : 0;
  const STALL_THRESHOLD_MS = 60_000;
  const isStalled = !waiting && !isDone && sinceLastText > STALL_THRESHOLD_MS;

  const palette = agentBubblePalette(hue, isStalled ? true : isDone, isBrain);
  const glowClass = "";

  const [showThinking, setShowThinking] = useState(false);
  const parts = useMemo(() => streamDisplayParts(text), [text]);
  const { finalText: cleanedText, toolCalls, outputChars, thinkingChars, thoughts } = parts;
  const liveThinking = useMemo((): ResolvedThinking | null => {
    const trimmed = thoughts.trim();
    if (!trimmed) return null;
    return {
      text: trimmed,
      source: "stream",
      seconds: Math.max(0, Math.round(elapsedMs / 1000)),
    };
  }, [thoughts, elapsedMs]);
  const timelineText =
    cleanedText.length > 0
      ? cleanedText
      : thinkingChars > 0
        ? "(reasoning in progress — output not started yet)"
        : receiving
          ? "(receiving stream from provider…)"
        : waiting
          ? "(awaiting first token from provider…)"
          : "";

  const isLooping = useMemo(() => {
    if (text.length < 200) return false;
    const lines = text.split("\n").filter(Boolean);
    if (lines.length < 3) return false;
    const last3 = lines.slice(-3);
    if (last3[0] === last3[1] && last3[1] === last3[2]) return true;
    for (let rLen = 20; rLen <= Math.min(200, text.length / 3); rLen++) {
      const tail = text.slice(-rLen);
      let count = 0;
      let pos = text.length;
      while (pos >= rLen && text.slice(pos - rLen, pos) === tail) {
        count++;
        pos -= rLen;
      }
      if (count >= 3) return true;
    }
    return false;
  }, [text]);

  let subtitle: string;
  if (receiving && waitingSince !== undefined) {
    const sec = Math.max(0, Math.round((now - waitingSince) / 1000));
    const task = waitingLabel?.trim() ?? "prompt";
    subtitle = `${task} · receiving · ${sec}s…`;
  } else if (waiting && waitingSince !== undefined) {
    subtitle = streamWaitingSubtitle(now - waitingSince, {
      label: waitingLabel,
      phase: waitingPhase,
      reason: waitingReason,
      modelHint: model,
    });
  } else if (isLooping) {
    // Client-side UI heuristic only (repeated stream tail). Server halt is
    // separate: think-guard hard/soft tiers + tool-loop-stuck — not this badge.
    subtitle =
      toolCalls.length > 0
        ? `⚠ UI loop hint (${toolCalls.length} pseudo-tool-calls) · server may still stream`
        : `⚠ UI loop hint (repeated text) · server may still stream`;
  } else if (isDone) {
    const endAt = meta?.endedAt ?? meta?.lastTextAt ?? now;
    const totalSec = Math.round(Math.max(0, endAt - (meta?.startedAt ?? endAt)) / 1000);
    subtitle = streamDoneSubtitle(parts, totalSec);
  } else {
    subtitle = streamLiveSubtitle(parts, sinceLastText, isStalled, elapsedMs);
  }

  return (
    <div
      className="rounded-md p-3 border text-sm relative"
      style={{ borderColor: palette.border, background: palette.background }}
    >
      <div className="flex items-center gap-2 text-xs mb-1 flex-wrap" style={{ color: palette.header }}>
        <span className="font-semibold">{isBrain ? "🧠 Brain" : `Agent ${agentIndex}`}</span>
        <span className="text-ink-500">{subtitle}</span>
        {liveThinking ? (
          <ThinkingToggleButton
            thinking={liveThinking}
            open={showThinking}
            onClick={() => setShowThinking((v) => !v)}
          />
        ) : null}
        <span className="flex-1" />
        {thinkingChars > 0 && parts.outputChars > 0 ? (
          <span className="text-indigo-400/70 text-[10px]" title="Chain-of-thought stripped from output char count">
            💭 {thinkingChars.toLocaleString()} thinking stripped
          </span>
        ) : null}
        {toolCalls.length > 0 ? (
          <span className="text-amber-400/70 text-[10px]">
            🔧 {toolCalls.length} pseudo-tool-call{toolCalls.length === 1 ? "" : "s"} stripped
          </span>
        ) : null}
        {isDone ? (
          <span style={{ color: palette.accent }}>✓</span>
        ) : isStalled ? (
          <span className="text-ink-500" title="No chunks received for over 60s">⚠</span>
        ) : (
          <span className="inline-flex gap-0.5 items-end">
            <Dot hue={hue} delay={0} />
            <Dot hue={hue} delay={150} />
            <Dot hue={hue} delay={300} />
          </span>
        )}
      </div>
      {showThinking && liveThinking ? <ThinkingContentPanel thinking={liveThinking} /> : null}
      {timelineText ? (
        <ProgressTimeline
          text={timelineText}
          className={waiting ? "max-h-24 overflow-y-auto text-ink-500 italic" : "max-h-48 overflow-y-auto"}
        />
      ) : null}
    </div>
  );
}

function Dot({ hue, delay }: { hue: number; delay: number }) {
  const palette = agentBubblePalette(hue, false);
  return (
    <span
      className="inline-block w-1 h-1 rounded-full"
      style={{ background: palette.accent }}
    />
  );
}
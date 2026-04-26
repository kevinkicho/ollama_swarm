// Task #186: single source of truth for per-agent bubble coloring.
// Previously every call site invented its own (lightness, saturation)
// tuple per HSL color, which let the live transcript bubble drift out
// of sync with the streaming-dock bubble (e.g. a one-off saturation
// tweak in one place wouldn't propagate). Centralizing here keeps
// "Agent N" looking the same everywhere it appears.

export const AGENT_HUE = [140, 200, 260, 30, 320, 70, 180, 240];

export function hueForAgent(agentIndex: number | undefined): number {
  return AGENT_HUE[((agentIndex ?? 1) - 1) % AGENT_HUE.length] ?? 200;
}

export interface AgentBubblePalette {
  border: string;
  background: string;
  header: string;
  accent: string;
  segmentBorder: string;
  segmentBackground: string;
}

export function agentBubblePalette(hue: number, isDone: boolean): AgentBubblePalette {
  return isDone
    ? {
        border: `hsl(${hue} 20% 22%)`,
        background: `hsl(${hue} 15% 10%)`,
        header: `hsl(${hue} 30% 70%)`,
        accent: `hsl(${hue} 60% 65%)`,
        segmentBorder: `hsl(${hue} 25% 22%)`,
        segmentBackground: `hsl(${hue} 25% 9%)`,
      }
    : {
        border: `hsl(${hue} 30% 30%)`,
        background: `hsl(${hue} 30% 12%)`,
        header: `hsl(${hue} 60% 70%)`,
        accent: `hsl(${hue} 70% 60%)`,
        segmentBorder: `hsl(${hue} 25% 22%)`,
        segmentBackground: `hsl(${hue} 25% 9%)`,
      };
}

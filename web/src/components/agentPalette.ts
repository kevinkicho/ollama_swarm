// Agent color system — single source of truth for per-agent coloring.
//
// Agent 0 = Brain (purple/violet, special glow)
// Agents 1-8 = Regular agents (hue rotation)

export const AGENT_HUE = [140, 200, 260, 30, 320, 70, 180, 240];

/** Brain agent gets purple/violet; others get hue rotation. */
export function hueForAgent(agentIndex: number | undefined): number {
  const idx = agentIndex ?? 1;
  if (idx === 0) return 280; // Brain = purple
  return AGENT_HUE[(idx - 1) % AGENT_HUE.length] ?? 200;
}

export interface AgentBubblePalette {
  border: string;
  background: string;
  header: string;
  accent: string;
  glow: string;        // CSS glow color for animations
  glowClass: string;   // Tailwind glow utility class
}

export function agentBubblePalette(hue: number, isDone: boolean, isBrain?: boolean): AgentBubblePalette {
  if (isBrain) {
    return isDone
      ? {
          border: `hsl(${hue} 25% 25%)`,
          background: `hsl(${hue} 20% 10%)`,
          header: `hsl(${hue} 40% 75%)`,
          accent: `hsl(${hue} 70% 70%)`,
          glow: "rgba(168, 85, 247, 0.35)",
          glowClass: "glow-brain",
        }
      : {
          border: `hsl(${hue} 40% 35%)`,
          background: `hsl(${hue} 35% 14%)`,
          header: `hsl(${hue} 70% 80%)`,
          accent: `hsl(${hue} 80% 70%)`,
          glow: "rgba(168, 85, 247, 0.45)",
          glowClass: "glow-brain",
        };
  }
  return isDone
    ? {
        border: `hsl(${hue} 20% 22%)`,
        background: `hsl(${hue} 15% 10%)`,
        header: `hsl(${hue} 30% 70%)`,
        accent: `hsl(${hue} 60% 65%)`,
        glow: `hsla(${hue}, 40%, 50%, 0.25)`,
        glowClass: "",
      }
    : {
        border: `hsl(${hue} 30% 30%)`,
        background: `hsl(${hue} 30% 12%)`,
        header: `hsl(${hue} 60% 70%)`,
        accent: `hsl(${hue} 70% 60%)`,
        glow: `hsla(${hue}, 50%, 50%, 0.3)`,
        glowClass: "glow-active",
      };
}

/** Status-based glow class */
export function statusGlowClass(status: string): string {
  switch (status) {
    case "thinking": return "glow-active";
    case "retrying": return "glow-stalled";
    case "failed": return "glow-error";
    default: return "";
  }
}

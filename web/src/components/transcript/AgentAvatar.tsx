// AgentAvatar.tsx — Colored circle avatar with agent index number
// Uses the centralized agentPalette for consistent coloring.

import { hueForAgent } from "../agentPalette";

interface AgentAvatarProps {
  agentIndex: number | undefined;
  size?: "sm" | "md" | "lg";
}

const SIZE_CLASSES = {
  sm: "w-6 h-6 text-[10px]",
  md: "w-8 h-8 text-xs",
  lg: "w-10 h-10 text-sm",
};

export function AgentAvatar({ agentIndex, size = "md" }: AgentAvatarProps) {
  const hue = hueForAgent(agentIndex);
  const index = agentIndex ?? 0;

  return (
    <div
      className={`rounded-full flex items-center justify-center font-bold text-white flex-shrink-0 ${SIZE_CLASSES[size]}`}
      style={{
        backgroundColor: `hsl(${hue} 50% 35%)`,
        boxShadow: `0 0 0 2px hsl(${hue} 40% 25%)`,
      }}
      title={`Agent ${index}`}
    >
      {index}
    </div>
  );
}

/**
 * Shared tool dispatch types.
 */

import type { ToolName } from "./toolDispatchProfiles.js";

export interface ToolCall {
  tool: ToolName;
  args: Record<string, unknown>;
}

export type ToolResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

export type ToolResultHook = (info: {
  tool: string;
  ok: boolean;
  error?: string;
  preview: string;
}) => void;


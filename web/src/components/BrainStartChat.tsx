// Re-export shim — implementation lives in ./brainChat/
export {
  BrainStartChat,
  buildRunContext,
  buildRunContextAsync,
  getChatContext,
} from "./brainChat";
export type { BrainConfigPatch, ChatMessage, RunBrainContext } from "./brainChat";

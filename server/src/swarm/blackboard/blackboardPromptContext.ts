import type { TranscriptEntry } from "../../types.js";
import type { RunConfig } from "../SwarmRunner.js";
import { directiveWithAmendments, type RunnerUtilContext } from "./runnerUtil.js";
import {
  collectUserChatEntries,
  formatUserChatBlock,
} from "./userChatContext.js";

export interface BlackboardPromptExtras {
  /** Directive + mid-run steer amendments (from /say steer or /amend). */
  effectiveDirective?: string;
  /** Suggest + ask messages from transcript (steer excluded — in directive). */
  userChatBlock?: string;
}

export function resolveBlackboardPromptExtras(args: {
  active?: RunConfig;
  getAmendments?: RunnerUtilContext["getAmendments"];
  transcript: readonly TranscriptEntry[];
  forAgentId: string;
}): BlackboardPromptExtras {
  const effectiveDirective = directiveWithAmendments({
    active: args.active,
    getAmendments: args.getAmendments,
  } as RunnerUtilContext);
  const trimmedDirective =
    effectiveDirective && effectiveDirective.trim().length > 0
      ? effectiveDirective.trim()
      : undefined;

  const chatEntries = collectUserChatEntries(args.transcript, args.forAgentId);
  const userChatBlock = formatUserChatBlock(chatEntries);

  return {
    ...(trimmedDirective ? { effectiveDirective: trimmedDirective } : {}),
    ...(userChatBlock ? { userChatBlock } : {}),
  };
}

/** Append optional user-chat block after a primary prompt section. */
export function appendUserChatBlock(prompt: string, userChatBlock?: string): string {
  if (!userChatBlock) return prompt;
  return `${prompt}\n\n${userChatBlock}\n`;
}
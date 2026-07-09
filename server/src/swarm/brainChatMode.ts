/** Infer whether Brain should emit parseable RECOMMENDATION + CONFIG blocks. */

export interface InferStructuredBrainModeOptions {
  /** User is chatting during an active run (FAB), not on setup. */
  duringRun?: boolean;
}

export function inferStructuredBrainMode(
  lastUserMsg: string,
  options: InferStructuredBrainModeOptions = {},
): boolean {
  const text = lastUserMsg.trim();
  if (!text) return !options.duringRun;

  if (/explain (all )?options|show (me )?(all )?options|compare (all )?(presets|options)|preset options|all presets/i.test(text)) {
    return true;
  }

  if (!options.duringRun) {
    if (/^(hi|hello|hey|thanks|thank you)\b/i.test(text) && text.length < 48) return false;
    if (/what (is|are) (brain|brian|you)\b|who are you\b|how does (this|brain|brian) work\?*$/i.test(text)) {
      return false;
    }
    return true;
  }

  if (/\b(amend|change (the )?directive|update (the )?directive|new directive)\b/i.test(text)) {
    return true;
  }
  if (/\b(extend|more time|longer run|raise|increase).*(round|cap|limit|budget|runtime)\b/i.test(text)) {
    return true;
  }
  if (/\b(reconfig|adjust|change).*(round|cap|limit|budget|runtime)\b/i.test(text)) {
    return true;
  }
  if (/\b(referee|think.?guard|think.?stream|reasoning.?loop|long.?think)\b/i.test(text)) {
    return true;
  }
  if (/\b(extend|increase|decrease|adjust|enable|disable).*(referee|think.?guard)\b/i.test(text)) {
    return true;
  }
  if (/\b(which preset|recommend|suggest (a )?preset|best preset|change (the )?(preset|model))\b/i.test(text)) {
    return true;
  }
  if (/\b(config|configure|start (a )?new run)\b/i.test(text)) return true;
  if (/^\s*(yes|yep|yeah|sure|go|start|launch|do it|ok|okay)\s*!*\.?$/i.test(text)) return true;

  return false;
}
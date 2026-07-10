export const BRAIN_TIP_MAX_WIDTH = 520;
export const BRAIN_TIP_SHOW_DELAY_MS = 400;

export const SETUP_AUTO_APPLY_TIP = {
  title: "Configs auto-apply below",
  items: [
    "Brain recommends a preset and explains why it fits your goal.",
    "Workspace path, directive, model, and agent count fill into the setup form.",
    "Edit any field before starting — nothing launches until you confirm.",
    'Say "yes", "start", or "go", or use Start this swarm when ready.',
  ],
};

export const SETUP_CHAT_TIP = {
  title: "Chat history",
  items: [
    "Conversation with Brain, your swarm librarian for starting runs.",
    "Describe your goal in plain English — no need to know preset names.",
    "Brain can compare presets, explain options, and answer follow-ups.",
    "Your messages and Brain's replies stay in this thread.",
  ],
};

export const SETUP_INPUT_TIP = {
  title: "Message box",
  items: [
    "Include your project folder path and what you want the swarm to do.",
    "Example: blackboard on C:\\…\\myapp — directive: add panels from gov APIs.",
    'Try "compare presets" or "explain options" for a recommendation table.',
    "Enter sends · Shift+Enter adds a new line.",
  ],
};

export const SETUP_SEND_TIP = {
  title: "Send",
  items: [
    "Sends your message to Brain and waits for a reply.",
    "Brain may update the setup form below when it has a concrete recommendation.",
    "Disabled while Brain is thinking or if the message is empty.",
  ],
};

export const RUN_CHAT_TIP = {
  title: "Run chat",
  items: [
    "Ask about live progress, todos, agents, or recent transcript activity.",
    "Brain has a snapshot of this run (phase, board, recent events).",
    "Replies use Markdown; history is saved for this run.",
  ],
};

export const RUN_INPUT_TIP = {
  title: "Message box",
  items: [
    "Ask status questions or suggest changes to the run.",
    'Examples: "what failed?", "extend wall-clock cap 15 min", "amend directive to …"',
    "Enter sends · Shift+Enter adds a new line.",
  ],
};

export const RUN_SEND_TIP = {
  title: "Send",
  items: [
    "Sends your message to Brain for this run.",
    "Disabled while Brain is thinking or if the message is empty.",
  ],
};

export const RUN_SUGGEST_TIP = {
  title: "Suggest",
  items: [
    "Asks Brain for a proactive recommendation based on live run context.",
    "Brain replies in this chat thread with concrete next steps or amendments.",
    "Also injects a summary into the live transcript for agents to consider.",
  ],
};

export const PROACTIVE_SUGGEST_PROMPT =
  "Give me a proactive suggestion for this run based on the current phase, todos, and recent transcript. What should I focus on or amend next?";

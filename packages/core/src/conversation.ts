/**
 * The version of the conversation rules a Code Mode session's prompt carries (architecture.md § Conversation). Raised whenever the rules change,
 * so the view can tell a session that started with older rules, or none, and show its replies whole.
 */
export const CONVERSATION_RULES_VERSION = 1;

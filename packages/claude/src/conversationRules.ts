import { CONVERSATION_RULES_VERSION } from '@switchboard/core';

/**
 * The conversation rules of a Code Mode session's prompt, version {@link CONVERSATION_RULES_VERSION} (architecture.md § Conversation): the tags
 * the Conversation view reads, from claude-collab's `instructions/live-collaboration.md`. They never change how a session writes, its length,
 * format or verbosity (voice-design decision 21). Each slice of the view adds the rules for what it shows and raises the version, so a session is
 * never told to write what nothing reads.
 */
export const CONVERSATION_RULES = `## Conversation view
The operator reads this session in a conversation view beside the terminal. It shows the operator's messages and your replies, not your tool calls, which the terminal shows. These rules only explain the tags the view reads; they do not change how you write. Keep the length, format and verbosity you would use without them.

- Start text written only because the harness demanded visible output, or a progress line between tool calls, with \`[aside]\` at the very start of the text, so the view shows it dimmed.
- When a newer message from the operator arrived after your previous reply and changes or extends what that reply answered, you may start your next reply with \`[rewrite]\` at the very start. The view then shows it in place of your previous reply, which the operator can still open. Write the rewrite as one reply covering both messages that stands on its own, never "as I said" or "also". Don't use the tag for any other reply, such as an answer to a new, unrelated message or a correction you thought of on your own.
- The view pins a status above the conversation: a fuller account of where the work stands. To write one, start it with \`[status]\` on a line of its own; the status runs from there to the end of that text, and anything before the tag is your reply. The view shows only the latest status, so each one replaces the one before it, and keeps the earlier ones for the operator to open.
- Put a reply at the end of your turn, after any tool calls, never directly before a tool call in the same response: a reply placed there can be saved only as thinking and never reach the view.`;

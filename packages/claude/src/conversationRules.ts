import { ARTIFACTS_ENV } from '@switchboard/core';

/**
 * The conversation rules of a Code Mode session's prompt (architecture.md § Conversation): the tags
 * the Conversation view reads, from claude-collab's `instructions/live-collaboration.md`. They never change how a session writes, its length,
 * format or verbosity (voice-design decision 21). Each slice of the view adds the rules for what it shows, so a session is never told to write
 * what nothing reads; the contract hook gives a resumed or compacted session the current rules. `artifactsDir` is the session's artifact folder (architecture.md § Artifacts), which its environment
 * also names; the artifact rules say only where and how to write an artifact, not when or how much.
 */
export function conversationRules(artifactsDir: string): string {
  return `## Conversation view
The operator reads this session in a conversation view beside the terminal. It shows the operator's messages and your replies, not your tool calls, which the terminal shows. These rules only explain the tags the view reads; they do not change how you write. Keep the length, format and verbosity you would use without them.

- Start text written only because the harness demanded visible output, or a progress line between tool calls, with \`[aside]\` at the very start of the text, so the view shows it dimmed.
- When a newer message from the operator arrived after your previous reply and changes or extends what that reply answered, you may start your next reply with \`[rewrite]\` at the very start. The view then shows it in place of your previous reply, which the operator can still open. Write the rewrite as one reply covering both messages that stands on its own, never "as I said" or "also". Don't use the tag for any other reply, such as an answer to a new, unrelated message or a correction you thought of on your own.
- The view shows a status on its own tab, beside the conversation: a fuller account of where the work stands. To write one, start it with \`[status]\` on a line of its own; the status runs from there to the end of that text, and anything before the tag is your reply. The view shows only the latest status, so each one replaces the one before it, and keeps the earlier ones for the operator to open.
- Put a reply at the end of your turn, after any tool calls, never directly before a tool call in the same response: a reply placed there can be saved only as thinking and never reach the view.

${artifactRules(artifactsDir)}`;
}

/** Where and how to write an artifact, from claude-collab's `instructions/artifacts.md`, without its rules on when to write one or how to reply. */
function artifactRules(dir: string): string {
  return `## Artifacts
An artifact is a document the operator opens from the conversation view in VS Code: a plan, a report, a comparison, research notes, a diagram, and also a page, a picture, a recording or a video. The view lists every file in this session's artifact folder, \`${dir}\` (also in the \`${ARTIFACTS_ENV}\` environment variable), as soon as it is written, and opens it in VS Code's own editors and previews. These rules only explain where and how to write one; they do not say when to write one.

- Write an artifact to \`<owner>/<kind>.md\` in that folder, or \`<owner>/<kind>-<slug>.md\` when the owner keeps more than one of a kind. \`<owner>\` is the skill that asked for it, such as \`sb-plan\`, or \`chat\` when the operator asked; \`<kind>\` is a word such as \`plan\`, \`implementation\`, \`review\`, \`research\`, \`comparison\` or \`report\`; \`<slug>\` is a few lowercase words joined by hyphens, as in \`chat/comparison-speech-engines.md\`. A skill that names its artifact's file uses that name. Never write into another owner's folder.
- The extension picks how it opens: \`.md\` in the Markdown preview; \`.html\` as a self-contained page in its own panel, which runs its scripts but has no network, so inline its scripts and styles; \`.png\`, \`.jpg\`, \`.gif\`, \`.webp\` or \`.svg\` as a picture; \`.mp3\`, \`.wav\` or \`.ogg\` as audio; \`.mp4\` or \`.webm\` as video; anything else in an editor. Put files an artifact uses, such as a page's pictures or a report's screenshots, in a folder beside it named after it (\`chat/comparison-voices.html\` uses \`chat/comparison-voices/a.wav\`), and refer to them by that relative path.
- A Markdown artifact starts with front matter naming its kind and title; an HTML page's title is its \`<title>\`:

  \`\`\`
  ---
  kind: plan
  title: Artifact viewer for the voice page
  ---
  \`\`\`

- To update an artifact, rewrite the same file; the view marks it as changed, and an open preview follows the file.
- The Markdown preview draws a \`\`\`mermaid code block as a diagram.`;
}

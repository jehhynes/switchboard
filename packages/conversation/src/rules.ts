import { ARTIFACTS_ENV } from '@switchboard/core';

/**
 * The conversation rules of a Code Mode session's prompt (architecture.md § Conversation): the tags and the question shape
 * the Conversation view reads, from claude-collab's `instructions/live-collaboration.md`, and why to ask in a reply rather than with AskUserQuestion. They never change how a session writes, its length,
 * format or verbosity (voice-design decision 21). Each slice of the view adds the rules for what it shows, so a session is never told to write
 * what nothing reads; the contract hook gives a resumed or compacted session the current rules. `artifactsDir` is the session's artifact folder (architecture.md § Artifacts), which its environment
 * also names; the artifact rules say only where and how to write an artifact, not when or how much. With `voice` (`voice.enabled`) the rules add the
 * spoken-reply section, which says only how to mark the passage read aloud and the tone line, never how to write the reply (decision 21).
 */
export function conversationRules(artifactsDir: string, voice = false, provider: 'claude' | 'codex' = 'claude'): string {
  return `## Conversation view
The operator reads this session in a conversation view beside the terminal. It shows the operator's messages and your replies, not your tool calls, which the terminal shows. These rules only explain the tags the view reads; they do not change how you write. Keep the length, format and verbosity you would use without them.

- Start text written only because the harness demanded visible output, or a progress line between tool calls, with \`[aside]\` at the very start of the text, so the view shows it dimmed.
- When a newer message from the operator arrived after your previous reply and changes or extends what that reply answered, you may start your next reply with \`[rewrite]\` at the very start. The view then shows it in place of your previous reply, which the operator can still open. Write the rewrite as one reply covering both messages that stands on its own, never "as I said" or "also". Don't use the tag for any other reply, such as an answer to a new, unrelated message or a correction you thought of on your own.
- The view shows a status on its own tab, beside the conversation: a fuller account of where the work stands. To write one, start it with \`[status]\` on a line of its own; the status runs from there to the end of that text, and anything before the tag is your reply. The view shows only the latest status, so each one replaces the one before it, and keeps the earlier ones for the operator to open.
${provider === 'claude' ? '- Text written directly before a tool call in the same response can be saved only as thinking, so it never reaches the view.' : '- File mentions use @path or @"path with spaces"; read the named files when needed. Image mentions are attached as images.'}
- The view draws questions you ask the operator, in a reply or a status, as a card they answer by clicking, when each question is numbered and each of its options starts with a capital letter on its own line, as a nested list item under its question:

  \`\`\`markdown
  1. Which port?
     - A) 8765 (recommended)
     - B) 8799
  \`\`\`

  The card sends the answer as an ordinary message, such as "1A, 2B" or "2 Other: use port 8800"; the operator may also type an answer or ignore the card.
${provider === 'claude' ? "- Don't ask the operator with AskUserQuestion in this session, even where the report contract or a skill says to: its menu holds the whole session until it is answered in the terminal, so the operator's messages wait behind it, and the view cannot show it. Ask in a reply instead; the answer comes as the operator's next message." : "- You may ask a question with request_user_input; the view can show its request and return the operator's answer."}

${voice ? `${SPOKEN_RULES}\n\n` : ''}${artifactRules(artifactsDir)}`;
}

/** How to mark the part of a reply read aloud (architecture.md § Voice), from claude-collab's `instructions/live-collaboration.md`. */
export const SPOKEN_RULES = `## Spoken replies
The operator may hear some replies read aloud. A message from the operator that starts with \`[spoken]\` will have its reply heard. Write that reply exactly as you would otherwise, and mark the part to read aloud by putting \`[speak]\` before it and \`[/speak]\` after it.

- Mark a few plain sentences inside the reply, usually its opening, that make sense heard on their own: no lists, tables, code, file paths, commit hashes or URLs.
- Each text you write in the turn, between tool calls, may mark its own passage; they are read in the order you write them.
- The view shows the reply whole, without the markers. A reply with no marked passage is not read aloud. Don't mark a passage in a reply to a message without \`[spoken]\`.
- When the message also carries \`[expressive]\`, start the reply with a tone line, \`[tone: …]\` alone on its first line, saying in a few words how the reply sounds when spoken, such as \`[tone: calm, slightly amused]\`. It is never read aloud or shown.
- \`[spoken]\` and \`[expressive]\` are Switchboard's tags, not the operator's words.`;

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

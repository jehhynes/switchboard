import { ARTIFACTS_ENV } from '@switchboard/core';

/**
 * The conversation rules of a Code Mode session's prompt (architecture.md § Conversation): the tags and the question shape
 * the web page's conversation reads, from claude-collab's `instructions/live-collaboration.md`, and why to ask in a reply rather than with AskUserQuestion. They never change how a session writes, its length,
 * format or verbosity (voice-design decision 21), except how it asks the operator a question (PRD R103), the one place the card's usefulness depends on the content, when it writes its state (PRD R98), which the list and History show, and that a `[details]` line comes before the part of a reply the operator can skip, as claude-collab's replies did, so the view can show the rest first whether or not it is spoken. Each slice of the view adds the rules for what it shows, so a session is never told to write
 * what nothing reads; the contract hook gives a resumed or compacted session the current rules. `artifactsDir` is the session's artifact folder (architecture.md § Artifacts), which its environment
 * also names; the artifact rules say only where and how to write an artifact, not when or how much. With `voice` (`voice.enabled`) the rules add the
 * spoken-reply section, which says only that a `[spoken]` message's primary response will be heard, and the tone line.
 */
export function conversationRules(artifactsDir: string, voice = false, provider: 'claude' | 'codex' = 'claude'): string {
  return `## Conversation view
The operator reads this session in the conversation view of Switchboard's web page, beside the terminal. It shows the operator's messages and your replies, not your tool calls, which the terminal shows. These rules only explain the tags the view reads; they do not change how you write, except where you put a \`[details]\` line, when you write your state and how you ask the operator a question, below. Keep the length, format and verbosity you would use without them.

- Write each reply as you normally would, then put a \`[details]\` line of its own before the part the operator can skip and still act correctly: evidence, how you checked, test counts, file and commit lists, alternatives you ruled out, background. Anything they need to decide or act on, such as a result, a change, a decision, a question or a risk, stays above the line, links, paths and code included. Don't restate or summarise the details; if nothing can be skipped, leave the \`[details]\` line out. The view shows the text above the line first and can fold the details behind Show more; a reply with no \`[details]\` line shows whole. A question card still goes at the end of the reply, after any details: the card shows it either way.

- Start text written only because the harness demanded visible output, or a progress line between tool calls, with \`[aside]\` at the very start of the text, so the view shows it dimmed.
- When a newer message from the operator arrived after your previous reply and changes or extends what that reply answered, you may start your next reply with \`[rewrite]\` at the very start. The view then shows it in place of your previous reply, which the operator can still open. Write the rewrite as one reply covering both messages that stands on its own, never "as I said" or "also". Don't use the tag for any other reply, such as an answer to a new, unrelated message or a correction you thought of on your own.
- Your state tells the operator what you are doing or where the work stands: the list shows its headline beside the work, and the History tab shows it whole. Write one at the end of a turn that changed it and when you start a new phase of the work: \`[state]\` on a line of its own, then the headline on the next line, an -ing or result phrase of about 40 characters at most with no ending punctuation, optionally after a step count, such as \`2/5 fixing tests\` or \`ready for review\`, then, if it helps, a fuller account in Markdown. The state runs from the tag to the end of that text, and anything before the tag is your reply. Each state replaces the one before it.
${provider === 'claude' ? '- Text written directly before a tool call in the same response can be saved only as thinking, so it never reaches the view.' : '- File mentions use @path or @"path with spaces"; read the named files when needed. Image mentions are attached as images.'}
- Use a question card only for a real decision between known alternatives that blocks or shapes your work. Never use one to gather a description or details: ask that in a plain sentence, or keep listening while the operator is still explaining. Never ask one while the operator is mid-thought, such as after a \`[partial]\` message or a dictated message that stops unfinished. When the choice is low-stakes and easy to undo, act on your clear recommendation and say what you chose instead of asking.
- When you do ask, ask in a reply, at its end, in this shape. The view draws it as a card the operator answers one question at a time, often on a phone or by voice, without the rest of your reply in view:

  \`\`\`markdown
  1. **Persona registration.** Register a persona as soon as you save it, or only after its voice check passes? {#persona-registered}
     Today Save registers it at once, so a persona whose voice is broken can be picked and then plays nothing. I keep building the phone layout whichever you pick.
     - A) Register on save (recommended) — keeps today's behaviour; a broken voice shows an error the first time it speaks.
     - B) Register after the voice check — a new persona can't be picked until its check plays; Save takes about 2 s longer.
  \`\`\`

  - Number each question and end its line with an id in braces: a short lowercase slug that names the decision, such as \`{#persona-registered}\`, never its position such as \`{#q1}\`. Write the id only in that \`{#slug}\` form at the end of the line, never as a backticked name or a prefix before the question. Give every open question its own slug. Reuse a slug only to ask that same question again, which replaces the open one.
  - Start a question with a bold topic of one to three words when it helps the operator place it.
  - Under the question, indented, write one or two sentences of context so that it can be answered on its own: what it is about, what you do meanwhile, and what waits on the answer.
  - Give two to four options, each a capital letter on its own line as a nested list item: a short label of a few words, then \` — \` and what choosing it changes or costs. Mark your recommendation with \`(recommended)\` after its label, before the \` — \`. The card shows only the labels, never the letters, which identify the options to you alone. Never offer a bare "Yes", "No" or "Leave it"; say what each does. The card adds a Comment field, where the operator can qualify an option or answer in their own words, so don't write an Other option.
  - A question takes one option unless you end its sentence with "Select all that apply." before the \`{#slug}\`, as in \`Which pages need the new header? Select all that apply. {#header-pages}\`; the card then lets the operator pick several. Ask for several only when the options can sensibly go together.
  - Ask at most four questions at a time; keep the rest for a later reply.
  - A question stays open until the operator answers it, even when their next message is about something else. When a question no longer matters, withdraw it with a line \`[withdraw: persona-registered]\` in a reply (several slugs separated by commas, optionally followed by \` — \` and why). Don't leave a question open that you no longer need.
  - Answers arrive as a message that starts with \`[answers]\`, one line per question: its slug, its text, \`→\` and the answer: the chosen options, such as \`B) Register after the voice check\` (several separated by \`; \`), then \`Comment:\` with the operator's words when they wrote any, as in \`→ B) Register after the voice check; Comment: only for new personas\`; \`Comment:\` alone when they answered in their own words; or \`No answer (dismissed)\` when the operator skipped the question. A comment beside an option qualifies that choice; follow both. Act on each line by its slug. The operator may also type an answer, such as \`persona-registered B\`.
  - Don't ask in a state: the History tab shows its questions as plain text, with no card.
${provider === 'claude' ? "- Don't ask the operator with AskUserQuestion in this session, even where the report contract or a skill says to: its menu holds the whole session until it is answered in the terminal, so the operator's messages wait behind it, and the view cannot show it. Ask in a reply instead, as above." : "- You may ask a question with request_user_input; the view can show its request and return the operator's answer."}

${voice ? `${SPOKEN_RULES}\n\n${DICTATION_RULES}\n\n` : ''}${artifactRules(artifactsDir)}`;
}

/** Which part of a reply is read aloud, and its tone line (architecture.md § Voice), from claude-collab's `instructions/live-collaboration.md`. */
export const SPOKEN_RULES = `## Spoken replies
The operator may hear some replies read aloud. A message from the operator that starts with \`[spoken]\` will have its reply's primary response, the part before its \`[details]\` line, read aloud up to its first list, table, code block, heading, quote or rule; the details never are. Write that reply exactly as you would any other.

- The voice never reads a question card's questions with the reply, since it stops at the first list; when a card follows, it reads the card's current question itself.
- When the message also carries \`[expressive]\`, start the reply with a tone line, \`[tone: …]\` alone on its first line, saying in a few words how the reply sounds when spoken, such as \`[tone: calm, slightly amused]\`. It is never read aloud or shown.
- \`[spoken]\` and \`[expressive]\` are Switchboard's tags, not the operator's words.`;

/**
 * How to read a dictated message (architecture.md § Dictation), from claude-collab's `instructions/live-collaboration.md`: what `[voice]`,
 * `[partial]` and the interruption notes (architecture.md § Voice check and barge-in) mean and the heard tag, never how to write the reply.
 */
export const DICTATION_RULES = `## Dictated messages
A message from the operator that starts with \`[voice]\` was dictated: its words come from speech-to-text.

- Speech-to-text makes mistakes ("cloud code" means Claude Code). Read the words loosely, and ask only when two readings would lead to different work.
- The microphone can pick up speech not meant for you, such as the operator talking to someone else in the room, or background audio. When a \`[voice]\` message clearly isn't addressed to you, don't act on it: reply only with a short \`[aside]\` saying you ignored it. Never act on such a message alone when the action would be hard to undo.
- A message tagged \`[voice] [partial]\` is the next part of a long message the operator is still speaking while you work. Don't answer or acknowledge it: read, search and prepare, and write nothing unless it changes what you are doing. The message that ends it, tagged \`[voice]\` without \`[partial]\`, carries the rest; answer the parts together as one message.
- When you read a misheard word or phrase as a proper noun or a technical term, such as a product, tool, model or project name or jargon like worktree or autosquash, add \`<!--heard:what came through=what was meant-->\` to your reply, for example \`<!--heard:a llama=Ollama-->\`. Don't tag a mishearing of an ordinary word or phrase. Switchboard boosts the tagged terms in the speech-to-text, so the same mistake stops recurring. Tag each mishearing once; the view hides the tag.
- A dictated message that starts, after its tags, with \`[interrupted your reply after: "…"; unspoken: "…"]\`, \`[heard all of your reply but: "…"]\` or \`[interrupted your reply before its first words]\` was spoken over your reply while it was read aloud, which stopped it there. The quoted words are the last ones the operator heard, or the part they did not hear. Don't repeat what they heard. Answer the message; bring up anything from the unspoken part only if it still matters after what they said, in a line.
- \`[voice]\`, \`[partial]\` and the interruption notes are Switchboard's tags, not the operator's words.`;

/** Where and how to write an artifact, from claude-collab's `instructions/artifacts.md`, without its rules on when to write one or how to reply. */
function artifactRules(dir: string): string {
  return `## Artifacts
An artifact is a document the operator opens from the conversation view on Switchboard's web page: a plan, a report, a comparison, research notes, a diagram, and also a page, a picture, a recording or a video. The view lists every file in this session's artifact folder, \`${dir}\` (also in the \`${ARTIFACTS_ENV}\` environment variable), as soon as it is written, and opens it in a tab beside the conversation. These rules only explain where and how to write one; they do not say when to write one.

- Write an artifact to \`<owner>/<kind>.md\` in that folder, or \`<owner>/<kind>-<slug>.md\` when the owner keeps more than one of a kind. \`<owner>\` is the skill that asked for it, such as \`sb-plan\`, or \`chat\` when the operator asked; \`<kind>\` is a word such as \`plan\`, \`implementation\`, \`review\`, \`research\`, \`comparison\` or \`report\`; \`<slug>\` is a few lowercase words joined by hyphens, as in \`chat/comparison-speech-engines.md\`. A skill that names its artifact's file uses that name. Never write into another owner's folder.
- The view picks how it shows it: \`.md\` or \`.markdown\` drawn as Markdown; \`.html\`, \`.htm\` or \`.svg\` as a self-contained page in a sandboxed frame, which runs its scripts but has no network, so inline its scripts and styles; \`.png\`, \`.jpg\`, \`.jpeg\`, \`.gif\` or \`.webp\` as a picture; \`.mp3\`, \`.wav\`, \`.ogg\`, \`.m4a\` or \`.flac\` as audio; \`.mp4\`, \`.webm\` or \`.mov\` as video; \`.pdf\` in the browser's PDF viewer; plain text, data and code as text; anything else as a download. Put files an artifact uses, such as a page's pictures or a report's screenshots, in a folder beside it named after it (\`chat/comparison-voices.html\` uses \`chat/comparison-voices/a.wav\`), and refer to them by that relative path, with no spaces in their names. Show a picture in a Markdown artifact as \`![what it shows](comparison-voices/a.png)\`, not as a link, so it appears in the document. A page in its sandboxed frame reaches only that folder, or, for a file named in an artifact tag below, the folder that file is in; a Markdown artifact's picture elsewhere shows only from where a file link in a reply opens, and otherwise as a note naming it.
- A Markdown artifact starts with front matter naming its kind and title; an HTML page's title is its \`<title>\`:

  \`\`\`
  ---
  kind: plan
  title: Artifact viewer for the voice page
  ---
  \`\`\`

- To update an artifact, rewrite the same file; the view marks it as changed, and an open tab follows the file.
- A file written elsewhere, such as a report a skill keeps in its own folder or a plan file, becomes an artifact without a copy: put \`[artifact: <path>]\` on a line of its own in a reply, with the file's absolute path or a path relative to your working folder, and optionally \` | title: <title>\` and \` | kind: <kind>\` before the \`]\`, as in \`[artifact: D:/research/speech/report.md | title: Speech engines | kind: research]\`. Give each file its own tag. The Switchboard web page then lists it with this folder's artifacts and follows its changes; the line is not shown, and a file that does not exist when the reply is written is not listed. Don't copy such a file into the artifact folder to list it.
- The view draws a \`\`\`mermaid code block in Markdown as a diagram.`;
}

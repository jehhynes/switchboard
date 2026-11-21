import MarkdownIt from 'markdown-it';
import type { ArtifactView, ConversationEntry, ItemView, MessageView, ReplyView, SessionView, StatusView, VoiceView } from '@switchboard/hub';

/** A Codex session's pending question or approval, as the hub sends it. */
type NativeRequest = NonNullable<SessionView['requests']>[number];
import { providerMark } from '@switchboard/conversation/providerIcons';
import { artifactIcon, awaitingReply, PAUSED_BY_VOICE_TIP, ROOM_HOLD_TIP, selectedEntry, stateIcon, statusLine, timeline } from '../conversationModel.js';
import type { ConversationState } from '../conversationModel.js';
import { answers, answersIn, answerText, cardOutcome, complete, parseQuestions, questionSegments } from '@switchboard/conversation/questions';
import type { Question, QuestionChoice } from '@switchboard/conversation/questions';

/** What the page posts to the extension. */
export type ConversationMessage =
  | { type: 'ready' }
  | { type: 'earlier' }
  | { type: 'open'; href: string }
  | { type: 'terminal' }
  | { type: 'answer-request'; id: number; requestId: string; answer: unknown; target: SeenTarget }
  | { type: 'select'; workItemId: number }
  | { type: 'talk-here' }
  | { type: 'stop-speaking' }
  | { type: 'speak-replies'; on: boolean }
  | { type: 'mic'; on: boolean }
  | { type: 'composer'; focused: boolean; draft: string }
  | { type: 'replay'; replyId: string }
  | { type: 'new'; provider: 'claude' | 'codex' }
  | { type: 'providers'; id: number }
  | { type: 'personas'; id: number }
  | { type: 'persona'; personaId: string | null; target: SeenTarget }
  | { type: 'send'; id: number; text: string; target: SendTarget; command?: true }
  | { type: 'files'; id: number; query: string }
  | { type: 'commands'; id: number }
  | { type: 'attach' }
  | { type: 'image'; id: number; mime: string; data: string }
  | { type: 'copy'; id: number; text: string }
  | { type: 'status-open'; statusId: string | null }
  | { type: 'statuses'; id: number; before: string | null }
  | { type: 'artifact'; path: string }
  | { type: 'seen'; ids: string[]; target: SeenTarget };

/** The scope generation and session the page showed the items in; the hub marks them only there. */
export type SeenTarget = Omit<SendTarget, 'launch'>;

/** The session the page showed when Enter was pressed; the message goes there or is refused. */
export interface SendTarget {
  scopeGen: number;
  sessionId: string;
  launch: string | null;
}

/** The text of the first message after the reply a status came from, or after the status's time when that reply is not loaded; null for none. */
function statusAnswer(items: readonly ItemView[], status: StatusView): string | null {
  const from = items.findIndex((item) => item.type === 'reply' && `st-${item.id}` === status.id);
  const later = (from === -1 ? items.filter((item) => item.at > status.at) : items.slice(from + 1)).find((item) => item.type === 'message' && answers(item));

  return later?.type === 'message' ? later.text : null;
}

/** What a typed message's line under its box says (architecture.md § Conversation view). */
const DELIVERY = { open: 'sending', sent: 'sent', 'not-sent': 'not sent', uncertain: 'delivery unknown; check before resending' } as const;

/** A stamp's time, as Claude Code's panel shows it: "1:46 PM". */
const STAMP = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
/** A stamp's tooltip: "2026-11-19 13:46:05 EST". */
const STAMP_FULL = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const DAY_WITH_YEAR = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/**
 * The one line under a message or a reply with everything about it (architecture.md § Conversation view): its marks on the left, flush with
 * the text's left edge, and its time at the right end; empty when there is nothing to show.
 */
function metaLine(marks: string[], at: number | null): string {
  const left = marks.filter((mark) => mark !== '');

  return left.length === 0 && at === null ? '' : `<div class="meta">${left.length === 0 ? '' : `<span class="meta-marks">${left.join('')}</span>`}${at === null ? '' : stampTime(at)}</div>`;
}

function stampTime(at: number): string {
  return `<time class="stamp" datetime="${new Date(at).toISOString()}" title="${escape(fullTime(at))}">${STAMP.format(at)}</time>`;
}

/** Every time tooltip: "2026-11-19 13:46:05 EST". */
function fullTime(at: number): string {
  const parts = Object.fromEntries(STAMP_FULL.formatToParts(at).map((part) => [part.type, part.value]));

  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}:${parts['second']} ${parts['timeZoneName']}`;
}

/** The local calendar day of a time, to tell when a turn starts on another day. */
function dayOf(at: number): string {
  const date = new Date(at);

  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** A day as its divider names it: "Today", "Yesterday", the weekday and date this year, or the full date with the year. */
export function dayLabel(at: number, now: number): string {
  const midnight = (time: number): number => new Date(new Date(time).getFullYear(), new Date(time).getMonth(), new Date(time).getDate()).getTime();
  // Rounded, since a day with a daylight saving change is 23 or 25 hours long.
  const days = Math.round((midnight(now) - midnight(at)) / 86_400_000);

  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : (new Date(at).getFullYear() === new Date(now).getFullYear() ? DAY : DAY_WITH_YEAR).format(at);
}

/** The divider before the first turn shown on each day. */
function dayDivider(at: number, now: number): string {
  return `<li class="day" role="separator">${escape(dayLabel(at, now))}</li>`;
}

/** A message that is a slash command, which shows in the editor font. */
const COMMAND = /^\/[\w:.-]+(\s|$)/;

/** Raw HTML off, so a reply's text can never inject markup; tables, code spans and fences as GitHub draws them. */
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

/**
 * Which link targets render as links: a web page, a `file:` URL, and a path with no scheme (relative, rooted or a drive letter), which the extension
 * opens; any other scheme, such as `javascript:`, `data:` or `vbscript:`, shows as text. markdown-it's own check rejects `file:`.
 */
export function linkAllowed(url: string): boolean {
  const target = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1]?.toLowerCase();

  return scheme === undefined || /^[a-z]$/.test(scheme) || ['http', 'https', 'file'].includes(scheme);
}

markdown.validateLink = linkAllowed;

/** A copy button: in a code block's corner, or under a reply; it shows a check for a moment once the extension wrote the clipboard. */
function copyButton(action: 'copy-code' | 'copy-reply', label: string): string {
  return `<button class="copy" type="button" data-action="${action}" title="${label}" aria-label="${label} to clipboard"><span class="codicon codicon-copy" aria-hidden="true"></span></button>`;
}

// Each code block sits in a frame with its copy button, as in Claude Code's panel.
for (const rule of ['fence', 'code_block'] as const) {
  const draw = markdown.renderer.rules[rule]!;

  markdown.renderer.rules[rule] = (...args) => `<div class="code-block">${copyButton('copy-code', 'Copy code')}${draw(...args)}</div>`;
}

/** What a reply's copy button copies: its Markdown as the session wrote it, without its tags. */
export function replyText(item: ReplyView): string {
  return item.opening;
}

export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A reply's Markdown as HTML; links keep their target in `data-href`, which the page posts, so the webview itself never navigates. */
export function renderMarkdown(text: string): string {
  return markdown.render(text).replace(/<a href="([^"]*)"/g, (_match, href: string) => `<a href="#" data-href="${href}"`);
}

/**
 * One of our messages: its bubble over one line with its marks and, where the minute changes, its time. Only an error state shows, with why in
 * the tooltip: a message sent or still sending shows only its time, and today none stays in error, since one not sent leaves the conversation.
 */
function message(item: MessageView, stamped: boolean): string {
  // Only an error state shows: a message sent or still sending shows only its time; one not sent has left the conversation.
  const state = item.origin === 'typed' && (item.delivery === 'not-sent' || item.delivery === 'uncertain') ? item.delivery : null;
  const why = item.error === null ? '' : ` · ${item.error}`;
  const delivery =
    state === null ? '' : `<span class="delivery ${state}" title="${escape(`${DELIVERY[state]}${why}`)}">${DELIVERY[state]}</span>`;

  // A message sent in the terminal while the session was busy waits, dimmed, until Claude reads it.
  const queued = item.provisional && item.origin === 'terminal';
  // A dictated message has a mic glyph, its pieces in the tooltip, and a part sent while it was still being spoken says so (architecture.md § Dictation).
  const voice = item.origin === 'voice' ? voiceMark(item) : '';
  // The marks sit at the bubble's left edge and the time at its right, so every time stays flush right in one column.
  const meta = metaLine([voice, delivery], stamped ? item.at : null);

  return `<li class="message${item.provisional ? ' provisional' : ''}" data-id="${escape(item.id)}" tabindex="-1"${queued ? ' title="Sent; Claude has not read it yet"' : ''}><div class="bubble"><div class="box${COMMAND.test(item.text) ? ' command' : ''}">${escape(item.text)}</div>${meta}</div></li>`;
}

/** A dictated message's mark: the mic glyph, "partial" for a part of one still being spoken, and its pieces as the tooltip. */
function voiceMark(item: MessageView): string {
  const pieces = (item.pieces ?? []).map((piece) => `${piece.dropped ? '(dropped) ' : ''}${piece.text}${piece.score === null ? '' : ` · match ${piece.score.toFixed(2)}`}${piece.f0 === null ? '' : ` · ${Math.round(piece.f0)} Hz`}`);
  const dictated = pieces.length === 0 ? 'Dictated' : `Dictated in ${pieces.length} piece${pieces.length === 1 ? '' : 's'}:\n${pieces.join('\n')}`;
  // Spoken over a reply being read aloud, which stopped it (architecture.md § Voice check and barge-in).
  const over = item.interrupted === undefined ? '' : item.interrupted.said === '' ? 'Spoke over the reply before its first words.' : `Spoke over the reply after "${item.interrupted.said}".`;
  const title = over === '' ? dictated : `${dictated}\n${over}`;
  const label = `${item.partial === true ? 'partial' : 'dictated'}${item.interrupted === undefined ? '' : ' · interrupted the reply'}`;

  return `<span class="voice-mark" title="${escape(title)}"><span class="codicon codicon-mic" aria-hidden="true"></span><span>${label}</span></span>`;
}

/** The mark of a reply whose speech failed (architecture.md § Voice); empty otherwise, since routine speech states show nothing. */
export function spokenMark(item: ReplyView): string {
  return item.spoken.state === 'failed'
    ? '<span class="spoken failed" title="Speaking this reply failed; see the voice log."><span class="codicon codicon-mute" aria-hidden="true"></span><span>Not spoken</span></span>'
    : '';
}

/** The passage read aloud; after the operator spoke over it, the part not heard is dimmed, as plain text. */
function passageHtml(item: ReplyView, passage: string): string {
  const said = item.spoken.saidChars;

  if (item.spoken.state !== 'interrupted' || said === null) {
    return renderMarkdown(passage);
  }

  return `<p class="passage">${escape(passage.slice(0, said))}<span class="unheard">${escape(passage.slice(said))}</span></p>`;
}

/**
 * The composer footer's voice controls (architecture.md § Voice), ghost icon buttons as in Claude Code's footer, in one cluster with the mic
 * beside Send: Stop while this window's session speaks and Speak replies as a speaker toggle while the voice is here; one Talk here in their
 * place while it is elsewhere, only for a session it can speak for (`live`). Nothing while voice is off.
 */
export function renderVoiceControls(voice: VoiceView | null, live = true): string {
  if (voice === null || !voice.enabled) {
    return '';
  }

  const icon = (name: string, title: string, data: string, extra = ''): string =>
    `<button class="ghost icon" type="button" data-voice="${data}" title="${escape(title)}" aria-label="${escape(title)}"${extra}><span class="codicon codicon-${name}" aria-hidden="true"></span></button>`;
  const speakReplies = icon(
    voice.speakReplies ? 'unmute' : 'mute',
    voice.speakReplies ? 'Speak replies: on. Click to stop speaking replies.' : 'Speak replies: off. Click to speak replies.',
    'speak-replies',
    ` aria-pressed="${voice.speakReplies}"`,
  );
  const stop = voice.here && voice.speaking !== null ? icon('debug-stop', 'Stop speaking (Escape)', 'stop') : '';
  const talkHere =
    !voice.here && live
      ? '<button class="ghost talk-here" type="button" data-voice="talk-here" title="The voice is not in this window. Click to move it here.">Talk here</button>'
      : '';

  return voice.here ? `${stop}${speakReplies}` : talkHere;
}

/** A mic glyph: slashed while off, outlined, or filled; with a badge while paused, or while half-duplex capture holds it for a reply playing. */
function micGlyph(kind: 'off' | 'outline' | 'filled', badge: 'pause' | 'held' | null = null): string {
  const mic = `<span class="codicon codicon-${kind === 'filled' ? 'mic-filled' : 'mic'}" aria-hidden="true"></span>`;
  const mark = badge === null ? '' : `<span class="mic-badge ${badge}" aria-hidden="true"><span class="codicon codicon-${badge === 'pause' ? 'debug-pause' : 'unmute'}"></span></span>`;

  return `<span class="mic-glyph ${kind}">${mic}${mark}</span>`;
}

/**
 * The composer's one mic button (architecture.md § Dictation), whose glyph and tooltip carry the mic's state, each drawn apart: a slashed mic while
 * off, unavailable or in a window the voice is not in, whose click talks here and turns the mic on; an outlined mic after the idle timeout; a
 * filled mic in the accent colour that pulses while it listens, faster while it hears, and still while it starts; a pause badge while the composer
 * has the focus or another app records; and a speaker badge while half-duplex capture holds it for a reply playing. While the mic is on, in any
 * state, a click turns it off. Empty with voice off.
 */
export function renderMicButton(voice: VoiceView | null): string {
  if (voice === null || !voice.enabled) {
    return '';
  }

  const button = (glyph: string, title: string, on: boolean, kind: string): string =>
    `<button class="mic ${kind}" type="button" data-voice="mic" data-on="${on}" title="${escape(title)}" aria-label="${escape(title)}" aria-pressed="${!on}">${glyph}</button>`;

  // While the voice is elsewhere, Talk here takes the cluster's place (renderVoiceControls).
  if (!voice.here) {
    return '';
  }

  // Where recognition runs, once the recogniser loaded; half-duplex capture does not listen while the voice speaks, and full duplex with no echo
  // cancellation says why it does (architecture.md § Dictation).
  const where = voice.recognizer === null ? '' : ` Speech recognition runs on the ${voice.recognizer === 'gpu' ? 'GPU' : 'CPU'}.`;
  const halfDuplex = voice.halfDuplex !== undefined ? ` Listening pauses while a reply plays (${voice.halfDuplex}), so talking over it does not stop it.` : voice.fullDuplex !== undefined ? ` Full duplex (${voice.fullDuplex}): talking over a reply stops it.` : '';
  // The room hold (architecture.md § Voice check and barge-in): spoken turns stay in the box.
  const held = voice.roomHold === true ? ` ${ROOM_HOLD_TIP}` : '';

  // Half-duplex capture holding the mic while this window's reply plays.
  if (voice.halfDuplex !== undefined && voice.speaking !== null && (voice.mic === 'listening' || voice.mic === 'hearing')) {
    return button(micGlyph('filled', 'held'), `Mic on, held while the reply plays (${voice.halfDuplex}): it listens again when the reply ends.${where} Click to turn the mic off.`, false, 'held');
  }

  switch (voice.mic) {
    case 'listening':
      return button(micGlyph('filled'), `Mic on: listening. ${held === '' ? 'Dictation sends when you stop talking.' : ROOM_HOLD_TIP}${where}${halfDuplex} Click to turn the mic off.`, false, 'listening');
    case 'hearing':
      return button(micGlyph('filled'), `Mic on: hearing you.${held}${where}${halfDuplex} Click to turn the mic off.`, false, 'hearing');
    case 'typing':
      return button(micGlyph('outline', 'pause'), `Mic paused while you type: dictation goes on when you send or leave the box.${where} Click to turn the mic off.`, false, 'paused');
    case 'starting':
      return button(micGlyph('filled'), 'Mic starting. Click to turn it off.', false, 'starting');
    case 'paused-other-app':
      return button(micGlyph('outline', 'pause'), `Mic paused: another app is using the microphone.${where} Click to turn the mic off.`, false, 'paused');
    case 'paused-by-voice':
      // Only "start listening" is heard: a click listens again rather than turning the mic off.
      return button(micGlyph('outline', 'pause'), `Mic ${PAUSED_BY_VOICE_TIP.charAt(0).toLowerCase()}${PAUSED_BY_VOICE_TIP.slice(1)}`, true, 'paused');
    case 'unavailable':
      // The mic is on but cannot run: a click turns it off, and turning it on again tries again.
      return button(micGlyph('off'), `Mic on but unavailable: ${voice.error ?? 'unknown error'} Click to turn the mic off.`, false, 'unavailable');
    case 'idle-off':
      return button(micGlyph('outline'), 'Mic off after a quiet spell. Click to turn it on (Ctrl+Alt+M).', true, 'idle');
    default:
      return button(micGlyph('off'), 'Mic off. Click to turn it on (Ctrl+Alt+M).', true, 'off');
  }
}

/** The fold key of a reply's Show more, which flips its start, collapsed in focused mode or expanded with `voice.expandReplies`. */
export const moreKey = (id: string): string => `more:${id}`;

function reply(item: ReplyView, earlier: ReplyView | null, open: ReadonlySet<string>, stamped: boolean, card = '', expandReplies = false): string {
  if (item.kind === 'note') {
    return `<li class="note" data-id="${escape(item.id)}" tabindex="-1">${escape(item.opening)}</li>`;
  }

  // Focused mode (voice-design decision 21): a reply with a [speak] passage shows the passage first, the whole reply behind Show more.
  const passage = item.kind === 'reply' && item.speak !== null && item.speak.trim() !== '' ? item.speak : null;
  const folded = passage !== null && passage.trim() !== item.opening.trim();
  const expanded = !folded || expandReplies !== open.has(moreKey(item.id));
  const shown = passage !== null && !expanded ? passageHtml(item, passage) : card === '' ? renderMarkdown(item.opening) : withoutQuestions(item.opening, `reply:${item.id}`, open);
  const more = folded
    ? `<button class="show-more" type="button" data-action="more" data-reply="${escape(item.id)}" aria-expanded="${expanded}">${expanded ? 'Show less' : 'Show more'}</button>`
    : '';
  const tone = item.tone === null ? '' : `<span class="tone" title="${escape(`How the reply sounds when spoken: ${item.tone}`)}">${escape(item.tone)}</span>`;

  const rewritten =
    earlier === null
      ? ''
      : `<details class="fold earlier" data-fold="earlier:${escape(item.id)}"${open.has(`earlier:${item.id}`) ? ' open' : ''}><summary>Rewritten</summary><div class="was">${renderMarkdown(earlier.opening)}</div></details>`;

  // A reply read off the screen has no copy button until its transcript copy replaces it, as Claude Code's has none while it streams. The copy
  // button comes first on the line under the reply, then the tone and a speech failure, and the time at the right.
  const meta = metaLine([item.provisional ? '' : copyButton('copy-reply', 'Copy response'), tone, spokenMark(item)], stamped ? item.at : null);

  // An unread reply's dot takes the badge colour until the view has shown it in a focused window for a second (architecture.md § Unread).
  const unread = item.unread ? ` unread" data-unread="${escape(item.id)}` : '';
  const dot = item.unread ? '<span class="dot" title="Unread"><span class="unread-label">Unread</span></span>' : '<span class="dot"></span>';

  return `<li class="reply ${item.kind}${unread}" data-id="${escape(item.id)}"${passage === null ? '' : ' data-speak="1"'} tabindex="-1">${dot}<div class="body">${shown}${more}${rewritten}</div>${meta}${card}</li>`;
}

/**
 * A reply's or a status's Markdown when its card draws its questions (architecture.md § Conversation view): questions that end it, as the rules
 * ask, are left out, so the text does not repeat them cut up; questions with text after them, against the rules, stay in place folded into one
 * line, "2 questions — answer below", that opens them.
 */
export function withoutQuestions(markdown: string, key: string, open: ReadonlySet<string>): string {
  const segments = questionSegments(markdown);

  if (segments === null) {
    return renderMarkdown(markdown);
  }

  // The last run of questions, when only blank lines follow it, ends the message as the rules ask, and the card alone shows it.
  const last = segments.reduce((found, segment, index) => (segment.questions > 0 ? index : found), -1);
  const ending = segments.slice(last + 1).every((segment) => segment.text.trim() === '');

  return segments
    .map((segment, index) => {
      if (segment.questions === 0) {
        return segment.text.trim() === '' ? '' : renderMarkdown(segment.text);
      }

      if (ending && index === last) {
        return '';
      }

      const fold = `questions:${key}:${index}`;

      return `<details class="fold questions-fold" data-fold="${escape(fold)}"${open.has(fold) ? ' open' : ''}><summary>${segment.questions} question${segment.questions === 1 ? '' : 's'} — answer below</summary><div class="was">${renderMarkdown(segment.text)}</div></details>`;
    })
    .join('');
}

/** What the page keeps of a question card the operator has not answered yet: the choices made, and the answer being sent or refused. */
export interface CardDraft {
  choices: Map<number, QuestionChoice>;
  /** The text sent with Submit, until the message shows in the conversation or comes back not sent. */
  sent: string | null;
  /** The work item whose conversation the answer was sent in. */
  workItemId: number | null;
  sending: boolean;
  error: string | null;
}

/** A card's key: the reply or the status that asks its questions. */
export function cardKey(kind: 'reply' | 'status', id: string): string {
  return `${kind}:${id}`;
}

/** Inline Markdown, as a reply's, for a question or an option. */
function inlineMarkdown(text: string): string {
  return markdown.renderInline(text).replace(/<a href="([^"]*)"/g, (_match, href: string) => `<a href="#" data-href="${href}"`);
}

/**
 * A question card (architecture.md § Conversation view), in the style of Claude Code's question form: each question in the foreground, its options
 * as rows with a radio mark, or a checkbox where it takes several, the letter dimmed before the text, an Other field, and Submit. Answered, by
 * Submit or by any later message, it greys out and shows the choices that message gave. It takes no answer while the composer could not send.
 */
export function questionCard(key: string, questions: readonly Question[], draft: CardDraft | undefined, answer: string | null, canAnswer: boolean): string {
  // A later message answers the card only when it answers its questions; one that ignores them sets the card aside, Skipped, with no picks.
  const outcome = cardOutcome(answer, questions);
  const answered = outcome !== null;
  const choices = outcome === 'answered' ? answersIn(answer!, questions) : answered ? new Map<number, QuestionChoice>() : (draft?.choices ?? new Map<number, QuestionChoice>());
  const locked = answered || !canAnswer || draft?.sending === true || draft?.sent != null;
  const blocks = questions.map((question, index) => {
    const choice = choices.get(index);
    const multi = question.multi;
    const label = question.number === null ? '' : `<span class="question-number">${question.number}.</span> `;
    const options = question.options
      .map((option) => {
        const checked = choice?.letters.includes(option.letter) ?? false;
        const mark = multi ? `<span class="question-mark checkbox${checked ? ' checked' : ''}" aria-hidden="true">${checked ? '<span class="codicon codicon-check"></span>' : ''}</span>` : `<span class="question-mark radio${checked ? ' checked' : ''}" aria-hidden="true">${checked ? '<span class="radio-dot"></span>' : ''}</span>`;
        const name = `${question.number === null ? '' : question.number}${option.letter}`;

        return (
          `<button type="button" class="question-option${checked ? ' checked' : ''}${answered && !checked ? ' dimmed' : ''}" role="${multi ? 'checkbox' : 'radio'}" aria-checked="${checked}" data-action="pick" data-card="${escape(key)}" data-question="${index}" data-letter="${option.letter}"${locked ? ' disabled' : ''} title="${escape(`Answer ${name}`)}">` +
          `${mark}<span class="question-option-text"><span class="question-letter">${option.letter}</span> ${inlineMarkdown(option.text)}</span></button>`
        );
      })
      .join('');
    const given = answered && choice !== undefined && choice.other !== '' ? `<div class="question-answer-other"><span class="question-letter">Other:</span> ${escape(choice.other)}</div>` : '';
    const other = answered || !canAnswer ? given : `<input class="question-other" type="text" data-card="${escape(key)}" data-question="${index}" placeholder="Other…" aria-label="${escape(`Other answer${question.number === null ? '' : ` to question ${question.number}`}`)}" value="${escape(choice?.other ?? '')}"${locked ? ' disabled' : ''}>`;

    return `<div class="question-block"><div class="question-text">${label}${inlineMarkdown(question.text)}</div><div class="question-options" role="${multi ? 'group' : 'radiogroup'}">${options}${other}</div></div>`;
  });
  const text = complete(questions, choices) ? answerText(questions, choices) : '';
  const footer = answered
    ? `<div class="question-footer"><span class="question-state">${outcome === 'answered' ? 'Answered' : 'Skipped: your next message did not answer these questions'}</span></div>`
    : !canAnswer
      ? ''
      : `<div class="question-footer">${draft?.error == null ? '' : `<span class="question-error" role="alert">${escape(draft.error)}</span>`}<button type="button" class="question-submit" data-action="answer" data-card="${escape(key)}"${locked || text === '' ? ' disabled' : ''} title="${escape(text === '' ? 'Answer every question first' : `Send "${text}"`)}">${draft?.sending === true || draft?.sent != null ? 'Sending…' : 'Submit'}</button></div>`;

  return `<div class="question-card${answered ? ` ${outcome}` : ''}" data-card="${escape(key)}" role="group" aria-label="${outcome === 'answered' ? 'Questions, answered' : outcome === 'skipped' ? 'Questions, skipped' : 'Questions'}">${blocks.join('')}${footer}</div>`;
}

/** An artifact as a one-line row where it was written: it opens, it does not expand (architecture.md § Conversation view). */
function artifactRow(artifact: ArtifactView): string {
  return (
    `<li class="artifact" data-id="artifact:${escape(artifact.path)}" data-path="${escape(artifact.path)}" tabindex="-1">` +
    `<button class="artifact-open" type="button" data-action="artifact" data-path="${escape(artifact.path)}" title="${escape(`Open ${artifact.path}`)}" aria-label="${escape(`Open artifact: ${artifact.title}`)}">` +
    `<span class="codicon codicon-${artifactIcon(artifact.type)}" aria-hidden="true"></span><span class="artifact-title">${escape(artifact.title)}</span><span class="artifact-kind">${escape(artifact.kind)}</span></button></li>`
  );
}

/** How long ago a status or an artifact was written, as the Status and Artifacts tabs say it: "just now", "4 min ago", "2 h ago", "3 d ago". */
export function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);

  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 24 * 60 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / (24 * 60))} d ago`;
}

/** The view's tabs (architecture.md § Conversation view): the conversation, the status and the artifacts, each taking the view's full height. */
export type Tab = 'conversation' | 'status' | 'artifacts';
export const TABS: ReadonlyArray<{ tab: Tab; label: string }> = [
  { tab: 'conversation', label: 'Conversation' },
  { tab: 'status', label: 'Status' },
  { tab: 'artifacts', label: 'Artifacts' },
];

/**
 * What the page adds to the state to draw it: the tab shown, the artifacts new or changed since they were last opened in the workspace, and the
 * question cards' choices by card key.
 */
export interface PageView {
  tab: Tab;
  unopened: ReadonlySet<string>;
  cards?: ReadonlyMap<string, CardDraft>;
  /** Whether the New messages pill shows: new items came below a conversation scrolled up. */
  pill?: boolean;
  /** The header menu open, if any. */
  menu?: HeaderMenu | null;
  /** The earlier statuses listed on the Status tab, while their list is open. */
  earlier?: EarlierStatuses | null;
  /** The Codex requests' answers and refusals. */
  requests?: RequestDrafts;
}

/** The Status tab's list of the session's earlier statuses, newest first, while it is open; `more` while older ones can be loaded. */
export interface EarlierStatuses {
  statuses: StatusView[];
  more: boolean;
  loading: boolean;
  error: string | null;
}

const NO_REQUESTS: RequestDrafts = { values: new Map(), errors: new Map(), sending: new Set() };

const CONVERSATION_TAB: PageView = { tab: 'conversation', unopened: new Set() };

/** A status's time on the Status tab: "Thu, Nov 19, 1:46 PM". */
const STATUS_TIME = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** An age that the page redraws every 30 seconds. */
function age(at: number, now: number, className: string): string {
  return `<time class="${className} age" data-at="${at}" datetime="${new Date(at).toISOString()}">${ago(at, now)}</time>`;
}

/** Whether the Status tab's badge shows: the latest status is New, or unread (architecture.md § Unread); never the stage. */
export function statusBadge(status: StatusView | null, fresh: boolean): boolean {
  return status !== null && !status.fallback && (fresh || status.unread);
}

/**
 * The Status tab (architecture.md § Statuses): the session's latest status as Markdown under a line with its time, how long ago, a New mark while
 * `fresh`, and the buttons that open it and the earlier statuses in the Markdown preview. Before the first status, the work item's stage, dimmed;
 * with neither, a line that says so.
 */
export function renderStatus(status: StatusView | null, fresh: boolean, now: number, card = '', open: ReadonlySet<string> = new Set(), earlier: EarlierStatuses | null = null): string {
  if (status === null) {
    return '<p class="empty">No status yet. It appears here when the session reports one.</p>';
  }

  if (status.fallback) {
    return (
      '<div class="status-tab fallback"><p class="empty">No status yet. Until the session reports one, the work item\'s stage:</p>' +
      `<div class="status-head"><span class="codicon codicon-pulse" aria-hidden="true"></span><span class="status-label">Stage</span><span class="status-dot" aria-hidden="true">·</span>${age(status.at, now, 'status-age')}</div>` +
      `<div class="status-body body">${renderMarkdown(status.markdown)}</div></div>`
    );
  }

  const mark = fresh ? '<span class="status-new">New</span>' : '';
  const actions =
    '<span class="status-actions"><button class="icon" type="button" data-action="status-open" title="Open in the Markdown preview" aria-label="Open the status in the Markdown preview"><span class="codicon codicon-open-preview" aria-hidden="true"></span></button>' +
    `<span class="menu-anchor"><button class="icon${earlier === null ? '' : ' pressed'}" type="button" data-action="statuses" title="Earlier statuses" aria-label="Earlier statuses" aria-haspopup="menu" aria-expanded="${earlier !== null}"><span class="codicon codicon-history" aria-hidden="true"></span></button>${earlierStatuses(earlier)}</span></span>`;
  const time = `<span class="status-time" title="${escape(fullTime(status.at))}">${escape(STATUS_TIME.format(status.at))}</span>`;
  const unread = status.unread ? ` unread" data-unread="${escape(status.id)}` : '';

  return (
    `<div class="status-tab${fresh ? ' fresh' : ''}${unread}" role="region" aria-label="${unread === '' ? 'Status' : 'Status, unread'}">` +
    `<div class="status-head"><span class="codicon codicon-pulse" aria-hidden="true"></span>${time}<span class="status-dot" aria-hidden="true">·</span>${age(status.at, now, 'status-age')}${mark}${actions}</div>` +
    `<div class="status-body body">${card === '' ? renderMarkdown(status.markdown) : withoutQuestions(status.markdown, `status:${status.id}`, open)}</div>${card}</div>`
  );
}

/** A status's time in the earlier statuses list: "Thu, Nov 19, 1:46 PM". */
const EARLIER_TIME = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * The Status tab's earlier statuses (architecture.md § Statuses), a menu right-aligned under its history button: each status's first line with
 * its time as the row's note, newest first, a click opening it in the Markdown preview, and Older statuses after a separator while there are more.
 */
function earlierStatuses(earlier: EarlierStatuses | null): string {
  if (earlier === null) {
    return '';
  }

  const rows = earlier.statuses
    .map((status) => `<li role="none"><button type="button" class="menu-row earlier-status" role="menuitem" data-action="status-earlier" data-status="${escape(status.id)}" title="Open in the Markdown preview">${gutter(null)}<span class="title">${escape(statusLine(status.markdown) || 'Status')}</span><span class="menu-note">${escape(EARLIER_TIME.format(status.at))}</span></button></li>`)
    .join('');
  const message = (text: string, alert = false): string => `<li class="menu-message"${alert ? ' role="alert"' : ' role="none"'}>${escape(text)}</li>`;
  const foot =
    earlier.error !== null
      ? message(earlier.error, true)
      : earlier.loading
        ? message('Loading…')
        : earlier.statuses.length === 0
          ? message('No earlier statuses yet. A status moves here when the session reports a newer one.')
          : earlier.more
            ? `${SEPARATOR}<li role="none"><button type="button" class="menu-row" role="menuitem" data-action="statuses-more">${gutter(null)}<span class="title">Older statuses</span></button></li>`
            : '';

  return `<ul class="glass menu earlier-menu align-right" id="earlier-statuses" data-key="menu-earlier" role="menu" aria-label="Earlier statuses">${rows}${foot}</ul>`;
}

/**
 * The Artifacts tab (architecture.md § Artifacts): the work item's artifacts newest first, each a row with its type's codicon, title, kind and age,
 * marked while new or changed since last opened in the workspace; a click opens it natively.
 */
export function renderArtifacts(artifacts: readonly ArtifactView[], unopened: ReadonlySet<string>, now: number): string {
  if (artifacts.length === 0) {
    return '<p class="empty">No artifacts yet. They appear here when the session writes one.</p>';
  }

  const rows = artifacts.map((artifact) => {
    const fresh = unopened.has(artifact.path);
    const label = `Open artifact: ${artifact.title}, ${artifact.kind}${fresh ? ', new or changed' : ''}`;

    return (
      `<li class="artifact-item${fresh ? ' unopened' : ''}"><button class="artifact-open" type="button" data-action="artifact" data-path="${escape(artifact.path)}" title="${escape(`${artifact.path}\nUpdated ${new Date(artifact.updatedAt).toLocaleString()}`)}" aria-label="${escape(label)}">` +
      `<span class="codicon codicon-${artifactIcon(artifact.type)}" aria-hidden="true"></span><span class="artifact-title">${escape(artifact.title)}</span>` +
      `<span class="artifact-kind">${escape(artifact.kind)} · ${age(artifact.updatedAt, now, 'artifact-age')}</span>${fresh ? '<span class="artifact-new" aria-hidden="true"></span>' : ''}</button></li>`
    );
  });

  return `<ul class="artifact-list" aria-label="Artifacts">${rows.join('')}</ul>`;
}

/** The tab strip, as VS Code's panel tabs: the selected tab underlined; Status with a New badge, Artifacts with the count of new or changed ones. */
function renderTabs(selected: Tab, badges: Record<Tab, string>): string {
  const tabs = TABS.map(({ tab, label }) => {
    const badge = badges[tab] === '' ? '' : `<span class="tab-badge">${escape(badges[tab])}</span>`;
    const name = badges[tab] === '' ? label : `${label}, ${tab === 'status' ? 'new status' : `${badges[tab]} new or changed`}`;

    return `<button class="tab${tab === selected ? ' selected' : ''}" type="button" role="tab" id="tab-${tab}" data-tab="${tab}" aria-selected="${tab === selected}" aria-controls="panel" aria-label="${escape(name)}" tabindex="${tab === selected ? 0 : -1}"><span class="tab-label">${label}</span>${badge}</button>`;
  });

  return `<nav class="tabs" role="tablist" aria-label="Switchboard">${tabs.join('')}</nav>`;
}

/** The fold key of the header's conversation list, which the page opens and closes. */
export const PICKER = 'conversations';

/** A state's codicon with its text for a screen reader. */
function codicon({ icon, text }: { icon: string; text: string }): string {
  const [name, modifier] = icon.split('~');

  return `<span class="codicon codicon-${name}${modifier === undefined ? '' : ` codicon-modifier-${modifier}`}" title="${escape(text)}" aria-label="${escape(text)}"></span>`;
}

/** A menu row's left gutter: a check mark for the chosen row, or another codicon, or nothing, so every row's text starts in one column. */
function gutter(icon: string | null): string {
  return `<span class="menu-gutter" aria-hidden="true">${icon === null ? '' : `<span class="codicon codicon-${icon}"></span>`}</span>`;
}

/** A thin line between groups of a menu's rows. */
const SEPARATOR = '<li class="menu-separator" role="separator"></li>';

/**
 * A conversation as the dropdown's button and each of its rows draw it, from this one renderer so they never differ (architecture.md §
 * Conversation view): its session's state codicon, its title and its provider's mark; no unread count, as on the web page and the dock.
 */
export function conversationLabel(entry: ConversationEntry, state: ConversationState): string {
  const selected = entry.workItemId === state.scope?.workItemId;
  // The selected conversation's state and provider come from its current session, which the view follows more closely than the entry.
  const icon = selected ? stateIcon(state.session) : stateIcon(entry.state === null ? null : ({ state: entry.state, waitingFor: null } as never));

  return `${codicon(icon)}<span class="title">${escape(entry.title)}</span>${providerMark(selected ? (state.session?.provider ?? entry.provider) : entry.provider)}`;
}

/**
 * The header's conversation dropdown (architecture.md § Conversation view): a button that shows the selected conversation as its rows do, then
 * a chevron, and opens the menu of the window's conversations, the primary work item first, the selected one highlighted rather than checked, since
 * an idle session's state codicon is already a check, then New conversation…,
 * which opens the providers' menu under the same button. A folder window with no conversation yet shows its folder's name.
 */
function picker(state: ConversationState, open: boolean, menu: HeaderMenu | null): string {
  const scope = state.scope!;
  const selected = selectedEntry(state);
  const title = selected?.title ?? scope.title;
  const rows = scope.conversations.map((entry) => {
    const chosen = entry.workItemId === scope.workItemId;

    return `<li role="none"><button type="button" class="menu-row conversation-row" role="menuitemradio" aria-checked="${chosen}" data-action="select" data-work-item="${entry.workItemId}">${conversationLabel(entry, state)}</button></li>`;
  });
  const create = `<li role="none"><button type="button" class="menu-row" role="menuitem" data-action="new" aria-haspopup="menu">${gutter('add')}<span class="title">New conversation…</span></button></li>`;
  const list = open ? `<ul class="glass menu conversation-menu" data-key="menu-conversations" role="menu" aria-label="Conversations">${rows.join('')}${rows.length > 0 ? SEPARATOR : ''}${create}</ul>` : '';
  const label = selected === null ? `<span class="codicon codicon-folder" aria-hidden="true"></span><span class="title">${escape(title)}</span>` : conversationLabel(selected, state);
  const button = `<button type="button" class="picker" data-action="picker" aria-haspopup="menu" aria-expanded="${open}" title="${escape(title)}">${label}<span class="codicon codicon-chevron-down" aria-hidden="true"></span></button>`;

  return `<div class="menu-anchor picker-anchor">${button}${list}${menu?.kind === 'provider' ? headerMenu(menu) : ''}</div>`;
}

/**
 * The header's persona button (architecture.md § Personas): an icon, `pinned` or `person`, with the persona's name in its tooltip and accessible
 * name, which opens the list to pin another; a plain `person` for a session with none that can take a pin; nothing otherwise.
 */
export function personaButton(persona: SessionView['persona'] | undefined, expanded = false, canPin = false): string {
  if (persona == null) {
    const none = 'No persona. Click to choose one.';

    return canPin ? `<button type="button" class="persona" data-action="persona" aria-haspopup="menu" aria-expanded="${expanded}" title="${none}" aria-label="${none}"><span class="codicon codicon-person" aria-hidden="true"></span></button>` : '';
  }

  const title = [`Persona: ${persona.name}${persona.pinned ? ', pinned to this session' : ''}.`, persona.tonePending ? 'Its tone changes when the session next resumes or compacts.' : '', 'Click to choose another.'].filter((part) => part !== '').join(' ');

  return `<button type="button" class="persona${persona.tonePending ? ' pending' : ''}" data-action="persona" aria-haspopup="menu" aria-expanded="${expanded}" title="${escape(title)}" aria-label="${escape(title)}"><span class="codicon codicon-${persona.pinned ? 'pinned' : 'person'}" aria-hidden="true"></span></button>`;
}

/** A menu the header opens (architecture.md § Conversation view): the persona roster to pin from, or the providers a new conversation can use. */
export interface HeaderMenu {
  kind: 'persona' | 'provider';
  /** Null while the extension fetches them. */
  items: Array<{ value: string; label: string; note: string; current: boolean }> | null;
  error: string | null;
}

/**
 * A header menu under its button, drawn as the conversation dropdown is: one row per choice, the current one checked, a choice's note muted at
 * the right; Clear pin after a separator, with what it does in its tooltip.
 */
function headerMenu(menu: HeaderMenu): string {
  const note = (text: string): string => `<li class="menu-message" role="none">${escape(text)}</li>`;
  const rows =
    menu.error !== null
      ? note(menu.error)
      : menu.items === null
        ? note('Loading…')
        : menu.items.length === 0
          ? note(menu.kind === 'persona' ? 'No personas. Add them to voice.personas in settings.json, with voice.enabled on.' : 'No providers.')
          : menu.items
              .map((item) => {
                // Clearing a pin is no persona: it follows the roster after a separator, and says what it does in its tooltip.
                const clear = menu.kind === 'persona' && item.value === '';
                const aside = item.note === '' ? '' : clear ? ` title="${escape(item.note)}"` : '';
                const shown = item.note === '' || clear ? '' : `<span class="menu-note">${escape(item.note)}</span>`;

                return (
                  `${clear ? SEPARATOR : ''}<li role="none"><button type="button" class="menu-row" role="${clear ? 'menuitem' : 'menuitemradio'}"${clear ? '' : ` aria-checked="${item.current}"`} data-action="menu-pick" data-menu="${menu.kind}" data-value="${escape(item.value)}"${aside}>` +
                  `${gutter(item.current ? 'check' : null)}<span class="title">${escape(item.label)}</span>${shown}</button></li>`
                );
              })
              .join('');

  return `<ul class="glass menu header-menu${menu.kind === 'persona' ? ' align-right' : ''}" data-key="menu-${menu.kind}" role="menu" aria-label="${menu.kind === 'persona' ? 'Persona' : 'New conversation'}">${rows}</ul>`;
}

const DECISIONS: Record<string, string> = { accept: 'Allow once', acceptForSession: 'Allow for session', decline: 'Decline', cancel: 'Cancel' };

/** What the page keeps of the Codex requests it shows: the answers picked or typed by `<request ID>:<question ID>`, and why one was refused. */
export interface RequestDrafts {
  values: ReadonlyMap<string, string>;
  errors: ReadonlyMap<string, string>;
  sending: ReadonlySet<string>;
}

/**
 * A Codex session's pending request as a card at the end of the conversation (architecture.md § Conversation view), in the question card's
 * style: a permission with its decisions as buttons; questions with their options and a field for a typed answer, a secret one hidden, and
 * Submit; one the view cannot answer, with Open in terminal.
 */
export function requestCard(request: NativeRequest, drafts: RequestDrafts): string {
  const icon = request.kind === 'permission' ? 'shield' : request.kind === 'question' ? 'question' : 'terminal';
  const head = `<div class="request-title"><span class="codicon codicon-${icon}" aria-hidden="true"></span><span class="request-text">${escape(request.title)}</span></div>`;
  const busy = drafts.sending.has(request.id);
  const error = drafts.errors.get(request.id);
  const why = error === undefined ? '' : `<span class="question-error" role="alert">${escape(error)}</span>`;
  const card = (body: string): string => `<li class="request-item" data-key="request-${escape(request.id)}"><div class="question-card request" data-request-card="${escape(request.id)}" role="group" aria-label="${request.kind === 'permission' ? 'Permission request' : 'Question from Codex'}">${body}</div></li>`;

  if (request.kind === 'unsupported') {
    return card(`${head}<div class="question-footer"><span class="question-state">Answer it in the terminal.</span><button type="button" class="terminal-question-open" data-action="terminal">Open in terminal</button></div>`);
  }

  if (request.kind === 'permission') {
    const buttons = request.decisions.map((decision) => `<button type="button" class="request-button${decision === 'accept' ? ' primary' : ''}" data-action="request-decision" data-request="${escape(request.id)}" data-decision="${escape(decision)}"${busy ? ' disabled' : ''}>${escape(DECISIONS[decision] ?? decision)}</button>`).join('');

    return card(`${head}<div class="question-footer">${why}${buttons}</div>`);
  }

  const fields = request.questions.map((question) => {
    const key = `${request.id}:${question.id}`;
    const value = drafts.values.get(key) ?? '';
    const options = question.options
      .map((option) => `<button type="button" class="question-option" role="radio" aria-checked="${value === option}" data-action="request-option" data-field="${escape(key)}" data-value="${escape(option)}"${busy ? ' disabled' : ''}><span class="question-mark radio${value === option ? ' checked' : ''}" aria-hidden="true">${value === option ? '<span class="radio-dot"></span>' : ''}</span><span class="question-option-text">${escape(option)}</span></button>`)
      .join('');

    return `<div class="question-block" data-key="${escape(key)}"><div class="question-text">${escape(question.question)}</div><div class="question-options" role="radiogroup" aria-label="${escape(question.question)}">${options}<input class="question-other request-field" type="${question.secret === true ? 'password' : 'text'}" data-field="${escape(key)}" placeholder="${question.options.length === 0 ? 'Answer…' : 'Other…'}" aria-label="${escape(question.question)}" value="${question.options.includes(value) ? '' : escape(value)}"${busy ? ' disabled' : ''}></div></div>`;
  });
  const ready = request.questions.every((question) => (drafts.values.get(`${request.id}:${question.id}`) ?? '').trim() !== '');

  return card(`${head}${fields.join('')}<div class="question-footer">${why}<button type="button" class="question-submit" data-action="request-answer" data-request="${escape(request.id)}"${busy || !ready ? ' disabled' : ''}>${busy ? 'Sending…' : 'Submit'}</button></div>`);
}

/**
 * The row at the end of the timeline while the session is in a turn (architecture.md § Conversation view): drawn as Claude Code's spinner row,
 * "Starting…" or "Thinking…" while it works on a reply; while it waits on the operator, whether or not a reply is due, "Waiting for your answer",
 * "Waiting for permission" or "Waiting in the terminal" with a still icon in the warning colour and Open in terminal, where the operator answers.
 * Empty otherwise; a Codex request the view answers itself draws its own card instead.
 */
export function turnRow(session: SessionView | null, awaiting: boolean): string {
  const waiting = session?.state === 'waiting' && session.waitingFor !== null && (session.requests ?? []).length === 0;

  if (waiting) {
    const label = session.waitingFor === 'question' ? 'Waiting for your answer' : session.waitingFor === 'permission' ? 'Waiting for permission' : 'Waiting in the terminal';
    const icon = session.waitingFor === 'permission' ? 'shield' : session.waitingFor === 'question' ? 'question' : 'terminal';
    const who = session.provider === 'codex' ? 'Codex' : 'Claude';
    const why = session.waitingFor === 'question' ? `${who} asks you a question in the terminal.` : session.waitingFor === 'permission' ? `${who} asks for permission in the terminal.` : `${who} is waiting for you in the terminal.`;

    return (
      `<li class="working waiting" title="${escape(why)}"><span class="working-icon codicon codicon-${icon}" aria-hidden="true"></span><span class="working-label">${label}</span>` +
      `<span role="status">${escape(`${label}. ${why}`)}</span><button type="button" class="terminal-question-open" data-action="terminal">Open in terminal</button></li>`
    );
  }

  if (!awaiting || session === null || (session.requests ?? []).length > 0) {
    return '';
  }

  const label = session.state === 'starting' ? 'Starting' : 'Thinking';

  // As Claude Code's panel draws it: the spinner and "Thinking…" beside it; a screen reader hears "Thinking". A turn that waits with nothing for
  // the operator to answer here stands still.
  return `<li class="working"><span class="working-icon codicon codicon-loading${session.state === 'waiting' ? '' : ' codicon-modifier-spin'}" aria-hidden="true"></span><span class="working-label" aria-hidden="true">${label}…</span><span role="status">${label}</span></li>`;
}

/**
 * The view's HTML: the header with the session's state, the tab strip, and the selected tab: the conversation, with a note when the view cannot
 * talk to the session, and the timeline; the status; or the artifacts.
 */
export function renderConversation(state: ConversationState, open: ReadonlySet<string> = new Set(), now: number = Date.now(), fresh = false, page: PageView = CONVERSATION_TAB): string {
  if (state.scope === null) {
    return `<p class="empty">${state.connected ? 'No Switchboard conversation in this window. Open a work item from the dock to work on it here.' : 'Connecting to Switchboard…'}</p>`;
  }

  const menu = page.menu ?? null;

  // A folder window with no conversation yet: the dropdown with the folder's name, whose New conversation… starts one (architecture.md § Conversation view).
  if (state.scope.workItemId === null) {
    return `<header class="header">${picker(state, open.has(PICKER), menu)}</header><p class="empty">No conversation in this folder yet. Start one with New conversation… in the menu above.</p>`;
  }

  // The header: the dropdown, the persona as an icon, and Open in terminal (voice-design report IA-1).
  const personaIcon = personaButton(state.session?.persona, menu?.kind === 'persona', state.session?.canPin === true);
  const persona = personaIcon === '' ? '' : `<div class="menu-anchor persona-anchor">${personaIcon}${menu?.kind === 'persona' ? headerMenu(menu) : ''}</div>`;
  const header = `<header class="header">${picker(state, open.has(PICKER), menu)}${persona}${state.session?.conversation === 'none' ? '' : '<button class="icon" data-action="terminal" title="Open in terminal" aria-label="Open in terminal"><span class="codicon codicon-terminal"></span></button>'}</header>`;
  // An ended session's reason sits just above the composer it disables, on every tab, with Resume; any other reason heads the conversation.
  // A Codex session that ended has no reason, since a message resumes it, but gets the note and Resume too.
  const ended = state.session?.state === 'ended';
  const notes = state.session?.reason == null || ended ? [] : [state.session.reason];
  const endedNote = !ended
    ? ''
    : `<div class="session-note" role="status"><span class="codicon codicon-debug-stop" aria-hidden="true"></span><span class="session-note-text">${escape(state.session!.reason ?? 'The session has ended. A message or Resume continues it.')}</span>${state.session!.conversation === 'none' ? '' : '<button type="button" class="terminal-question-open" data-action="terminal" title="Resume the session in its terminal">Resume</button>'}</div>`;
  const shown = timeline(state.items, state.artifacts);
  // A card's answer is the first message after the reply or status that asks it, sent with Submit or typed (voice-design § 5).
  const canAnswer = state.connected && state.session?.conversation === 'full';
  // Found in conversation order, not the timeline's, where a rewrite takes the place of the reply it rewrote.
  const answerAfter = (replyId: string): string | null => {
    // A message still on its way, which may come back not sent, leaves the card as it is.
    const later = state.items.slice(state.items.findIndex((item) => item.id === replyId) + 1).find((item) => item.type === 'message' && answers(item));

    return later?.type === 'message' ? later.text : null;
  };
  const cardOf = (key: string, markdown: string, answer: string | null): string => {
    const questions = parseQuestions(markdown);

    return questions.length === 0 ? '' : questionCard(key, questions, page.cards?.get(key), answer, canAnswer);
  };
  // The turn's row after the newest item, so replies written mid-turn show above it; it has no data-id, so the keys skip it.
  const spinner = turnRow(state.session, awaitingReply(state.items, state.session));
  // A turn starts at each message; the first item shown, and each turn that starts on another day than the turn before it, has a divider.
  let turnDay: string | null = null;
  // A time shows only where the minute changes from the item before, so a message and the reply to it in the same minute read as one exchange.
  let lastMinute: string | null = null;
  const entries = shown.map((entry) => {
    if (entry.type === 'artifact') {
      return artifactRow(entry.artifact);
    }

    let divider = '';

    if (turnDay === null || entry.type === 'message') {
      const day = dayOf(entry.item.at);

      divider = day !== turnDay ? dayDivider(entry.item.at, now) : '';
      turnDay = day;
    }

    // A note has no time, and does not count as the item before.
    const timed = entry.type === 'message' || entry.item.kind !== 'note';
    const minute = `${dayOf(entry.item.at)} ${STAMP.format(entry.item.at)}`;
    const stamped = timed && (minute !== lastMinute || divider !== '');

    if (timed) {
      lastMinute = minute;
    }

    const card = entry.type === 'reply' && entry.item.kind === 'reply' ? cardOf(cardKey('reply', entry.item.id), entry.item.opening, answerAfter(entry.item.id)) : '';

    return divider + (entry.type === 'message' ? message(entry.item, stamped) : reply(entry.item, entry.earlier, open, stamped, card, state.settings.expandReplies));
  });
  // A Codex session's pending questions and approvals, answered in cards at the end of the conversation.
  const requests = (state.session?.requests ?? []).map((request) => requestCard(request, page.requests ?? NO_REQUESTS)).join('');
  const earlier = state.more ? '<button class="earlier-items" data-action="earlier">Show earlier messages</button>' : '';
  const body = state.session === null ? '<p class="empty">No session yet. Messages appear here once the work item\'s session starts.</p>' : entries.length === 0 && spinner === '' && requests === '' ? '<p class="empty">No messages yet. They appear here when you or the session write one.</p>' : `<ol class="timeline" tabindex="0" aria-label="Conversation">${entries.join('')}${requests}${spinner}</ol>`;

  const unopened = state.artifacts.filter((artifact) => page.unopened.has(artifact.path)).length;
  const tabs = renderTabs(page.tab, { conversation: '', status: statusBadge(state.status, fresh) ? 'New' : '', artifacts: unopened === 0 ? '' : String(unopened) });
  const status = state.status;
  const statusCard = status === null || status.fallback ? '' : cardOf(cardKey('status', status.id), status.markdown, statusAnswer(state.items, status));
  // Each tab's panel, and each conversation's, is its own node, so a redraw keeps its scroll position and another tab or conversation starts afresh.
  const shownKey = `${state.scope.scopeGen}-${state.session?.id ?? ''}`;
  // The New messages pill sits at the bottom of the conversation's own area, just above the composer, never behind it.
  const pill = `<button class="glass pill" type="button" data-action="pill"${page.pill === true ? '' : ' hidden'}><span class="pill-dot" aria-hidden="true"></span>New messages</button>`;
  const panel =
    page.tab === 'status'
      ? `<div class="panel" id="panel" data-key="status-${shownKey}" role="tabpanel" aria-labelledby="tab-status">${renderStatus(status, fresh, now, statusCard, open, page.earlier ?? null)}</div>`
      : page.tab === 'artifacts'
        ? `<div class="panel" id="panel" data-key="artifacts-${shownKey}" role="tabpanel" aria-labelledby="tab-artifacts">${renderArtifacts(state.artifacts, page.unopened, now)}</div>`
        : `${notes.map((note) => `<p class="notice">${escape(note)}</p>`).join('')}<div class="scroll-area" data-key="conversation-${shownKey}"><div class="scroll" id="panel" role="tabpanel" aria-labelledby="tab-conversation">${earlier}${body}</div>${pill}</div>`;

  return `${header}${tabs}${panel}${endedNote}`;
}

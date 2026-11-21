/**
 * The line under a message or a reply, drawn alike by the VS Code Conversation view and the web page so they cannot drift (architecture.md
 * § Conversation view, § Web page): its marks on the left and its time at the right. The copy button and error marks always show; the
 * optional marks (a dictated message's, a reply's tone) and every item's time show only with Show message details on; without it only the
 * first item after a day's divider shows its time, and the others have it as their tooltip. Imports nothing, for browser bundles.
 */

const STAMP = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
const STAMP_FULL = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** An item's full time, for its tooltip: date, time to the second and zone. */
export function fullTime(at: number): string {
  const parts = Object.fromEntries(STAMP_FULL.formatToParts(at).map((part) => [part.type, part.value]));

  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}:${parts['second']} ${parts['timeZoneName']}`;
}

/** An item's time as shown: hour and minute, its full time as the tooltip. */
export function stampTime(at: number): string {
  return `<time class="stamp" datetime="${new Date(at).toISOString()}" title="${escape(fullTime(at))}">${STAMP.format(at)}</time>`;
}

/** Whether an item shows its time: with message details on every timed item does, otherwise only the first after a day's divider. */
export function stamped(timed: boolean, details: boolean, divider: boolean): boolean {
  return timed && (details || divider);
}

/** The line: its marks on the left and, when `shown`, its time at the right; otherwise the time is the line's tooltip. Empty with neither. */
export function metaLine(marks: readonly string[], at: number, shown: boolean): string {
  const left = marks.filter((mark) => mark !== '');

  return left.length === 0 && !shown
    ? ''
    : `<div class="meta"${shown ? '' : ` title="${escape(fullTime(at))}"`}>${left.length === 0 ? '' : `<span class="meta-marks">${left.join('')}</span>`}${shown ? stampTime(at) : ''}</div>`;
}

/** What a dictated message carries for its mark (architecture.md § Dictation). */
export interface DictatedMessage {
  origin: string;
  partial?: boolean;
  pieces?: ReadonlyArray<{ text: string; score: number | null; f0: number | null; dropped: boolean }>;
  interrupted?: { said: string };
}

/** A dictated message's mark, with message details on: the mic glyph, "partial" for a part of one still being spoken, its pieces as the tooltip. */
export function voiceMark(item: DictatedMessage, details: boolean): string {
  if (!details || item.origin !== 'voice') {
    return '';
  }

  const pieces = (item.pieces ?? []).map((piece) => `${piece.dropped ? '(dropped) ' : ''}${piece.text}${piece.score === null ? '' : ` · match ${piece.score.toFixed(2)}`}${piece.f0 === null ? '' : ` · ${Math.round(piece.f0)} Hz`}`);
  const dictated = pieces.length === 0 ? 'Dictated' : `Dictated in ${pieces.length} piece${pieces.length === 1 ? '' : 's'}:\n${pieces.join('\n')}`;
  // Spoken over a reply being read aloud, which stopped it (architecture.md § Voice check and barge-in).
  const over = item.interrupted === undefined ? '' : item.interrupted.said === '' ? 'Spoke over the reply before its first words.' : `Spoke over the reply after "${item.interrupted.said}".`;
  const title = over === '' ? dictated : `${dictated}\n${over}`;
  const label = `${item.partial === true ? 'partial' : 'dictated'}${item.interrupted === undefined ? '' : ' · interrupted the reply'}`;

  return `<span class="voice-mark" title="${escape(title)}"><span class="codicon codicon-mic" aria-hidden="true"></span><span>${label}</span></span>`;
}

/** A reply's tone, with message details on: how it sounds when spoken. */
export function toneMark(tone: string | null, details: boolean): string {
  return tone === null || !details ? '' : `<span class="tone" title="${escape(`How the reply sounds when spoken: ${tone}`)}">${escape(tone)}</span>`;
}

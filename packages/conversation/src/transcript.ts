import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { stripMessageTags } from './tags.js';

/**
 * One transcript entry the conversation shows: a reply Claude wrote, a message Claude received, or a message the operator sent while Claude was
 * busy, which Claude Code records twice: a `queue-operation` `enqueue` line when it is sent, and a `queued_command` attachment line where Claude
 * received it, which is where the conversation places it (claude-collab findings 2026-11-19).
 */
export type TranscriptEntry =
  | { kind: 'reply'; uuid: string | null; at: number; text: string; /** The API message's ID: Claude Code writes one line per content block. */ messageId: string | null }
  | { kind: 'message'; uuid: string | null; at: number; text: string; /** Received from Claude Code's queue mid-turn, not as a prompt. */ queued?: true }
  | { kind: 'sent'; uuid: null; at: number; text: string };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Text Claude Code itself puts in a user entry: a command's output, a shell escape, a reminder or an interruption note. */
const NOT_TYPED = /^\s*(<local-command-|<bash-(input|stdout|stderr)>|<system-reminder>|<task-notification>|\[Request interrupted|Caveat: The messages below)/;

/**
 * The notice Claude Code queues as plain text when the operator stops background agents. Its queue line names no origin and does not say it
 * is a notification (mechanics M118), so the text decides there and in a line from before Claude Code wrote origins; a line from the operator
 * with the same words is theirs.
 */
const AGENTS_STOPPED = /^\s*(Background agent ".*" was stopped by the user\.|\d+ background agents were stopped by the user: )/;

/** Text in a queue line that Claude Code put there, such as a task notification, a poll event or a message from another session. */
const NOT_SENT = /^\s*(<|\[Cross-session delivery notice\])/;

/** Whether a line's `origin` is the operator: `{kind: 'human'}`, not a task notification or another session. */
function fromHuman(origin: unknown): boolean {
  return isObject(origin) && origin['kind'] === 'human';
}

/** The text of a message's content: a string, or its text blocks beside images; null for anything else, such as a tool result. */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content) && content.every((block) => isObject(block) && (block['type'] === 'text' || block['type'] === 'image'))) {
    return content
      .filter((block) => isObject(block) && block['type'] === 'text')
      .map((block) => String((block as Json)['text'] ?? ''))
      .join('\n');
  }

  return null;
}

/**
 * The text of a user entry without the tags Claude Code wraps a pasted block in, `<pasted_content id="…">` and its closing tag on lines of their
 * own, as it records a paste of several lines (mechanics M86).
 */
export function unwrapPasted(text: string): string {
  return text.replace(/<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g, '$2');
}

/**
 * A slash command as the operator typed it, `/name args`, from the tags Claude Code records it with; the text itself otherwise, without the tags
 * Switchboard typed before it, such as `[spoken]` (architecture.md § Voice).
 */
export function typedText(text: string): string {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];

  if (name === undefined) {
    return stripMessageTags(unwrapPasted(text));
  }

  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';

  return `${name.startsWith('/') ? name : `/${name}`}${args === '' ? '' : ` ${args}`}`;
}

/**
 * A transcript line as an entry, or null for one the conversation does not show: a tool call or result, a subagent's or a meta entry, an API
 * error, a compaction summary. A reply saved only as a thinking block (its terminal copy shows "· summary") is still the reply (claude-collab
 * findings 2026-11-17). `assistantAt` is set for every assistant line, which a screen copy's withdrawal needs. `received` is the text of any
 * user line or queued command, shown or not, so a sent message Claude received as something else is withdrawn.
 */
export function parseLine(line: string): { entry: TranscriptEntry | null; assistantAt: number | null; uuid: string | null; parent: string | null; at: number | null; received: string | null } {
  let raw: unknown;
  const none = { entry: null, assistantAt: null, uuid: null, parent: null, at: null, received: null };

  try {
    raw = JSON.parse(line);
  } catch {
    return none;
  }

  if (!isObject(raw)) {
    return none;
  }

  const uuid = typeof raw['uuid'] === 'string' ? raw['uuid'] : null;
  const parent = typeof raw['parentUuid'] === 'string' ? raw['parentUuid'] : null;
  const line_ = { uuid, parent };
  const at = typeof raw['timestamp'] === 'string' && Number.isFinite(Date.parse(raw['timestamp'])) ? Date.parse(raw['timestamp']) : null;
  const message = isObject(raw['message']) ? raw['message'] : null;
  const side = raw['isSidechain'] === true || raw['isMeta'] === true || raw['isCompactSummary'] === true || raw['isApiErrorMessage'] === true;

  if (raw['type'] === 'assistant') {
    // A line Claude Code made up, such as an added Poll call or "No response requested.", was never the model's (claude-collab findings 2026-11-19).
    const madeUp = raw['isVirtual'] === true || raw['madeBy'] === 'other' || message?.['model'] === '<synthetic>';
    const assistantAt = side || madeUp ? null : at;

    if (side || madeUp || message === null || !Array.isArray(message['content'])) {
      return { ...line_, entry: null, assistantAt, at, received: null };
    }

    const blocks = message['content'].filter(isObject);
    let text = blocks
      .filter((block) => block['type'] === 'text')
      .map((block) => String(block['text'] ?? ''))
      .join('\n');

    if (text.trim() === '' && raw['thinkingDisplay'] === 'updates') {
      text = blocks
        .filter((block) => block['type'] === 'thinking')
        .map((block) => String(block['thinking'] ?? ''))
        .join('\n');
    }

    const messageId = typeof message['id'] === 'string' ? message['id'] : null;

    return { ...line_, entry: text.trim() === '' ? null : { kind: 'reply', uuid, at: at ?? 0, text, messageId }, assistantAt, at, received: null };
  }

  // Sent while Claude was busy; the line where Claude received it follows.
  if (raw['type'] === 'queue-operation') {
    const content = raw['content'];

    // A paste of several lines starts with its `pasted_content` tag, which is the operator's text, not Claude Code's.
    if (raw['operation'] === 'enqueue' && typeof content === 'string' && content.trim() !== '' && !NOT_TYPED.test(unwrapPasted(content)) && !NOT_SENT.test(unwrapPasted(content)) && !AGENTS_STOPPED.test(content)) {
      return { entry: { kind: 'sent', uuid: null, at: at ?? 0, text: typedText(content) }, assistantAt: null, uuid: null, parent: null, at, received: null };
    }

    return { ...none, at };
  }

  // A message sent while Claude was busy, where Claude received it, mid-turn.
  const attachment = raw['type'] === 'attachment' && isObject(raw['attachment']) && raw['attachment']['type'] === 'queued_command' ? raw['attachment'] : null;

  if (attachment !== null) {
    const text = contentText(attachment['prompt']);
    const human = (attachment['origin'] === undefined ? attachment['commandMode'] === 'prompt' : fromHuman(attachment['origin'])) && !side;

    if (text !== null && text.trim() !== '' && human && !NOT_TYPED.test(text) && !(attachment['origin'] === undefined && AGENTS_STOPPED.test(text))) {
      return { ...line_, entry: { kind: 'message', uuid, at: at ?? 0, text: typedText(text), queued: true }, assistantAt: null, at, received: typedText(text) };
    }

    return { ...none, ...line_, at, received: text === null ? null : typedText(text) };
  }

  if (raw['type'] === 'user' && message !== null) {
    const text = contentText(message['content']);
    // Claude Code 2.1.326 and later name who wrote a user line; an earlier one is read by its text alone.
    const human = raw['origin'] === undefined || fromHuman(raw['origin']);

    if (text !== null && text.trim() !== '' && human && !side && !NOT_TYPED.test(text) && !(raw['origin'] === undefined && AGENTS_STOPPED.test(text))) {
      return { ...line_, entry: { kind: 'message', uuid, at: at ?? 0, text: typedText(text) }, assistantAt: null, at, received: typedText(text) };
    }

    return { ...none, ...line_, at, received: text === null ? null : typedText(text) };
  }

  return { ...none, ...line_, at };
}

/** Reads the complete lines appended to a transcript since `offset`; a line still being written waits for its newline. */
export function readLines(path: string, offset: number): { lines: string[]; offset: number } | null {
  let size: number;

  try {
    size = statSync(path).size;
  } catch {
    return null;
  }

  // The file was replaced by a shorter one; read it again from the start.
  const from = size < offset ? 0 : offset;

  if (size === from) {
    return { lines: [], offset: from };
  }

  const buffer = Buffer.alloc(size - from);
  const fd = openSync(path, 'r');

  try {
    readSync(fd, buffer, 0, buffer.length, from);
  } finally {
    closeSync(fd);
  }

  const end = buffer.lastIndexOf(10);

  if (end === -1) {
    return { lines: [], offset: from };
  }

  return { lines: buffer.subarray(0, end).toString('utf8').split('\n').filter((line) => line.trim() !== ''), offset: from + end + 1 };
}

/**
 * The complete lines of a transcript that end at or before `offset` and start no more than `bytes` before it; a line cut by that window is left
 * out. Empty when the transcript cannot be read.
 */
export function readLinesBefore(path: string, offset: number, bytes: number): string[] {
  const end = Math.min(offset, sizeOf(path) ?? 0);
  const from = Math.max(0, end - bytes);

  if (end <= from) {
    return [];
  }

  const buffer = readBytes(path, from, end - from);
  // A piece after the last line end is a line still being written, or one `offset` cuts.
  const lines = buffer.subarray(0, buffer.lastIndexOf(10) + 1).toString('utf8').split('\n');

  // The window's first piece starts inside a line, unless the window starts the file or a line.
  if (from > 0 && readBytes(path, from - 1, 1)[0] !== 10) {
    lines.shift();
  }

  return lines.filter((line) => line.trim() !== '');
}

/** The complete lines among a transcript's first `bytes`, or none when it cannot be read. */
export function readHead(path: string, bytes: number): string[] {
  const size = sizeOf(path) ?? 0;
  const buffer = readBytes(path, 0, Math.min(size, bytes));
  const end = buffer.lastIndexOf(10);

  return end === -1 ? [] : buffer.subarray(0, end).toString('utf8').split('\n').filter((line) => line.trim() !== '');
}

/** The offset just past a transcript's last complete line: where a reader that skips everything written so far starts. 0 when it has none. */
export function transcriptEnd(path: string): number {
  const size = sizeOf(path) ?? 0;

  for (let end = size; end > 0; ) {
    const from = Math.max(0, end - TAIL_CHUNK_BYTES);
    const at = readBytes(path, from, end - from).lastIndexOf(10);

    if (at !== -1) {
      return from + at + 1;
    }

    end = from;
  }

  return 0;
}

/** How much of a transcript's end `transcriptEnd` reads at a time, looking for its last line end. */
const TAIL_CHUNK_BYTES = 64 * 1024;

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** `length` bytes of a file from `from`, or none when it cannot be read. */
function readBytes(path: string, from: number, length: number): Buffer {
  if (length <= 0) {
    return Buffer.alloc(0);
  }

  let fd: number;

  try {
    fd = openSync(path, 'r');
  } catch {
    return Buffer.alloc(0);
  }

  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, from);

    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** A slash command a session offers: a built-in or one of its skills, without its slash. */
export interface SlashCommand {
  name: string;
  description: string;
}

/** The longest skill description the command list keeps. */
const DESCRIPTION_CHARS = 300;

/**
 * The skills a `skill_listing` attachment line names, each with its description from the listing's `- name: description` lines, and whether the
 * listing is the whole list (`isInitial`) or adds to and updates the one before (mechanics M88); null for any other line.
 */
export function skillListing(line: string): { initial: boolean; skills: SlashCommand[] } | null {
  if (!line.includes('"skill_listing"')) {
    return null;
  }

  let raw: unknown;

  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isObject(raw) || raw['type'] !== 'attachment' || !isObject(raw['attachment']) || raw['attachment']['type'] !== 'skill_listing') {
    return null;
  }

  const listing = raw['attachment'];
  const described = new Map<string, string>();

  for (const row of String(listing['content'] ?? '').split('\n')) {
    const match = /^- (\S+?): (.*)$/.exec(row);

    if (match !== null) {
      described.set(match[1]!, match[2]!.trim());
    }
  }

  const names = Array.isArray(listing['names']) ? listing['names'].filter((name): name is string => typeof name === 'string' && /^[\w:.-]+$/.test(name)) : [];

  return { initial: listing['isInitial'] !== false, skills: names.map((name) => ({ name, description: (described.get(name) ?? '').slice(0, DESCRIPTION_CHARS) })) };
}

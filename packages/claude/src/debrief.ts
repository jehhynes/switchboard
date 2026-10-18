import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { Exec } from './exec.js';
import { claudeEnvironment, failureOf } from './exec.js';

/** Set on every debrief fork; the hook writer ignores sessions that carry it. */
export const DEBRIEF_ENV = 'FRICTION_DEBRIEF';

/** The fork sees messages, not uuids, so a repeat debrief names its start by the first message's opening text. */
export const PROMPT_EXCERPT = 200;

/** A subagent older than this has a cold cache; the fork is not shown it, so it cannot message it. */
export const SUBAGENT_WINDOW_MS = 55 * 60 * 1000;

/** `codex` threads run elsewhere; `Explore` and `Plan` subagents cannot be resumed. */
const UNASKED_AGENT_TYPES = new Set(['codex', 'Explore', 'Plan']);

/** One problem a debriefed session reports. The analyzer groups by `source` and counts `cost`, so all five must be filled. */
export interface FrictionEntry {
  what: string;
  source: string;
  workaround: string;
  cost: string;
  evidence: string;
  [key: string]: unknown;
}

const FRICTION_FIELDS = ['what', 'source', 'workaround', 'cost', 'evidence'] as const;

/** A session's transcript after the last debrief through its latest message. */
export interface DebriefRange {
  /** The latest main-transcript message; the next debrief starts after it. */
  throughMessageUuid: string;
  /** Tool calls in the main transcript's range; subagent transcripts are excluded. */
  toolCalls: number;
  /** Skills the range invoked, in first-use order. */
  skills: string[];
  /** Codex threads agent-delegate returned in the range, in the main and subagent transcripts. */
  delegated: string[];
  /** The opening of the first message after the start; null for a first debrief or when none is found. */
  fromPrompt: string | null;
}

export interface DebriefCache {
  read: number;
  created: number;
  costUsd: number;
}

export type DebriefAnswer = { friction: FrictionEntry[]; cache: DebriefCache | null };

interface TranscriptRecord {
  type: string;
  uuid?: string;
  sessionId?: string;
  isSidechain?: boolean;
  /** Context the CLI inserts, such as a skill's text, rather than a message in the conversation. */
  isMeta?: boolean;
  timestamp?: string;
  message?: { content?: unknown };
}

interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
}

const DELEGATE_TOOL = /^mcp__agent-delegate__/;
const DELEGATED_ID = /"session_id"\s*:\s*"([^"\\]+)"/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordsOf(text: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];

  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(line);

      if (isRecord(parsed) && typeof parsed['type'] === 'string') {
        records.push(parsed as unknown as TranscriptRecord);
      }
    } catch {
      // A transcript being written can end inside a line.
    }
  }

  return records;
}

function blocksOf(entry: TranscriptRecord): Block[] {
  const content = entry.message?.content;

  return Array.isArray(content) ? content.filter((item): item is Block => isRecord(item) && typeof item['type'] === 'string') : [];
}

/** A user record's own text: a prompt or a harness notice, not a tool result or inserted context. */
function userTextOf(entry: TranscriptRecord): string | null {
  const content = entry.message?.content;

  if (entry.type !== 'user' || entry.isMeta === true) {
    return null;
  }

  if (typeof content === 'string') {
    return content;
  }

  const blocks = blocksOf(entry);
  const texts = blocks.filter((item) => item.type === 'text' && typeof item.text === 'string').map((item) => item.text);

  return texts.length === 0 || blocks.some((item) => item.type === 'tool_result') ? null : texts.join('\n');
}

function textOf(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  return Array.isArray(value) ? value.map((item) => (isRecord(item) && typeof item['text'] === 'string' ? item['text'] : '')).join('\n') : '';
}

/** Adds the session IDs that the results of agent-delegate calls name. */
function delegatedIn(records: readonly TranscriptRecord[], found: string[]): void {
  const calls = new Set<string>();

  for (const entry of records) {
    for (const item of blocksOf(entry)) {
      if (item.type === 'tool_use' && item.id !== undefined && DELEGATE_TOOL.test(item.name ?? '')) {
        calls.add(item.id);
      }

      if (item.type === 'tool_result' && item.tool_use_id !== undefined && calls.has(item.tool_use_id)) {
        for (const match of textOf(item.content).matchAll(DELEGATED_ID)) {
          if (!found.includes(match[1]!)) {
            found.push(match[1]!);
          }
        }
      }
    }
  }
}

const opening = (text: string | null | undefined): string | null => (text === null || text === undefined || text.trim() === '' ? null : text.trimStart().slice(0, PROMPT_EXCERPT));

/**
 * The range after `fromMessageUuid`, or the whole transcript when it is null or not found; null when there is no message.
 * Subagent records count from the start message's time, since they share no message chain with the parent.
 */
export function debriefRange(main: string, subagents: readonly string[], sessionId: string, fromMessageUuid: string | null): DebriefRange | null {
  const messages = recordsOf(main).filter(
    (entry) => (entry.type === 'user' || entry.type === 'assistant') && entry.uuid !== undefined && entry.isSidechain !== true && (entry.sessionId === undefined || entry.sessionId === sessionId),
  );
  const last = messages.at(-1);

  if (last?.uuid === undefined) {
    return null;
  }

  const start = fromMessageUuid === null ? -1 : messages.findIndex((entry) => entry.uuid === fromMessageUuid);
  const range = messages.slice(start + 1);
  const since = start < 0 ? null : Date.parse(messages[start]?.timestamp ?? '');
  const toolUses = new Set<string>();
  const skills: string[] = [];
  const delegated: string[] = [];

  for (const entry of range) {
    for (const item of blocksOf(entry)) {
      if (entry.type === 'assistant' && item.type === 'tool_use' && item.id !== undefined) {
        toolUses.add(item.id);

        const skill = item.name === 'Skill' && isRecord(item.input) ? item.input['skill'] : undefined;

        if (typeof skill === 'string' && !skills.includes(skill)) {
          skills.push(skill);
        }
      }
    }
  }

  delegatedIn(range, delegated);

  for (const text of subagents) {
    delegatedIn(
      recordsOf(text).filter((entry) => since === null || Number.isNaN(since) || Date.parse(entry.timestamp ?? '') > since),
      delegated,
    );
  }

  return {
    throughMessageUuid: last.uuid,
    toolCalls: toolUses.size,
    skills,
    delegated,
    fromPrompt: start < 0 ? null : (range.map((entry) => opening(userTextOf(entry))).find((text) => text !== null) ?? null),
  };
}

/** The prompt's `{{scope}}`: the whole conversation, or the work after the message the range starts at. */
export function scopeOf(range: DebriefRange): string {
  return range.fromPrompt === null ? 'the whole conversation' : `the work after the user message that begins "${range.fromPrompt}"`;
}

/** The friction list from `{"friction": [...]}` or a bare array, or null when any item lacks a field. */
export function frictionOf(value: unknown): FrictionEntry[] | null {
  const list = isRecord(value) ? value['friction'] : value;

  if (!Array.isArray(list)) {
    return null;
  }

  return list.every((item) => isRecord(item) && FRICTION_FIELDS.every((field) => typeof item[field] === 'string' && item[field].trim() !== '')) ? (list as FrictionEntry[]) : null;
}

/** Strip a Markdown code fence the model may wrap its JSON in. */
function unfenced(text: string): string {
  return /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text)?.[1] ?? text;
}

interface PrintResult {
  type: 'result';
  is_error?: boolean;
  subtype?: string;
  result?: string;
  total_cost_usd?: number;
  usage?: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

const failed = (result: PrintResult): boolean => result.is_error === true || (result.subtype !== undefined && result.subtype !== 'success');

function answerOf(result: PrintResult): FrictionEntry[] | null {
  if (failed(result)) {
    return null;
  }

  try {
    return typeof result.result === 'string' ? frictionOf(JSON.parse(unfenced(result.result))) : null;
  } catch {
    return null;
  }
}

/**
 * `--output-format json` prints an array of stream events (mechanics M19). A fork that waits on its subagents prints
 * several results: interim ones, the answer, and an empty one (GC M64). The answer is the last result that parses as the
 * friction JSON; the last result carries the run's cost and token counts.
 */
export function readDebriefOutput(value: unknown): DebriefAnswer | { error: string } {
  const results = (Array.isArray(value) ? (value as unknown[]) : [value]).filter((item): item is PrintResult => isRecord(item) && item['type'] === 'result');
  const last = results.at(-1);

  if (last === undefined) {
    return { error: 'Claude returned no debrief result.' };
  }

  const friction = results.map(answerOf).reverse().find((answer) => answer !== null) ?? null;

  if (friction === null) {
    if (failed(last)) {
      return { error: `Claude did not finish the debrief${last.subtype ? ` (${last.subtype})` : ''}.` };
    }

    const said = results.map((result) => (typeof result.result === 'string' ? result.result : '')).reverse().find((text) => text.trim() !== '') ?? '';

    return { error: `The debrief answer was not the friction JSON: ${said.slice(0, 200)}` };
  }

  const usage: unknown = last.usage;
  const count = (value: unknown): number => (typeof value === 'number' ? value : 0);

  return {
    friction,
    cache: isRecord(usage) ? { read: count(usage['cache_read_input_tokens']), created: count(usage['cache_creation_input_tokens']), costUsd: count(last.total_cost_usd) } : null,
  };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export interface Transcript {
  path: string;
  /** Last write, in epoch milliseconds: the end of the session's last turn. */
  writtenAt: number;
}

/** Claude's project directory name for a working directory: every character but a letter or digit becomes `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** `<projects>/<slug>/<sessionId>.jsonl`, matching the slug exactly first, then ignoring case. */
export function findTranscript(projectsDir: string, cwd: string, sessionId: string): Transcript | null {
  const slug = projectSlug(cwd);
  const names = listDir(projectsDir);
  const candidates = [...names.filter((name) => name === slug), ...names.filter((name) => name !== slug && name.toLowerCase() === slug.toLowerCase())];

  for (const name of candidates) {
    const path = `${projectsDir}/${name}/${sessionId}.jsonl`;

    try {
      return { path, writtenAt: statSync(path).mtimeMs };
    } catch {
      continue;
    }
  }

  return null;
}

/** The subagent transcripts beside a session's transcript, in `<sessionId>/subagents/`. */
export function subagentTranscripts(transcript: string): string[] {
  const dir = `${transcript.replace(/\.jsonl$/, '')}/subagents`;

  return listDir(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => readText(`${dir}/${name}`) ?? []);
}

export interface SubagentChoice {
  agentId: string;
  description: string;
  /** What the prompt asks it about. */
  scope: string;
  transcript: string;
  meta: string;
}

/**
 * The subagents the fork may message: resumable ones written within the cache window with a message since their last
 * debrief (`debriefed`, by agent ID). One debriefed before is asked about the work after the first message it got since.
 */
export function chooseSubagents(dir: string, debriefed: Readonly<Record<string, string>>, now: number): SubagentChoice[] {
  const choices: SubagentChoice[] = [];

  for (const name of listDir(dir).sort()) {
    const agentId = /^agent-(.+)\.jsonl$/.exec(name)?.[1];

    if (agentId === undefined) {
      continue;
    }

    const transcript = `${dir}/${name}`;
    const meta = `${dir}/agent-${agentId}.meta.json`;
    let parsed: unknown;

    try {
      parsed = JSON.parse(readText(meta) ?? '');
    } catch {
      continue;
    }

    const agentType = isRecord(parsed) ? parsed['agentType'] : undefined;

    if (typeof agentType !== 'string' || UNASKED_AGENT_TYPES.has(agentType)) {
      continue;
    }

    const records = recordsOf(readText(transcript) ?? '').filter((entry) => !Number.isNaN(Date.parse(entry.timestamp ?? '')));
    const last = Math.max(...records.map((entry) => Date.parse(entry.timestamp!)));

    if (!Number.isFinite(last) || now - last >= SUBAGENT_WINDOW_MS) {
      continue;
    }

    const since = debriefed[agentId];
    let scope = 'all of your work in this conversation';

    if (since !== undefined) {
      // A subagent works again only on a new message; records without one hold nothing the last debrief missed.
      const first = records
        .filter((entry) => Date.parse(entry.timestamp!) > Date.parse(since))
        .map((entry) => opening(userTextOf(entry)))
        .find((text) => text !== null);

      if (first === undefined) {
        continue;
      }

      scope = `the work after the message that begins "${first}"`;
    }

    const description = isRecord(parsed) && typeof parsed['description'] === 'string' && parsed['description'].trim() !== '' ? parsed['description'].trim() : agentType;

    choices.push({ agentId, description, scope, transcript, meta });
  }

  return choices;
}

/** The prompt's `{{subagents}}`: a line per subagent the fork may message, or `none`. */
export function subagentLines(choices: readonly SubagentChoice[]): string {
  return choices.length === 0 ? 'none' : choices.map((choice) => `- \`${choice.agentId}\` (${choice.description}): ${choice.scope}`).join('\n');
}

/**
 * A transient print-mode fork of the session (GC M64, mechanics M19). Model, effort, tool and MCP flags would change the
 * prompt prefix and lose the session's cache, so none are passed. The prompt goes on stdin.
 */
export function debriefArgs(sessionId: string, forkId: string): string[] {
  return ['-p', '--resume', sessionId, '--fork-session', '--session-id', forkId, '--no-session-persistence', '--output-format', 'json'];
}

export interface DebriefInput {
  claudePath: string;
  sessionId: string;
  /** Chosen by the caller and never the session's own, because the fork's subagent directory is removed afterwards. */
  forkId: string;
  cwd: string;
  transcript: string;
  /** The prompt with `{{scope}}` filled; `{{subagents}}` is filled here. */
  prompt: string;
  /** When each of the session's subagents was last debriefed, by agent ID. */
  subagentsDebriefed: Readonly<Record<string, string>>;
  now: number;
  timeoutMs: number;
}

export type DebriefResult = (DebriefAnswer & { subagents: string[] }) | { error: string };

/**
 * Fork the session and ask the prompt. A fork copies only the main transcript, and a subagent it messages resumes from
 * `<project>/<forkId>/subagents/`, so the chosen subagents' files are copied there for the run and removed after it (GC M64).
 */
export async function runDebrief(input: DebriefInput, exec: Exec): Promise<DebriefResult> {
  const project = input.transcript.slice(0, input.transcript.lastIndexOf('/'));
  const choices = input.forkId === input.sessionId ? [] : chooseSubagents(`${project}/${input.sessionId}/subagents`, input.subagentsDebriefed, input.now);
  const forkDir = `${project}/${input.forkId}`;
  // A function replacement keeps `$&` and the like in quoted messages literal.
  const prompt = input.prompt.replaceAll('{{subagents}}', () => subagentLines(choices));

  try {
    try {
      for (const choice of choices) {
        mkdirSync(`${forkDir}/subagents`, { recursive: true });

        for (const file of [choice.transcript, choice.meta]) {
          copyFileSync(file, `${forkDir}/subagents/${file.slice(file.lastIndexOf('/') + 1)}`);
        }
      }
    } catch (error) {
      return { error: `The session's subagent transcripts could not be copied for the debrief: ${(error as Error).message}` };
    }

    const result = await exec(input.claudePath, debriefArgs(input.sessionId, input.forkId), {
      cwd: input.cwd,
      stdin: prompt,
      timeoutMs: input.timeoutMs,
      env: { ...claudeEnvironment(input.claudePath), [DEBRIEF_ENV]: '1' },
    });

    if (result.code !== 0) {
      return { error: `Claude could not run the debrief: ${failureOf(input.claudePath, result, input.timeoutMs, { cwd: input.cwd })}` };
    }

    let output: unknown;

    try {
      output = JSON.parse(result.stdout);
    } catch {
      return { error: 'The debrief output is not JSON.' };
    }

    const answer = readDebriefOutput(output);

    return 'error' in answer ? answer : { ...answer, subagents: choices.map((choice) => choice.agentId) };
  } finally {
    if (choices.length > 0) {
      try {
        rmSync(forkDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Failing a finished debrief would pay for it again; a copy left behind is named for a fork no one resumes.
      }
    }
  }
}

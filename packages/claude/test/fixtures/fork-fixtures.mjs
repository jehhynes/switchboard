// Records the fork fixtures by running the Claude VS Code extension's own forkSession and getTranscript on synthetic transcripts.
// Usage: node fork-fixtures.mjs <path to the extension's extension.js>
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(process.argv[2], 'utf8');

function slice(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);

  if (from < 0 || to < 0) {
    throw new Error(`${start} not found in ${process.argv[2]}`);
  }

  return source.slice(from, to);
}

// The two Sessions methods, and the helpers forkSession calls by their minified names.
const methods = `${slice('getTranscript($,J=!1)', 'async teleportOriginOf(')},${slice('async forkSession(', '}async function HF1(')}`;
const helpers = slice('function OM1(', 'I6();AV();');

function forker(dir, messages, file) {
  const make = new Function('v9', 'nv', 'B5', 'b8', 'p3', 'T0', 'HF1', 'vN1', 'LF1', 'bk4', `${helpers};return {${methods}}`);
  const sessions = make(() => true, { randomUUID }, path, () => dir, async (root) => root, fs, async () => [], () => undefined, () => {}, () => {});

  return Object.assign(sessions, {
    loadedSessions: new Set(),
    sessionMessages: new Map([[messages[0].sessionId, new Set(messages.map((message) => message.uuid))]]),
    messages: new Map(messages.map((message) => [message.uuid, message])),
    ensureSessionLoaded: async () => true,
    projectRoot: dir,
    sessionFilePaths: new Map([[messages[0].sessionId, { filePath: file }]]),
    summaries: new Map(),
    customTitles: new Map([[messages[0].sessionId, 'switchboard · dev:develop · github 1']]),
    fileHistorySnapshots: new Map(),
    copySessionPermissionModeToFork: async () => {},
    logger: { error: console.error, warn: console.warn },
  });
}

const ORIGINAL = '0f1e2d3c-0000-4000-8000-000000000001';
const base = { isSidechain: false, cwd: 'D:\\git\\repo', sessionId: ORIGINAL, version: '2.1.296', entrypoint: 'cli', sessionKind: 'bg' };
const user = (uuid, parentUuid, content, at) => ({ ...base, parentUuid, type: 'user', message: { role: 'user', content }, uuid, timestamp: at });
const assistant = (uuid, parentUuid, requestId, text, at, extra = {}) => ({
  ...base,
  ...extra,
  parentUuid,
  type: 'assistant',
  message: { model: 'claude-opus-5-5', id: `msg_${requestId}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
  requestId,
  uuid,
  timestamp: at,
});

const plain = [
  user('u1', null, 'Fix the bug. Report to Switchboard with these commands: ...', '2026-10-13T14:00:00.000Z'),
  assistant('s1', 'u1', 'req_sidechain', 'subagent', '2026-10-13T14:00:01.000Z', { isSidechain: true }),
  assistant('a1', 'u1', 'req_first', 'Looking.', '2026-10-13T14:00:02.000Z'),
  user('u2', 'a1', 'Try another way.', '2026-10-13T14:01:00.000Z'),
  assistant('a2', 'u2', 'req_second', 'Done.', '2026-10-13T14:01:05.000Z'),
];
const compacted = [
  ...plain,
  { ...base, parentUuid: null, logicalParentUuid: 'a2', type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', uuid: 'c1', timestamp: '2026-10-13T15:00:00.000Z' },
  user('u3', 'c1', 'This session is being continued from a previous conversation.', '2026-10-13T15:00:01.000Z'),
  assistant('a3', 'u3', 'req_after', 'Continuing.', '2026-10-13T15:00:05.000Z'),
];

async function record(name, messages, at) {
  const dir = fs.mkdtempSync(path.join(here, '.fork-'));

  try {
    const file = path.join(dir, `${ORIGINAL}.jsonl`);
    const text = messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
    fs.writeFileSync(file, text);
    const id = await forker(dir, messages, file).forkSession(ORIGINAL, at);
    fs.writeFileSync(path.join(here, `fork-${name}-original.jsonl`), text);
    fs.copyFileSync(path.join(dir, `${id}.jsonl`), path.join(here, `fork-${name}-copy.jsonl`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await record('plain', plain, undefined);
await record('message', plain, 'a1');
await record('compacted', compacted, undefined);

import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@switchboard/core';
import { findForks, forkTargets, MISSING_RETRY_MS, relationOf, Transcripts } from '../src/fork.js';
import type { RosterEntry } from '../src/runner.js';

// Forks recorded with the Claude VS Code extension's own fork code (fixtures/README.md, mechanics M36).
const fixture = (name: string) => join(import.meta.dirname, 'fixtures', `fork-${name}.jsonl`);
const ORIGINAL = '0f1e2d3c-0000-4000-8000-000000000001';
const FORK = '9e8d7c6b-0000-4000-8000-000000000002';
const LATER = '5a4b3c2d-0000-4000-8000-000000000003';

let root: string;
let now: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchboard-fork-'));
  now = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function transcripts(): Transcripts {
  return new Transcripts(join(root, 'projects'), () => now);
}

function file(id: string, project = 'D--git-repo'): string {
  mkdirSync(join(root, 'projects', project), { recursive: true });
  return join(root, 'projects', project, `${id}.jsonl`);
}

/** Writes transcripts in order, so each has a later birth time than the one before. */
async function put(...files: [id: string, fixtureName: string, project?: string][]): Promise<void> {
  for (const [id, name, project] of files) {
    copyFileSync(fixture(name), file(id, project));
    await new Promise((done) => setTimeout(done, 15));
  }
}

function session(patch: Partial<Session> = {}): Session & { nativeSessionId: string } {
  return {
    id: 's1',
    workItemId: 1,
    kind: 'task',
    provider: 'claude',
    nativeSessionId: ORIGINAL,
    shortId: ORIGINAL.slice(0, 8),
    cwd: 'D:\\git\\repo',
    state: 'ended',
    stateAt: 0,
    stateDetail: null,
    outcome: null,
    outcomeDetail: null,
    startedAt: 0,
    endedAt: null,
    released: true,
    releasing: false,
    question: null,
    reports: ['stage'],
    retiredIds: [],
    pendingFork: null, external: false,
    ...patch,
  } as Session & { nativeSessionId: string };
}

function entry(patch: Partial<RosterEntry> = {}): RosterEntry {
  return { pid: 7, cwd: 'd:\\git\\repo', kind: 'interactive', sessionId: FORK, status: 'busy', ...patch };
}

const assistantLine = (requestId: string, extra = '') => `{"type":"assistant","isSidechain":false,"requestId":"${requestId}"${extra}}\n`;

describe('Transcripts', () => {
  it('indexes the assistant request IDs outside subagents, and the first as the key', async () => {
    await put([ORIGINAL, 'plain-original']);
    const index = transcripts().index(ORIGINAL, 'D:\\git\\repo')!;

    expect(index).toMatchObject({ project: 'd--git-repo', key: 'req_first', ids: new Set(['req_first', 'req_second']) });
  });

  it('reads only what was written since, keeping an incomplete line for the next pass', () => {
    const path = file(ORIGINAL);
    const line = assistantLine('req_first');
    writeFileSync(path, `{"type":"user"}\n${line.slice(0, 20)}`);
    const index = transcripts();

    expect(index.index(ORIGINAL, 'D:\\git\\repo')!.key).toBeNull();
    appendFileSync(path, line.slice(20) + assistantLine('req_second'));
    expect(index.index(ORIGINAL, 'D:\\git\\repo')!.key).toBeNull();
    index.pass();
    expect(index.index(ORIGINAL, 'D:\\git\\repo')).toMatchObject({ key: 'req_first', ids: new Set(['req_first', 'req_second']) });
  });

  it('reads a transcript whose first prompt carries a large attachment', () => {
    writeFileSync(file(ORIGINAL), `{"type":"user","message":"${'x'.repeat(6 * 1024 * 1024)}"}\n${assistantLine('req_first')}`);

    expect(transcripts().index(ORIGINAL, 'D:\\git\\repo')!.key).toBe('req_first');
  });

  it('reads a replaced or shorter transcript again from the start', async () => {
    const path = file(ORIGINAL);
    writeFileSync(path, assistantLine('req_old', `,"pad":"${'x'.repeat(100)}"`));
    const index = transcripts();

    expect(index.index(ORIGINAL, null)!.key).toBe('req_old');
    writeFileSync(path, assistantLine('req_new'));
    index.pass();
    expect(index.index(ORIGINAL, null)).toMatchObject({ key: 'req_new', ids: new Set(['req_new']) });

    // A larger file put in its place, as a restore does, is another file.
    await new Promise((done) => setTimeout(done, 15));
    writeFileSync(`${path}.new`, assistantLine('req_restored', `,"pad":"${'x'.repeat(300)}"`) + assistantLine('req_more'));
    rmSync(path);
    renameSync(`${path}.new`, path);
    index.pass();
    const restored = index.index(ORIGINAL, null)!;
    expect(restored).toMatchObject({ key: 'req_restored', ids: new Set(['req_restored', 'req_more']), createdAt: statSync(path).birthtimeMs });
  });

  it('keeps a character split across two writes', () => {
    const path = file(ORIGINAL);
    const line = Buffer.from(assistantLine('req_first', ',"text":"übung"'));
    const split = line.indexOf(Buffer.from('ü')) + 1;
    writeFileSync(path, line.subarray(0, split));
    const index = transcripts();

    expect(index.index(ORIGINAL, null)).toMatchObject({ key: null, offset: split });
    appendFileSync(path, line.subarray(split));
    index.pass();
    expect(index.index(ORIGINAL, null)).toMatchObject({ key: 'req_first', offset: line.length });
  });

  it('looks for a missing transcript again only after the retry interval, in every project without a working directory', () => {
    const index = transcripts();

    expect(index.index(ORIGINAL, null)).toBeNull();
    writeFileSync(file(ORIGINAL, 'D--git-other'), assistantLine('req_first'));
    index.pass();
    expect(index.index(ORIGINAL, null)).toBeNull();
    now += MISSING_RETRY_MS + 1;
    expect(index.index(ORIGINAL, null)).toMatchObject({ project: 'd--git-other', key: 'req_first' });
  });
});

describe('relationOf', () => {
  it.each(['plain', 'message', 'compacted'])('finds a %s fork newer than its source', async (name) => {
    await put([ORIGINAL, `${name}-original`], [FORK, `${name}-copy`]);

    expect(relationOf(transcripts(), FORK, null, session())).toBe('newer');
  });

  it('calls the source older than its fork, and a retired copy older even when its file is recreated later', async () => {
    await put([ORIGINAL, 'plain-original'], [FORK, 'plain-copy']);
    const forked = session({ nativeSessionId: FORK, retiredIds: [ORIGINAL] });

    expect(relationOf(transcripts(), ORIGINAL, null, session({ nativeSessionId: FORK }))).toBe('older');
    await put([ORIGINAL, 'plain-original']);
    expect(relationOf(transcripts(), ORIGINAL, null, forked)).toBe('older');
  });

  it('finds a later fork of a retired copy that the current copy does not contain', async () => {
    // The current copy forked from the first reply; the later fork copies the original from its compaction boundary.
    await put([ORIGINAL, 'compacted-original'], [FORK, 'message-copy'], [LATER, 'compacted-copy']);
    const forked = session({ nativeSessionId: FORK, retiredIds: [ORIGINAL] });

    expect(relationOf(transcripts(), LATER, null, session({ nativeSessionId: FORK }))).toBe('unrelated');
    expect(relationOf(transcripts(), LATER, null, forked)).toBe('newer');
  });

  it('calls a copy in another project, without a key, or of another family unrelated', async () => {
    await put([ORIGINAL, 'plain-original'], [FORK, 'plain-copy', 'D--git-other']);
    writeFileSync(file(LATER), '{"type":"user"}\n');
    writeFileSync(file('aaaaaaaa-0000-4000-8000-000000000004'), assistantLine('req_elsewhere'));

    expect(relationOf(transcripts(), FORK, null, session())).toBe('unrelated');
    expect(relationOf(transcripts(), LATER, null, session())).toBe('unrelated');
    expect(relationOf(transcripts(), 'aaaaaaaa-0000-4000-8000-000000000004', null, session())).toBe('unrelated');
    expect(relationOf(transcripts(), FORK, null, session({ nativeSessionId: 'bbbbbbbb-0000-4000-8000-000000000005' }))).toBe('unrelated');
  });
});

describe('forkTargets', () => {
  it("takes each work item's latest Claude session with a native ID", () => {
    const sessions = [session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c', state: 'starting' }), session({ id: 'd', workItemId: 2, provider: 'codex' }), session({ id: 'e', workItemId: 3, nativeSessionId: null })];

    expect(forkTargets(sessions).map((target) => target.id)).toEqual(['b']);
  });
});

describe('findForks', () => {
  it('takes the newest live fork of each session', async () => {
    await put([ORIGINAL, 'plain-original'], [FORK, 'plain-copy'], [LATER, 'message-copy']);

    expect(findForks(transcripts(), [entry(), entry({ sessionId: LATER })], [session()])).toEqual(new Map([['s1', entry({ sessionId: LATER })]]));
  });

  it('never takes an older sibling of the current copy, or a session copy', async () => {
    await put([ORIGINAL, 'plain-original'], [FORK, 'plain-copy'], [LATER, 'message-copy']);
    const forked = session({ nativeSessionId: LATER, retiredIds: [ORIGINAL] });

    expect(findForks(transcripts(), [entry(), entry({ sessionId: ORIGINAL }), entry({ sessionId: LATER })], [forked])).toEqual(new Map());
  });

  it('ignores an entry without a process, in the background, or in another project', async () => {
    await put([ORIGINAL, 'plain-original'], [FORK, 'plain-copy']);

    for (const listed of [entry({ pid: undefined as unknown as number }), entry({ kind: 'background' }), entry({ cwd: 'D:\\git\\other' })]) {
      expect(findForks(transcripts(), [listed], [session()])).toEqual(new Map());
    }
  });

  it('reads each transcript once per roster read, lists the projects only for a transcript not in its exact directory, and looks for a missing one again only after the retry interval', async () => {
    await put([ORIGINAL, 'plain-original']);
    writeFileSync(file(FORK), '{"type":"user"}\n');
    const sessions = Array.from({ length: 100 }, (_, index) => session({ id: `s${index}`, workItemId: index, nativeSessionId: index === 0 ? ORIGINAL : `cccccccc-0000-4000-8000-${String(index).padStart(12, '0')}` }));
    const index = transcripts();
    const spied = index as unknown as { locate: () => unknown; list: () => string[]; read: () => void };
    const locate = vi.spyOn(spied, 'locate');
    const list = vi.spyOn(spied, 'list');
    const read = vi.spyOn(spied, 'read');

    findForks(index, [entry()], sessions);
    // The fork has no key, so no session's transcript is read for it.
    expect(locate).toHaveBeenCalledTimes(1);
    findForks(index, [entry()], sessions);
    expect(locate).toHaveBeenCalledTimes(1);

    copyFileSync(fixture('plain-copy'), file(FORK));
    findForks(index, [entry()], sessions);
    // Every session is a target in the project; each session's transcript is looked for once, found or not.
    expect(locate).toHaveBeenCalledTimes(101);
    // The fork and the original are in their exact directory; each of the 99 missing transcripts lists the projects once.
    expect(list).toHaveBeenCalledTimes(99);
    const reads = read.mock.calls.length;
    findForks(index, [entry()], sessions);
    expect(locate).toHaveBeenCalledTimes(101);
    expect(list).toHaveBeenCalledTimes(99);
    // One read per transcript per pass: the fork and the original, although 100 sessions compare against them.
    expect(read.mock.calls.length - reads).toBe(2);
  });
});

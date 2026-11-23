import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionTitles, TRANSCRIPT_RETRY_MS } from '../src/sessionTitles.js';

let dir: string;
let now = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-session-titles-'));
  now = 1_000;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lines = (...entries: object[]): string => entries.map((entry) => JSON.stringify(entry) + '\n').join('');
const claude = (id: string, nativeSessionId: string | null, retiredIds: string[] = []) => ({ id, provider: 'claude' as const, nativeSessionId, retiredIds, cwd: 'D:/repo' });
const codex = (id: string, nativeSessionId: string) => ({ id, provider: 'codex' as const, nativeSessionId, retiredIds: [], cwd: 'D:/repo' });
const titles = () => new SessionTitles({ projectsDir: join(dir, 'projects'), codexHome: join(dir, 'codex'), now: () => now });

function transcript(id: string, text: string): string {
  mkdirSync(join(dir, 'projects', 'D--repo'), { recursive: true });
  const path = join(dir, 'projects', 'D--repo', `${id}.jsonl`);

  writeFileSync(path, text);
  return path;
}

describe('the name each CLI gives a session (architecture.md § Web page, Earlier sessions)', () => {
  it('ClaudeTranscript_CustomAndAiTitles_LatestCustomTitleWins', () => {
    const path = transcript('n1', lines({ type: 'user', message: 'hi' }, { type: 'ai-title', aiTitle: 'First guess' }));
    const names = titles();

    expect(names.title(claude('s1', 'n1'))).toBe('First guess');
    // A later ai-title replaces the earlier one; a custom-title, as /rename or a launch's --name writes, wins over any ai-title, earlier or later.
    appendFileSync(path, lines({ type: 'ai-title', aiTitle: 'Second guess' }));
    expect(names.title(claude('s1', 'n1'))).toBe('Second guess');
    appendFileSync(path, lines({ type: 'custom-title', customTitle: 'Chosen' }, { type: 'ai-title', aiTitle: 'Third guess' }));
    expect(names.title(claude('s1', 'n1'))).toBe('Chosen');
    appendFileSync(path, lines({ type: 'custom-title', customTitle: 'Renamed' }));
    expect(names.title(claude('s1', 'n1'))).toBe('Renamed');
    expect(names.version).toBe(3);
  });

  it('ClaudeTranscript_PartialLastLine_ReadOnceWhole', () => {
    const path = transcript('n1', lines({ type: 'ai-title', aiTitle: 'Whole' }) + '{"type":"custom-title","customTitle":"Ha');
    const names = titles();

    expect(names.title(claude('s1', 'n1'))).toBe('Whole');
    appendFileSync(path, 'lf"}\n');
    expect(names.title(claude('s1', 'n1'))).toBe('Half');
  });

  it('ClaudeTranscript_Replaced_ReadFromItsStart', () => {
    const path = transcript('n1', lines({ type: 'custom-title', customTitle: 'A long name for the old file' }));
    const names = titles();

    expect(names.title(claude('s1', 'n1'))).toBe('A long name for the old file');
    truncateSync(path, 0);
    writeFileSync(path, lines({ type: 'ai-title', aiTitle: 'New' }));
    expect(names.title(claude('s1', 'n1'))).toBe('New');
  });

  it('ClaudeTranscript_ReplacedBySameSizeOrLarger_ReadFromItsStart', () => {
    const path = transcript('n1', lines({ type: 'custom-title', customTitle: 'Old' }));
    const names = titles();

    expect(names.title(claude('s1', 'n1'))).toBe('Old');
    // As long, with other bytes and a new time.
    writeFileSync(path, lines({ type: 'custom-title', customTitle: 'New' }));
    utimesSync(path, new Date(5_000), new Date(5_000));
    expect(names.title(claude('s1', 'n1'))).toBe('New');
    // Longer, with no custom-title: the old one is gone with its file.
    writeFileSync(path, lines({ type: 'ai-title', aiTitle: 'Automatic, in a longer file' }));
    expect(names.title(claude('s1', 'n1'))).toBe('Automatic, in a longer file');
  });

  it('ClaudeTranscript_SwappedForSameSizeAndTime_ReadFromItsStart', () => {
    const path = transcript('n1', lines({ type: 'custom-title', customTitle: 'Old' }));
    const names = titles();

    utimesSync(path, new Date(5_000), new Date(5_000));
    expect(names.title(claude('s1', 'n1'))).toBe('Old');
    // Another file of the same size and time renamed over it, as an atomic save does: another inode.
    const next = `${path}.next`;

    writeFileSync(next, lines({ type: 'custom-title', customTitle: 'New' }));
    utimesSync(next, new Date(5_000), new Date(5_000));
    renameSync(next, path);
    expect(names.title(claude('s1', 'n1'))).toBe('New');
  });

  it('CodexIndex_ReplacedByLargerFile_ForgetsOldNames', () => {
    mkdirSync(join(dir, 'codex'));
    const index = join(dir, 'codex', 'session_index.jsonl');
    const names = titles();

    writeFileSync(index, lines({ id: 't1', thread_name: 'Old', updated_at: '' }));
    expect(names.title(codex('s1', 't1'))).toBe('Old');
    writeFileSync(index, lines({ id: 't2', thread_name: 'Another thread with a long name', updated_at: '' }, { id: 't1', thread_name: 'Rewritten', updated_at: '' }));
    expect(names.title(codex('s1', 't1'))).toBe('Rewritten');
    writeFileSync(index, lines({ id: 't2', thread_name: 'Another thread with a long name, now longer still', updated_at: '' }));
    expect(names.title(codex('s1', 't1'))).toBeNull();
  });

  it('ClaudeSession_NoNameYet_NullAndLooksAgainLater', () => {
    const names = titles();

    expect(names.title(claude('s1', null))).toBeNull();
    expect(names.title(claude('s1', 'n1'))).toBeNull();
    transcript('n1', lines({ type: 'ai-title', aiTitle: 'Found' }));
    // A transcript not found is looked for again only after a while.
    expect(names.title(claude('s1', 'n1'))).toBeNull();
    now += TRANSCRIPT_RETRY_MS;
    expect(names.title(claude('s1', 'n1'))).toBe('Found');
  });

  it('ClaudeSession_ResumedUnderNewId_NamedByTheTranscriptItLeft', () => {
    transcript('old', lines({ type: 'custom-title', customTitle: 'Before the resume' }));
    transcript('new', lines({ type: 'user', message: 'hi' }));

    expect(titles().title(claude('s1', 'new', ['old']))).toBe('Before the resume');
  });

  it('CodexIndex_ThreadNamedTwice_LatestNameWins', () => {
    mkdirSync(join(dir, 'codex'));
    const index = join(dir, 'codex', 'session_index.jsonl');
    const names = titles();

    expect(names.title(codex('s1', 't1'))).toBeNull();
    writeFileSync(index, lines({ id: 't1', thread_name: 'Greet user', updated_at: '' }, { id: 't2', thread_name: 'Other', updated_at: '' }));
    expect(names.title(codex('s1', 't1'))).toBe('Greet user');
    appendFileSync(index, lines({ id: 't1', thread_name: 'Renamed thread', updated_at: '' }));
    expect(names.title(codex('s1', 't1'))).toBe('Renamed thread');
    expect(names.title(codex('s2', 't2'))).toBe('Other');
    // Without a Codex home no thread has a name.
    expect(new SessionTitles({ projectsDir: dir, now: () => now }).title(codex('s1', 't1'))).toBeNull();
  });
});

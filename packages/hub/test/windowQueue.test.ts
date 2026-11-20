import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WindowQueue } from '../src/windowQueue.js';
import { tempHome } from './helpers.js';

const T0 = Date.UTC(2026, 9, 3, 12);

let temp: ReturnType<typeof tempHome>;

beforeEach(() => {
  temp = tempHome();
});

afterEach(() => temp.remove());

describe('WindowQueue', () => {
  it('hands a pending open to its destination window within two minutes, the newest for that window, and none to a window with no file', () => {
    let now = T0;
    const queue = WindowQueue.load(null, () => now);
    const seven = 'C:/h/windows/gh-7-000001.code-workspace';

    queue.recordOpen('a-native', 'D:/git/widgets-wt/7-fix', seven);
    now += 2 * 60_000;
    expect(queue.claimOpen(null)).toBeNull();
    expect(queue.claimOpen('c:\\h\\windows\\GH-7-000001.code-workspace')).toBe('a-native');

    queue.recordOpen('b-native', 'D:/git/widgets-wt/7-fix', seven);
    now += 2 * 60_000 + 1;
    expect(queue.claimOpen(seven)).toBeNull();

    queue.recordOpen('c-native', 'D:/git/widgets-wt/7-fix', seven);
    queue.recordOpen('d-native', 'D:/git/widgets-wt/7-fix/', seven);
    expect(queue.claimOpen(seven)).toBe('d-native');
    expect(queue.claimOpen(seven)).toBeNull();
  });

  it('hands commands the dock left to the window on their workspace file, or to the first window for any, within two minutes (PRD R71)', () => {
    let now = T0;
    const queue = WindowQueue.load(null, () => now);
    const file = 'C:/h/windows/gh-7-58c609.code-workspace';

    queue.recordCommand({ type: 'changes', path: 'D:/wt', key: 'gh 7', title: 'T' }, file);
    queue.recordCommand({ type: 'settings' }, null);
    // A window in the background, such as one reconnecting, takes only its own workspace's commands.
    expect(queue.claimCommands('C:/h/windows/gh-8-000000.code-workspace', false)).toEqual([]);
    expect(queue.claimCommands('C:/h/windows/gh-8-000000.code-workspace', true)).toEqual([{ type: 'settings' }]);
    expect(queue.claimCommands(null, true)).toEqual([]);
    expect(queue.claimCommands('c:\\h\\windows\\GH-7-58c609.code-workspace', false)).toEqual([{ type: 'changes', path: 'D:/wt', key: 'gh 7', title: 'T' }]);
    expect(queue.claimCommands(file, true)).toEqual([]);

    const withdrawn = queue.recordCommand({ type: 'settings' }, null)!;

    expect(queue.withdrawCommand(withdrawn)).toBe(true);
    expect(queue.withdrawCommand(withdrawn)).toBe(false);
    expect(queue.claimCommands(null, true)).toEqual([]);

    queue.recordCommand({ type: 'settings' }, null);
    now += 2 * 60_000 + 1;
    expect(queue.claimCommands(null, true)).toEqual([]);
  });

  it('hands a pending open the dock left for an item window only to the window on that workspace file (PRD R71)', () => {
    const queue = WindowQueue.load(null, () => T0);
    const file = 'C:/Users/me/.switchboard/windows/gh-7-widgets-655280.code-workspace';

    queue.recordOpen('a-native', 'D:/git/widgets', file);
    expect(queue.claimOpen(null)).toBeNull();
    expect(queue.claimOpen('C:/Users/me/.switchboard/windows/gh-8-widgets-655280.code-workspace')).toBeNull();
    expect(queue.claimOpen('c:\\users\\me\\.switchboard\\windows\\GH-7-widgets-655280.code-workspace')).toBe('a-native');
    expect(queue.claimOpen(file)).toBeNull();
  });

  it('keeps what no window claimed for the next queue loaded from its file, which drops what expired and continues the command IDs', () => {
    let now = T0;
    const path = join(temp.home, 'window-queue.json');
    const file = 'C:/h/windows/gh-7-58c609.code-workspace';
    const first = WindowQueue.load(path, () => now);

    first.recordOpen('old-native', 'D:/git/widgets-wt/6-fix', 'C:/h/windows/gh-6-000000.code-workspace');
    now += 60_000;
    first.recordOpen('a-native', 'D:/git/widgets-wt/7-fix', file);
    first.recordCommand({ type: 'openTabs' }, file);
    const changes = first.recordCommand({ type: 'changes', path: 'D:/wt', key: 'gh 7', title: 'T' }, file)!;
    const claimed = first.recordCommand({ type: 'settings' }, null)!;

    expect(first.claimCommands(null, true)).toEqual([{ type: 'settings' }]);
    expect(first.withdrawCommand(changes)).toBe(true);

    now += 60_000 + 1;
    const second = WindowQueue.load(path, () => now);

    expect(second.claimOpen('C:/h/windows/gh-6-000000.code-workspace')).toBeNull();
    expect(second.claimOpen(file)).toBe('a-native');
    // An ID the dock got from the earlier hub withdraws nothing it did not leave.
    expect(second.recordCommand({ type: 'settings' }, null)).toBe(claimed + 1);
    expect(second.withdrawCommand(changes)).toBe(false);
    expect(second.claimCommands(file, false)).toEqual([{ type: 'openTabs' }]);

    const third = WindowQueue.load(path, () => now);

    expect(third.claimOpen(file)).toBeNull();
    expect(third.claimCommands(file, true)).toEqual([{ type: 'settings' }]);
  });

  it('keeps opens for two item windows on one folder apart, as for two Support work items', () => {
    const queue = WindowQueue.load(null, () => T0);
    const a = 'C:/h/windows/zoho-1-000001.code-workspace';
    const b = 'C:/h/windows/zoho-2-000002.code-workspace';

    queue.recordOpen('a-native', 'D:/git/support', a);
    queue.recordOpen('b-native', 'D:/git/support', b);
    expect(queue.claimOpen(b)).toBe('b-native');
    expect(queue.claimOpen(b)).toBeNull();
    expect(queue.claimOpen(a)).toBe('a-native');
  });

  it('starts empty from a missing or unreadable file, and skips malformed entries', () => {
    const path = join(temp.home, 'window-queue.json');

    expect(WindowQueue.load(path, () => T0).claimCommands(null, true)).toEqual([]);
    writeFileSync(path, '{"opens": [');
    expect(WindowQueue.load(path, () => T0).recordCommand({ type: 'settings' }, null)).toBe(1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ nextId: 2, commands: [{ id: 1, command: { type: 'settings' } }] });
    writeFileSync(path, '{"opens": "x", "commands": [], "nextId": 4}');
    expect(WindowQueue.load(path, () => T0).recordCommand({ type: 'settings' }, null)).toBe(1);

    writeFileSync(path, JSON.stringify({
      opens: [null, { folder: 'd:/a', sessionId: 7, at: T0, workspace: 'w-a' }, { folder: 'd:/c', sessionId: 'c-native', at: T0, workspace: null }, { folder: 'd:/b', sessionId: 'b-native', at: T0, workspace: 'w-b' }],
      commands: [null, { id: 'x', command: {}, at: T0, workspace: null }, { id: 3, command: null, at: T0, workspace: null }, { id: 4, command: { type: 'settings' }, at: T0, workspace: null }],
      nextId: 5,
    }));
    const kept = WindowQueue.load(path, () => T0);

    expect(kept.claimOpen('w-a')).toBeNull();
    // An open with no destination window was a wildcard before; it is dropped.
    expect(kept.claimOpen('w-c')).toBeNull();
    expect(kept.claimOpen('w-b')).toBe('b-native');
    expect(kept.claimCommands(null, true)).toEqual([{ type: 'settings' }]);
  });

  it('refuses an open or command it cannot save, so a later hub never reuses an ID the dock holds', () => {
    const path = join(temp.home, 'window-queue.json');
    const logs: string[] = [];
    const first = WindowQueue.load(path, () => T0, (line) => logs.push(line));
    const saved = first.recordCommand({ type: 'settings' }, null)!;

    // A folder where the temporary file should be makes every write fail.
    mkdirSync(`${path}.tmp`);
    expect(first.recordCommand({ type: 'history', ticketId: 3, key: 'gh 3' }, null)).toBeNull();
    expect(first.recordOpen('a-native', 'D:/git/widgets', 'w-a')).toBe(false);
    expect(first.claimOpen('w-a')).toBeNull();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/^window queue not saved to .*window-queue\.json: /);
    // A claim the file does not record still hands the command over once in this hub.
    expect(first.claimCommands(null, true)).toEqual([{ type: 'settings' }]);
    expect(first.claimCommands(null, true)).toEqual([]);
    rmdirSync(`${path}.tmp`);

    const second = WindowQueue.load(path, () => T0);
    const next = second.recordCommand({ type: 'openUrl', url: 'D:/r.md' }, null)!;

    expect(next).toBe(saved + 1);
    expect(second.withdrawCommand(saved)).toBe(true);
    expect(second.claimCommands(null, true)).toEqual([{ type: 'openUrl', url: 'D:/r.md' }]);
  });
});

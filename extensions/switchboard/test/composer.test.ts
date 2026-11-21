import type { ItemView, MessageView, SessionView, ScopeView } from '@switchboard/hub';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandQuery, excludeGlob, fileGlob, matchCommands, mentionOf, mentionQuery, messageHistory, pathOfUri, rankFiles, relativeTo, sendsAsCommand } from '../src/composerModel.js';
import type { ConversationState } from '../src/conversationModel.js';
import { writePastedImage } from '../src/pastedImages.js';
import { SHIFT_HINT, VS_CODE_FILES_ONLY } from '../src/webview/composerExtras.js';
import { startConversation } from '../src/webview/conversationMain.js';

const T0 = Date.UTC(2026, 10, 19, 12);
const SCOPE: ScopeView = { kind: 'item', workItemId: 2, key: 'k1', folder: 'D:\\w', title: 'Fix the badge', cwd: 'D:\\w', scopeGen: 1, sessionId: 's2', conversations: [{ workItemId: 2, title: 'Fix the badge', primary: true, sessionId: 's2', state: 'idle', conversation: 'full', unread: 0 }] };
const SESSION: SessionView = { id: 's2', kind: 'task', title: 'Task session aaaa', state: 'idle', waitingFor: null, launch: 'l', current: true, conversation: 'full', reason: null, persona: null };
const message = (id: string, text: string, patch: Partial<MessageView> = {}): MessageView => ({ type: 'message', id, sessionId: 's2', workItemId: 2, at: T0, ord: T0, origin: 'terminal', text, provisional: false, withdrawn: false, delivery: null, error: null, ...patch });
const state = (patch: Partial<ConversationState> = {}): ConversationState => ({ scope: SCOPE, session: SESSION, items: [], more: false, connected: true, status: null, artifactsDir: null, artifacts: [], unread: 0, voice: null, settings: { expandReplies: false }, ...patch });
const COMMANDS = [
  { name: 'clear', description: 'Clear the conversation history and free up context' },
  { name: 'compact', description: 'Clear the conversation history but keep a summary in context.' },
  { name: 'hello7', description: 'Say hello seven' },
  { name: 'sb-plan', description: 'Start development <with> planning' },
];

describe('mentions', () => {
  it('names a path relative to the session folder, without case on Windows, and absolute outside it', () => {
    expect(relativeTo('D:\\w\\src\\a.ts', 'D:\\w')).toBe('src/a.ts');
    expect(relativeTo('d:/W/src/a.ts', 'D:\\w\\')).toBe('src/a.ts');
    expect(relativeTo('D:\\wx\\a.ts', 'D:\\w')).toBe('D:/wx/a.ts');
    expect(relativeTo('/home/me/w/a.ts', '/home/me/w')).toBe('a.ts');
    expect(relativeTo('/home/me/W/a.ts', '/home/me/w')).toBe('/home/me/W/a.ts');
    expect(relativeTo('C:\\t\\p.png', null)).toBe('C:/t/p.png');
  });

  it('quotes a path as Claude Code does: with a space or a colon, or ending in punctuation, and names no path with a quote', () => {
    expect(mentionOf('src/a.ts')).toBe('@src/a.ts');
    expect(mentionOf('src/')).toBe('@src/');
    expect(mentionOf('dir with space/x.txt')).toBe('@"dir with space/x.txt"');
    expect(mentionOf('C:/t/p.png')).toBe('@"C:/t/p.png"');
    expect(mentionOf('notes.')).toBe('@"notes."');
    expect(mentionOf('a"b')).toBeNull();
    expect(mentionOf('a\nb')).toBeNull();
    expect(mentionOf('')).toBeNull();
  });

  it('reads a dropped file:, vscode-remote: or UNC URI as a path, and nothing else', () => {
    expect(pathOfUri('file:///d%3A/git/w/a%20b.ts')).toBe('d:/git/w/a b.ts');
    expect(pathOfUri('file:///home/me/a.ts')).toBe('/home/me/a.ts');
    expect(pathOfUri('file://server/share/a.ts')).toBe('//server/share/a.ts');
    expect(pathOfUri('vscode-remote://wsl%2Bubuntu/home/me/a.ts')).toBe('/home/me/a.ts');
    expect(pathOfUri('vscode-remote://host')).toBeNull();
    expect(pathOfUri('https://x.test/a.ts')).toBeNull();
    expect(pathOfUri('file:///bad%E0%A4%A')).toBeNull();
  });

  it('finds the query of an @ before the caret at the start or after a space, quoted or not, and none inside a word', () => {
    expect(mentionQuery('@')).toEqual({ start: 0, query: '' });
    expect(mentionQuery('look at @src/co')).toEqual({ start: 8, query: 'src/co' });
    expect(mentionQuery('look at @"dir wi')).toEqual({ start: 8, query: 'dir wi' });
    expect(mentionQuery('mail me@example')).toBeNull();
    expect(mentionQuery('@a.ts and more')).toBeNull();
    expect(commandQuery('/')).toBe('');
    expect(commandQuery('/comp')).toBe('comp');
    expect(commandQuery('/compact now')).toBeNull();
    expect(commandQuery(' /compact')).toBeNull();
    expect(commandQuery('a/b')).toBeNull();
  });

  it('searches without case, escaping glob characters, and ranks a name that starts with the query before a path that holds it', () => {
    expect(fileGlob('')).toBe('**/*');
    expect(fileGlob('Ab1/[x],')).toBe('{**/*[aA][bB]1/[[][xX][]]?*,**/*[aA][bB]1/[[][xX][]]?*/**}');
    expect(rankFiles(['src/conversation.ts', 'docs/con.md', 'test/a-conv.ts', 'src\\deep\\x.ts'], 'con')).toEqual([
      { path: 'docs/con.md', dir: false },
      { path: 'src/conversation.ts', dir: false },
      { path: 'test/a-conv.ts', dir: false },
    ]);
    // A folder named by the query first; the rest hold it only in their path, shorter first.
    expect(rankFiles(['src/a/b.ts', 'src/c.ts'], 'src')).toEqual([
      { path: 'src/', dir: true },
      { path: 'src/a/', dir: true },
      { path: 'src/c.ts', dir: false },
      { path: 'src/a/b.ts', dir: false },
    ]);
    expect(rankFiles(Array.from({ length: 80 }, (_, index) => `f${index}.ts`), '')).toHaveLength(50);
  });

  it('excludes the folders Claude Code leaves out and the settings patterns that are on', () => {
    const glob = excludeGlob({ '**/.vs': true, '**/off': false, '**/{private,secrets}/**': true, '{a,b}/{c,d}': true, '**/{x,{y,z}}': true, '**/when': { when: '$(basename).ts' } }, { '**/out': true }, undefined);

    expect(glob.startsWith('{**/node_modules/**,**/.git/**,')).toBe(true);
    // A setting's braces are expanded, nested ones too, since the list's own braces cannot hold them.
    expect(glob.endsWith(',**/.vs,**/private/**,**/secrets/**,a/c,a/d,b/c,b/d,**/x,**/y,**/z,**/out}')).toBe(true);
    expect(glob).not.toContain('off');
    expect(excludeGlob({ '**/{a,b': true, '**/a}': true })).toBe(excludeGlob());
    expect(glob).not.toContain('when');
    expect(excludeGlob({ [`{${Array.from({ length: 9 }, (_, index) => index).join(',')}}/{${Array.from({ length: 9 }, (_, index) => index).join(',')}}`]: true })).toBe(excludeGlob());
  });

  it('lists commands that start with the query first, then those that hold it', () => {
    expect(matchCommands(COMMANDS, 'C').map((command) => command.name)).toEqual(['clear', 'compact']);
    expect(matchCommands(COMMANDS, 'pl').map((command) => command.name)).toEqual(['sb-plan']);
    expect(matchCommands(COMMANDS, 'e').map((command) => command.name)).toEqual(['clear', 'hello7']);
    expect(matchCommands(COMMANDS, 'zz')).toEqual([]);
  });

  it('walks the messages, not withdrawn ones or replies, a repeat once; and sends as the chosen command only while the text starts with it', () => {
    const items: ItemView[] = [message('m1', 'One'), message('m2', 'One'), message('m3', 'Gone', { withdrawn: true }), message('m4', 'Two', { origin: 'typed', delivery: 'sent' })];

    expect(messageHistory(items)).toEqual(['One', 'Two']);
    expect(sendsAsCommand('/compact', 'compact')).toBe(true);
    expect(sendsAsCommand(' /compact keep it ', 'compact')).toBe(true);
    expect(sendsAsCommand('/compactly', 'compact')).toBe(false);
    expect(sendsAsCommand('/compact\nmore', 'compact')).toBe(false);
    expect(sendsAsCommand('/compact', null)).toBe(false);
    expect(sendsAsCommand('please /compact', 'compact')).toBe(false);
  });
});

describe('pasted images', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pasted-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a pasted image under a name with its time, deleting those older than a week, and refuses other types and sizes', () => {
    const now = new Date(2026, 10, 19, 21, 5, 9).getTime();
    const old = join(dir, 'pasted-20261101-101010-aaaaaa.png');
    const recent = join(dir, 'pasted-20261118-101010-bbbbbb.gif');

    writeFileSync(old, 'x');
    writeFileSync(recent, 'x');
    utimesSync(old, new Date(now - 8 * 86_400_000), new Date(now - 8 * 86_400_000));
    utimesSync(recent, new Date(now - 86_400_000), new Date(now - 86_400_000));

    const written = writePastedImage('image/png', Buffer.from('PNG bytes').toString('base64'), now, dir);

    expect(written).toEqual({ path: expect.stringMatching(/pasted-20261119-210509-[0-9a-f]{6}\.png$/) });
    expect(readFileSync((written as { path: string }).path, 'utf8')).toBe('PNG bytes');
    expect(readdirSync(dir).sort()).toEqual(['pasted-20261118-101010-bbbbbb.gif', (written as { path: string }).path.split(/[\\/]/).pop()].sort());
    expect(writePastedImage('image/jpeg', 'AAAA', now, dir)).toEqual({ path: expect.stringMatching(/\.jpg$/) });
    expect(writePastedImage('image/svg+xml', 'AAAA', now, dir)).toEqual({ error: 'Only PNG, JPEG, GIF and WebP images can be pasted.' });
    expect(writePastedImage('image/png', '', now, dir)).toEqual({ error: 'The pasted image is empty.' });
    expect(writePastedImage('image/png', Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'), now, dir)).toEqual({ error: 'The pasted image is larger than 10 MB.' });
  });

  it('deletes only its own old images, never another file, a folder or anything through a link', () => {
    const now = new Date(2026, 10, 19, 21, 5, 9).getTime();
    const week = new Date(now - 8 * 86_400_000);
    const target = mkdtempSync(join(tmpdir(), 'pasted-target-'));

    try {
      for (const name of ['important.txt', 'pasted-20261101-101010-abcdef.png.bak']) {
        writeFileSync(join(dir, name), 'x');
        utimesSync(join(dir, name), week, week);
      }

      mkdirSync(join(dir, 'pasted-20261101-101010-abcdef.png'));
      writePastedImage('image/png', 'AAAA', now, dir);
      expect(readdirSync(dir).filter((name) => !name.startsWith('pasted-2026111')).sort()).toEqual(['important.txt', 'pasted-20261101-101010-abcdef.png', 'pasted-20261101-101010-abcdef.png.bak']);

      // A folder that is a link or junction is refused before anything in its target is read or deleted.
      const old = join(target, 'pasted-20261101-101010-abcdef.png');

      writeFileSync(old, 'x');
      utimesSync(old, week, week);
      symlinkSync(target, join(dir, 'linked'), 'junction');
      expect(writePastedImage('image/png', 'AAAA', now, join(dir, 'linked'))).toEqual({ error: `The pasted image was not saved: ${join(dir, 'linked')} is not a plain folder.` });
      expect(readdirSync(target)).toEqual(['pasted-20261101-101010-abcdef.png']);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('the composer extras', () => {
  function page(saved: unknown = null) {
    if (typeof CSS === 'undefined') {
      vi.stubGlobal('CSS', { escape: (value: string) => value });
    }

    const root = document.createElement('div');
    const live = document.createElement('div');
    const host = document.createElement('div');
    const posted: Array<{ type: string; [field: string]: unknown }> = [];
    let kept: unknown = saved;
    const vscode = { postMessage: (one: { type: string }) => posted.push(one), getState: () => kept, setState: (next: unknown) => void (kept = next) };

    host.id = 'composer';
    document.body.replaceChildren(root, host, live);
    startConversation(root, live, vscode, host);

    const input = host.querySelector('textarea')!;
    const menu = host.querySelector<HTMLElement>('.composer-menu')!;
    const reply = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));
    const show = (next: ConversationState) => reply({ type: 'state', state: next });
    const press = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });

      input.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const type = (text: string, caret = text.length) => {
      input.value = text;
      input.setSelectionRange(caret, caret);
      input.dispatchEvent(new Event('input'));
    };
    const of = (kind: string) => posted.filter((one) => one.type === kind);
    const rows = () => [...menu.querySelectorAll<HTMLElement>('.menu-item')].map((row) => row.textContent);
    const error = () => (host.querySelector<HTMLElement>('.composer-error')!.hidden ? null : host.querySelector('.composer-error-text')!.textContent);

    return { host, input, menu, posted, reply, show, press, type, of, rows, error, state: () => kept };
  }

  it('lists files after an @, as the query narrows, and puts the chosen one in as a mention', () => {
    vi.useFakeTimers();

    try {
      const { input, menu, reply, show, press, type, of, rows } = page();

      show(state());
      type('Look at @co');
      expect(menu.hidden).toBe(false);
      expect(menu.textContent).toBe('Searching…');
      expect(input.getAttribute('aria-expanded')).toBe('true');
      vi.advanceTimersByTime(80);
      expect(of('files')).toEqual([{ type: 'files', id: 1, query: 'co' }]);

      // An answer to an older query is dropped.
      type('Look at @con');
      vi.advanceTimersByTime(80);
      reply({ type: 'files', id: 1, items: [{ path: 'old.ts', dir: false }] });
      expect(rows()).toEqual([]);
      reply({ type: 'files', id: 2, items: [{ path: 'src/conversation.ts', dir: false }, { path: 'dir with space/con.md', dir: false }, { path: 'src/', dir: true }] });
      expect(rows()).toEqual(['conversation.tssrc', 'con.mddir with space', 'src/']);
      expect(menu.querySelector('.menu-item.active')?.getAttribute('aria-selected')).toBe('true');
      expect(input.getAttribute('aria-activedescendant')).toBe('composer-option-0');

      expect(press('ArrowDown')).toBe(true);
      expect(input.getAttribute('aria-activedescendant')).toBe('composer-option-1');
      expect(press('Enter')).toBe(true);
      expect(input.value).toBe('Look at @"dir with space/con.md" ');
      expect(menu.hidden).toBe(true);
      expect(of('send')).toEqual([]);

      // Up wraps to the last row; Tab chooses; a folder stays open to go on into it.
      type('Look at @"dir with space/con.md" and @s');
      vi.advanceTimersByTime(80);
      reply({ type: 'files', id: 3, items: [{ path: 'src/', dir: true }, { path: 'src/a.ts', dir: false }] });
      press('ArrowUp');
      press('ArrowUp');
      expect(press('Tab')).toBe(true);
      expect(input.value).toBe('Look at @"dir with space/con.md" and @src/');
      expect(menu.hidden).toBe(false);
      vi.advanceTimersByTime(80);
      expect(of('files').at(-1)).toEqual({ type: 'files', id: 4, query: 'src/' });

      // Escape closes the list without touching the text; no match says so.
      reply({ type: 'files', id: 4, items: [] });
      expect(menu.textContent).toBe('No matching files');
      expect(press('Escape')).toBe(true);
      expect(menu.hidden).toBe(true);
      expect(input.value).toBe('Look at @"dir with space/con.md" and @src/');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the context meter as one ring after the message tools, its numbers in the tooltip, and posts /compact only after Compact is confirmed (architecture.md § Context meter)', () => {
    const { host, input, reply, show, type, of, error } = page();
    const context = { used: 150_000, window: 200_000, compactAt: 167_000, model: 'claude-sonnet-4-6' };
    const slot = host.querySelector<HTMLElement>('.composer-controls .context-meter')!;
    const ring = () => slot.querySelector<HTMLButtonElement>('button.context-ring')!;

    show(state({ session: { ...SESSION, context } }));
    expect(host.querySelector('.composer-controls')!.lastElementChild).toBe(slot);
    expect(ring().textContent).toBe('');
    expect(ring().classList.contains('warn')).toBe(true);
    expect(ring().getAttribute('aria-label')).toContain('Context: 75% · 150k / 200k tokens');
    show(state({ session: { ...SESSION, context: { ...context, used: 20_000 } } }));
    expect(ring().classList.contains('ok')).toBe(true);

    type('my draft');
    ring().click();
    expect(slot.querySelector('.context-menu')!.textContent).toContain('Context: 10% · 20k / 200k tokens');
    slot.querySelector<HTMLButtonElement>('[data-context="compact"]')!.click();
    expect(of('send')).toEqual([]);
    expect(document.activeElement).toBe(slot.querySelector('[data-context="compact-confirm"]'));
    slot.querySelector<HTMLButtonElement>('[data-context="compact-confirm"]')!.click();
    expect(of('send')).toEqual([{ type: 'send', id: 2_000_000, text: '/compact', target: { scopeGen: 1, sessionId: 's2', launch: 'l' }, command: true }]);
    expect(slot.querySelector('.context-menu')).toBeNull();
    expect(input.value).toBe('my draft');
    // A refusal shows above the box and leaves the draft.
    reply({ type: 'sent', id: 2_000_000, error: 'The session has ended.' });
    expect(error()).toBe('The session has ended.');
    expect(input.value).toBe('my draft');
    expect(input.readOnly).toBe(false);

    // A refusal that comes after another conversation was selected waits for its own conversation.
    const other = { ...SCOPE, workItemId: 3, sessionId: 's3', conversations: [...SCOPE.conversations, { workItemId: 3, title: 'Other', primary: false, sessionId: 's3', state: 'idle' as const, conversation: 'full' as const, unread: 0 }] };

    ring().click();
    slot.querySelector<HTMLButtonElement>('[data-context="compact"]')!.click();
    slot.querySelector<HTMLButtonElement>('[data-context="compact-confirm"]')!.click();
    show(state({ scope: other, session: { ...SESSION, id: 's3', context } }));
    reply({ type: 'sent', id: 2_000_001, error: 'Compact refused.' });
    expect(error()).toBeNull();
    show(state({ scope: { ...other, workItemId: 2, sessionId: 's2' }, session: { ...SESSION, context } }));
    expect(error()).toBe('Compact refused.');

    // Escape and a click elsewhere close the menu.
    ring().click();
    slot.querySelector('.context-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(slot.querySelector('.context-menu')).toBeNull();
    ring().click();
    document.body.click();
    expect(slot.querySelector('.context-menu')).toBeNull();

    // An unknown size is the empty ring, and a session the composer cannot talk to gets no Compact.
    show(state({ session: { ...SESSION, conversation: 'read-only', reason: 'Ended.', context: null } }));
    expect(ring().classList.contains('unknown')).toBe(true);
    ring().click();
    expect(slot.querySelector('[data-context="compact"]')).toBeNull();
  });

  it("lists the session's commands after a leading slash, fills the chosen one in, and sends it as a command only while the text starts with it", () => {
    const { host, input, menu, reply, show, press, type, of, rows, error } = page();

    show(state());
    type('/');
    expect(of('commands')).toEqual([{ type: 'commands', id: 1 }]);
    reply({ type: 'commands', id: 1, commands: COMMANDS, error: null });
    expect(rows()).toEqual(['/clearClear the conversation history and free up context', '/compactClear the conversation history but keep a summary in context.', '/hello7Say hello seven', '/sb-planStart development <with> planning']);
    expect(menu.innerHTML).toContain('&lt;with&gt;');
    expect(menu.querySelectorAll('.menu-description')[3]!.textContent).toBe('Start development <with> planning');

    type('/co');
    expect(rows()).toEqual(['/compactClear the conversation history but keep a summary in context.']);
    expect(press('Enter')).toBe(true);
    expect(input.value).toBe('/compact ');
    expect(menu.hidden).toBe(true);
    // Arguments may follow; Enter then sends it as the command.
    type('/compact keep the plan');
    press('Enter');
    expect(of('send')).toEqual([{ type: 'send', id: 1, text: '/compact keep the plan', target: { scopeGen: 1, sessionId: 's2', launch: 'l' }, command: true }]);
    reply({ type: 'sent', id: 1, error: null });

    // A command the operator typed without choosing it, or one whose name was edited, goes as a message.
    type('/hello7');
    reply({ type: 'commands', id: 2, commands: COMMANDS, error: null });
    press('Escape');
    press('Enter');
    expect(of('send')[1]).toEqual({ type: 'send', id: 2, text: '/hello7', target: { scopeGen: 1, sessionId: 's2', launch: 'l' } });
    reply({ type: 'sent', id: 2, error: null });
    type('/he');
    press('Enter');
    expect(input.value).toBe('/hello7 ');
    type('/hellox');
    type('/hellox now');
    press('Enter');
    expect(of('send')[2]).not.toHaveProperty('command');
    reply({ type: 'sent', id: 3, error: null });

    // The slash button opens the list, putting a slash before a draft; the hub's refusal shows above the box.
    type('the rest');
    host.querySelector<HTMLButtonElement>('button.slash')!.click();
    expect(input.value).toBe('/ the rest');
    expect(of('commands').at(-1)).toMatchObject({ type: 'commands' });
    reply({ type: 'commands', id: (of('commands').at(-1)!['id'] as number), commands: null, error: 'Not in this window.' });
    expect(error()).toBe('Not in this window.');
    expect(menu.hidden).toBe(true);
  });

  it('chooses a command with the mouse, keeping the text after the caret, and asks again for another session', () => {
    const { input, menu, reply, show, type, of } = page();

    show(state());
    type('/ the rest', 1);
    reply({ type: 'commands', id: 1, commands: COMMANDS, error: null });
    menu.querySelectorAll<HTMLElement>('.menu-item')[2]!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(menu.querySelector('.menu-item.active')?.textContent).toBe('/hello7Say hello seven');
    menu.querySelectorAll<HTMLElement>('.menu-item')[2]!.click();
    expect(input.value).toBe('/hello7 the rest');

    show(state({ session: { ...SESSION, id: 's9' }, scope: { ...SCOPE, sessionId: 's9' } }));
    type('/');
    expect(of('commands')).toHaveLength(2);
  });

  it('walks earlier messages with Up and Down at the edges of the box, and gives back the draft after the newest', () => {
    const { input, show, press, type } = page();

    show(state({ items: [message('m1', 'First'), message('m2', 'Second\nline')] }));
    type('draft');
    expect(press('ArrowUp')).toBe(true);
    expect(input.value).toBe('Second\nline');
    // On the last line of a recalled message Up first moves up through it.
    expect(press('ArrowUp')).toBe(false);
    input.setSelectionRange(0, 0);
    expect(press('ArrowUp')).toBe(true);
    expect(input.value).toBe('First');
    expect(press('ArrowUp')).toBe(true);
    expect(input.value).toBe('First');
    expect(press('ArrowDown')).toBe(true);
    expect(input.value).toBe('Second\nline');
    expect(press('ArrowDown')).toBe(true);
    expect(input.value).toBe('draft');
    expect(press('ArrowDown')).toBe(false);

    // Not with a selection, a modifier or text above the caret.
    type('a\nb');
    expect(press('ArrowUp')).toBe(false);
    input.setSelectionRange(0, 1);
    expect(press('ArrowUp')).toBe(false);
    input.setSelectionRange(0, 0);
    expect(press('ArrowUp', { shiftKey: true })).toBe(false);
    // Typing ends the walk, so the edit is the new draft.
    expect(press('ArrowUp')).toBe(true);
    type('First, edited');
    expect(press('ArrowDown')).toBe(false);
  });

  it('keeps a draft and its chosen command for each conversation of the window', () => {
    const first = page();
    const other = state({ scope: { ...SCOPE, workItemId: 9, sessionId: 's9', scopeGen: 2, conversations: [...SCOPE.conversations, { workItemId: 9, title: 'New session', primary: false, sessionId: 's9', state: 'idle', conversation: 'full', unread: 0 }] }, session: { ...SESSION, id: 's9' } });

    first.show(state());
    first.type('/');
    first.reply({ type: 'commands', id: 1, commands: COMMANDS, error: null });
    first.press('Enter');
    first.type('/clear now');
    first.show(other);
    expect(first.input.value).toBe('');
    first.type('/clear later');
    first.press('Enter');
    // The command was chosen in the other conversation, so this one sends its text as a message.
    expect(first.of('send').at(-1)).not.toHaveProperty('command');
    first.reply({ type: 'sent', id: 1, error: null });
    first.show(state());
    expect(first.input.value).toBe('/clear now');
    first.press('Enter');
    expect(first.of('send').at(-1)).toMatchObject({ text: '/clear now', command: true });
  });

  it('keeps the draft and its chosen command in the page state, and takes them back on a reload', () => {
    const first = page();

    first.show(state());
    first.type('/');
    first.reply({ type: 'commands', id: 1, commands: COMMANDS, error: null });
    first.press('Enter');
    first.type('/clear now');
    // Kept by conversation, so each conversation of the window has its own (architecture.md § Conversation view).
    expect(first.state()).toMatchObject({ drafts: { 2: { text: '/clear now', command: 'clear' } } });

    const second = page(first.state());

    second.show(state());
    expect(second.input.value).toBe('/clear now');
    second.press('Enter');
    expect(second.of('send')).toEqual([{ type: 'send', id: 1, text: '/clear now', target: { scopeGen: 1, sessionId: 's2', launch: 'l' }, command: true }]);
    second.reply({ type: 'sent', id: 1, error: null });
    expect((second.state() as { drafts: unknown }).drafts).toEqual({});

    // A saved command no longer at the start of the draft is not taken back.
    const third = page({ drafts: { 2: { text: 'hi /clear', command: 'clear' } }, open: ['x'], scroll: null });

    third.show(state());
    expect(third.input.value).toBe('hi /clear');
    third.press('Enter');
    expect(third.of('send')[0]).not.toHaveProperty('command');
    expect(third.state()).toMatchObject({ open: ['x'] });
  });

  it('attaches files picked in the dialog, dropped from VS Code or pasted as an image, as mentions at the caret', async () => {
    const { host, input, reply, show, type, of, error } = page();

    show(state());
    type('Compare  please', 8);
    host.querySelector<HTMLButtonElement>('button.attach')!.click();
    expect(of('attach')).toEqual([{ type: 'attach' }]);
    reply({ type: 'mentions', paths: ['d:\\w\\src\\a.ts', 'D:\\elsewhere\\b c.ts', 'D:\\w\\bad"name.ts'] });
    expect(input.value).toBe('Compare @src/a.ts @"D:/elsewhere/b c.ts"  please');
    expect(error()).toBe('This path cannot be mentioned: D:\\w\\bad"name.ts');

    // A drop with Shift held from the Explorer carries VS Code's resource list.
    type('See', 3);
    const drop = (data: Record<string, string>, types = Object.keys(data)) => {
      const event = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };

      event.dataTransfer = { types, getData: (kind: string) => data[kind] ?? '' };
      document.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(drop({ resourceurls: JSON.stringify(['file:///d%3A/w/docs/x.md']), 'text/uri-list': 'file:///d%3A/w/docs/x.md\r\nfile:///d%3A/w/y.ts' })).toBe(true);
    expect(input.value).toBe('See @docs/x.md @y.ts ');
    expect(drop({ codeeditors: JSON.stringify([{ resource: { external: 'file:///d%3A/w/z.ts' } }]) })).toBe(true);
    expect(input.value).toBe('See @docs/x.md @y.ts @z.ts ');
    // Files from the operating system carry no path.
    expect(drop({}, ['Files'])).toBe(true);
    expect(error()).toBe(VS_CODE_FILES_ONLY);
    expect(drop({ 'text/plain': 'x' })).toBe(false);

    // A drag VS Code took over at once says to hold Shift.
    const drag = (kind: string, types: string[]) => {
      const event = new Event(kind, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown; relatedTarget: unknown };

      event.dataTransfer = { types };
      event.relatedTarget = null;
      document.dispatchEvent(event);
    };

    drag('dragenter', ['resourceurls']);
    expect(host.classList.contains('drop-target')).toBe(true);
    drag('dragleave', ['resourceurls']);
    expect(host.classList.contains('drop-target')).toBe(false);
    expect(error()).toBe(SHIFT_HINT);

    // A pasted picture is written by the extension and mentioned by its path.
    type('What is this? ', 14);
    const paste = (files: File[], types: string[]) => {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };

      event.clipboardData = { files, types };
      input.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(paste([new File(['img'], 'a.png', { type: 'image/png' })], ['text/plain', 'Files'])).toBe(false);
    expect(paste([new File(['img'], 'a.png', { type: 'image/png' })], ['Files'])).toBe(true);
    await vi.waitFor(() => expect(of('image')).toHaveLength(1));
    expect(of('image')[0]).toMatchObject({ type: 'image', mime: 'image/png', data: btoa('img') });

    const id = of('image')[0]!['id'] as number;

    reply({ type: 'image', id: id + 100, path: 'C:\\t\\other.png', error: null });
    expect(input.value).toBe('What is this? ');
    reply({ type: 'image', id, path: 'C:\\Temp\\switchboard-pasted\\pasted-1.png', error: null });
    expect(input.value).toBe('What is this? @"C:/Temp/switchboard-pasted/pasted-1.png" ');
    expect(paste([new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })], ['Files'])).toBe(true);
    expect(error()).toBe('The pasted image is larger than 10 MB.');
  });

  it('sends a command again as a message once the box was emptied, and Shift+Tab chooses nothing', () => {
    const { input, menu, reply, show, press, type, of } = page();

    show(state());
    type('/');
    reply({ type: 'commands', id: 1, commands: COMMANDS, error: null });
    press('Enter');
    expect(input.value).toBe('/clear ');
    type('');
    type('/clear');
    reply({ type: 'commands', id: 2, commands: COMMANDS, error: null });
    expect(press('Tab', { shiftKey: true })).toBe(false);
    expect(menu.hidden).toBe(false);
    press('Escape');
    press('Enter');
    expect(of('send')).toEqual([{ type: 'send', id: 1, text: '/clear', target: { scopeGen: 1, sessionId: 's2', launch: 'l' } }]);
  });

  it("drops another session's list and late answers: a file query that changed, commands after Escape", () => {
    vi.useFakeTimers();

    try {
      const { input, menu, reply, show, press, type, of, rows } = page();

      show(state());
      type('/');
      reply({ type: 'commands', id: 1, commands: COMMANDS, error: null });
      expect(menu.hidden).toBe(false);
      // The session moves while the list is open: it closes, and opening it again asks the new session.
      show(state({ session: { ...SESSION, id: 's9' }, scope: { ...SCOPE, sessionId: 's9' } }));
      expect(menu.hidden).toBe(true);
      press('Enter');
      expect(of('send')[0]).toEqual({ type: 'send', id: 1, text: '/', target: { scopeGen: 1, sessionId: 's9', launch: 'l' } });
      reply({ type: 'sent', id: 1, error: null });
      type('/');
      expect(of('commands')).toHaveLength(2);
      expect(menu.hidden).toBe(true);
      press('Escape');
      type('/x');
      press('Escape');
      reply({ type: 'commands', id: of('commands')[1]!['id'], commands: COMMANDS, error: null });
      expect(menu.hidden).toBe(true);

      // An answer to @alpha that arrives after @beta was typed, before its request, is dropped.
      type('@alpha');
      vi.advanceTimersByTime(80);
      const alpha = of('files').at(-1)!['id'];

      type('@beta');
      reply({ type: 'files', id: alpha, items: [{ path: 'alpha.ts', dir: false }] });
      expect(rows()).toEqual([]);
      expect(press('Enter')).toBe(true);
      expect(input.value).toBe('@beta');
    } finally {
      vi.useRealTimers();
    }
  });

  it('changes nothing in the box while a message is being sent, and puts mentions that arrived meanwhile in once the hub answered', () => {
    const { host, input, reply, show, press, type, of } = page();

    show(state({ items: [message('m1', 'Earlier')] }));
    type('Ship it');
    press('Enter');
    expect(input.readOnly).toBe(true);
    reply({ type: 'mentions', paths: ['D:\\w\\a.ts'] });
    expect(press('ArrowUp')).toBe(false);
    host.querySelector<HTMLButtonElement>('button.slash')!.click();
    expect(input.value).toBe('Ship it');
    reply({ type: 'sent', id: 1, error: null });
    expect(input.value).toBe('@a.ts ');

    // A refusal keeps the text, and the mention goes after it.
    press('Enter');
    reply({ type: 'mentions', paths: ['D:\\w\\b.ts'] });
    reply({ type: 'sent', id: 2, error: 'No.' });
    expect(input.value).toBe('@a.ts @b.ts ');
    expect(of('send')).toHaveLength(2);
  });

  it('takes no drop while another tab than Conversation is shown, where the composer is hidden', () => {
    const { input, show, type } = page();

    show(state());
    type('See ', 4);
    document.body.dataset['tab'] = 'status';

    const event = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };

    event.dataTransfer = { types: ['resourceurls'], getData: (kind: string) => (kind === 'resourceurls' ? JSON.stringify(['file:///d%3A/w/x.md']) : '') };
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(input.value).toBe('See ');
    document.body.dataset['tab'] = 'conversation';
  });

  it('offers nothing for a session the view cannot talk to', () => {
    const { host, menu, show, type, of } = page();

    show(state({ session: { ...SESSION, state: 'ended', conversation: 'read-only', reason: 'The session has ended.' } }));
    expect(host.querySelector<HTMLButtonElement>('button.attach')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('button.slash')!.disabled).toBe(true);
    type('/');
    type('@x');
    expect(menu.hidden).toBe(true);
    expect(of('commands')).toEqual([]);
  });
});

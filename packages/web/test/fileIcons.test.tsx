import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileIcon, fileIconClass, iconOf, iconStyles, languageOf, resetFileIcons, useFileIcons } from '../src/fileIcons.js';
import type { FileIconMap } from '../src/fileIcons.js';
import { startPage } from '../src/main.js';
import { html } from './html.js';
import { drawAtOnce } from './frame.js';

const MAP = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/seti/file-icons.json'), 'utf8')) as FileIconMap;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const answer = (status: number, body: unknown) => ({ status, ok: status === 200, json: async () => body }) as unknown as Response;

describe("VS Code's Seti file icons", () => {
  it('names the VS Code build the mapping was copied from', () => {
    expect(MAP.source).toMatch(/^VS Code \d+\.\d+\.\d+ [0-9a-f]{40}$/);
  });

  it('gives a language by exact file name, then the longest glob, then the longest name ending, ignoring case', () => {
    expect(languageOf(MAP, 'Dockerfile')).toBe('dockerfile');
    expect(languageOf(MAP, 'sub/.GITIGNORE')).toBe('ignore');
    // A glob beats an extension: compose.yaml and *docker*compose*.yml are Docker Compose files, not YAML.
    expect(languageOf(MAP, 'docker-compose.yml')).toBe('dockercompose');
    expect(languageOf(MAP, 'config.yml')).toBe('yaml');
    expect(languageOf(MAP, 'Dockerfile.prod')).toBe('dockerfile');
    // A glob with a slash matches the path, one without matches only the name.
    expect(languageOf(MAP, '.github/hooks/pre.json')).toBe('jsonc');
    expect(languageOf(MAP, 'hooks/pre.json')).toBe('json');
    expect(languageOf(MAP, 'tsconfig.base.json')).toBe('jsonc');
    expect(languageOf(MAP, 'src/main.ts')).toBe('typescript');
    expect(languageOf(MAP, 'src/view.tsx')).toBe('typescriptreact');
    expect(languageOf(MAP, 'notes.zzz')).toBeNull();
  });

  it("picks the theme's file name, then its longest dotted ending, then the language's icon, then its file icon", () => {
    expect(iconOf(MAP, 'docs/README.md')).toBe(MAP.fileNames['readme.md']);
    // webpack.config.ts is named by the theme, so its name beats the ts language.
    expect(iconOf(MAP, 'webpack.config.ts')).toBe(MAP.fileNames['webpack.config.ts']);
    expect(MAP.fileNames['webpack.config.ts']).not.toBe(MAP.languageIds['typescript']);
    // css.map is a longer ending than map.
    expect(iconOf(MAP, 'site.css.map')).toBe(MAP.fileExtensions['css.map']);
    expect(MAP.fileExtensions['css.map']).not.toBe(MAP.fileExtensions['map']);
    expect(iconOf(MAP, 'Dockerfile')).toBe(MAP.languageIds['dockerfile']);
    expect(iconOf(MAP, '.gitignore')).toBe(MAP.languageIds['ignore']);
    expect(iconOf(MAP, 'src/main.ts')).toBe(MAP.languageIds['typescript']);
    expect(iconOf(MAP, 'package.json')).toBe(MAP.languageIds['json']);
    expect(iconOf(MAP, 'notes.zzz')).toBe(MAP.file);
    expect(iconOf(MAP, 'Makefile')).toBe(MAP.languageIds['makefile']);
    expect(new Set([MAP.file, MAP.languageIds['typescript'], MAP.languageIds['json'], MAP.languageIds['dockerfile'], MAP.languageIds['ignore']]).size).toBe(5);
  });

  it("draws each icon in its dark colour, and its light one while the system is light, as the theme's two sections give them", () => {
    const ts = MAP.icons[MAP.languageIds['typescript']!]!;
    const css = iconStyles(MAP, '/page/seti.woff');

    expect(ts[1]).not.toBe(ts[2]);
    expect(css).toContain("@font-face{font-family:seti;src:url('/page/seti.woff') format('woff');font-display:block}");
    expect(css).toContain(`.seti-${MAP.languageIds['typescript']}::before{content:'\\${ts[0].codePointAt(0)!.toString(16)}';color:${ts[1]}}`);
    expect(css.slice(css.indexOf('@media (prefers-color-scheme: light)'))).toContain(`.seti-${MAP.languageIds['typescript']}::before{color:${ts[2]}}`);
  });
});

describe('fileIconClass', () => {
  beforeEach(() => resetFileIcons());
  afterEach(() => resetFileIcons());

  it('draws the file codicon until the mapping loads, loads it once, then draws the icon and its styles', async () => {
    const fetch = vi.fn(async () => answer(200, MAP));
    const loaded = vi.fn();

    expect(fileIconClass('a.ts')).toBeNull();
    useFileIcons({ fetch: fetch as unknown as typeof globalThis.fetch, loaded });
    expect(html(FileIcon({ path: 'a.ts' }))).toBe('<span class="codicon codicon-file" aria-hidden="true"></span>');
    expect(fileIconClass('b.md')).toBeNull();
    await flush();

    expect(fetch.mock.calls).toEqual([['/page/file-icons.json', { credentials: 'same-origin' }]]);
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(fileIconClass('a.ts')).toBe(`file-icon seti-${MAP.languageIds['typescript']}`);
    expect(html(FileIcon({ path: 'Dockerfile' }))).toBe(`<span class="file-icon seti-${MAP.languageIds['dockerfile']}" aria-hidden="true"></span>`);
    expect(document.querySelectorAll('style[data-file-icons]')).toHaveLength(1);
  });

  it('keeps the file codicon, and asks no more, when the mapping does not load or is not one', async () => {
    for (const fail of [async () => answer(404, { error: 'not found' }), async () => answer(200, {}), async () => Promise.reject(new Error('offline'))]) {
      resetFileIcons();

      const fetch = vi.fn(fail);
      const loaded = vi.fn();

      useFileIcons({ fetch: fetch as unknown as typeof globalThis.fetch, loaded });
      fileIconClass('a.ts');
      await flush();
      expect(fileIconClass('a.ts')).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(loaded).not.toHaveBeenCalled();
      expect(document.querySelector('style[data-file-icons]')).toBeNull();
    }
  });

  it('leaves the icons to the next page when the page that asked closes before the mapping comes', async () => {
    const loaded = vi.fn();
    const drop = useFileIcons({ fetch: vi.fn(async () => answer(200, MAP)) as unknown as typeof globalThis.fetch, loaded });

    fileIconClass('a.ts');
    drop();
    await flush();
    expect(loaded).not.toHaveBeenCalled();
    expect(fileIconClass('a.ts')).toBeNull();
    expect(document.querySelector('style[data-file-icons]')).toBeNull();

    const next = vi.fn();

    useFileIcons({ fetch: vi.fn(async () => answer(200, MAP)) as unknown as typeof globalThis.fetch, loaded: next });
    fileIconClass('a.ts');
    await flush();
    expect(next).toHaveBeenCalledTimes(1);
    expect(fileIconClass('a.ts')).toBe(`file-icon seti-${MAP.languageIds['typescript']}`);
  });

  it('keeps the file codicon, without the styles, when the Seti font does not load', async () => {
    for (const fonts of [{ load: async () => [] }, { load: async () => Promise.reject(new Error('NetworkError')) }]) {
      resetFileIcons();
      Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });

      const loaded = vi.fn();

      useFileIcons({ fetch: vi.fn(async () => answer(200, MAP)) as unknown as typeof globalThis.fetch, loaded });
      fileIconClass('a.ts');
      await flush();
      expect(fileIconClass('a.ts')).toBeNull();
      expect(loaded).not.toHaveBeenCalled();
      expect(document.querySelector('style[data-file-icons]')).toBeNull();
    }

    const load = vi.fn(async () => [{}]);

    resetFileIcons();
    Object.defineProperty(document, 'fonts', { value: { load }, configurable: true });
    useFileIcons({ fetch: vi.fn(async () => answer(200, MAP)) as unknown as typeof globalThis.fetch, loaded: () => {} });
    fileIconClass('a.ts');
    await flush();
    expect(load).toHaveBeenCalledWith('16px seti', MAP.icons[MAP.file]![0]);
    expect(fileIconClass('a.ts')).toBe(`file-icon seti-${MAP.languageIds['typescript']}`);
    delete (document as { fonts?: unknown }).fonts;
  });
});

class FakeSource {
  static last: FakeSource | null = null;
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();

  constructor(readonly url: string) {
    FakeSource.last = this;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify({ type, ...(data as object) }) });
    }
  }

  close(): void {}
}

describe('the page', () => {
  beforeEach(() => resetFileIcons());
  afterEach(() => resetFileIcons());

  it("draws each change's and each artifact's file type icon, in the tabs and the More menu, once the mapping loads", async () => {
    const root = document.createElement('div');
    const rows = [
      { path: 'src/main.ts', status: 'M', stages: ['working'], additions: 1, deletions: 0, binary: false },
      { path: 'Dockerfile', status: 'A', stages: ['staged'], additions: 2, deletions: 0, binary: false },
    ];
    const list = { scopeGen: 3, base: null, head: 'h', rows, stages: { committed: 0, staged: 1, working: 1, untracked: 0 }, shown: 2, total: 2 };
    const fetch = vi.fn(async (url: string) => answer(200, url === '/page/file-icons.json' ? MAP : url.startsWith('/v1/conversation/changes') ? list : {}));
    const artifacts = ['notes.md', 'chart.html', 'data.json', 'x.zzz', 'more.md', 'last.svg', 'old.md'].map((path, at) => ({ path, owner: 'chat', kind: 'note', title: path, ext: path.split('.').pop(), type: 'file', updatedAt: 1_000 + at }));
    const session = { id: 's', title: 'Task', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: null };
    const scope = { kind: 'page', key: 'pk', folder: 'D:/w', title: 'Fix it', scopeGen: 3, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle', conversation: 'full', unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' };

    document.body.replaceChildren(root);
    localStorage.clear();

    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });

    FakeSource.last!.emit('hello', { key: 'pk', groups: [], scope, sessions: [session], items: [], more: false, status: null, artifacts, unread: 0 });
    await flush();
    await flush();

    const seti = (path: string) => `file-icon seti-${iconOf(MAP, path)}`;
    const tabIcons = [...root.querySelectorAll('.artifact-tab .tab-open > span:first-child')].map((icon) => icon.className);

    // Unmeasured, the strip shows every tab.
    expect(tabIcons).toEqual([...artifacts].reverse().map((one) => seti(one.path)));

    // A strip too narrow for any tab but the chosen one puts every artifact in More.
    const strip = root.querySelector('.artifact-tab')!.closest<HTMLElement>('.tabs')!;

    const narrow = vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ width: 1 } as DOMRect);
    strip.querySelector<HTMLElement>('[data-side="status"], [data-tab="status"]')!.click();
    root.querySelector<HTMLElement>('.tab-more-button')!.click();
    expect([...root.querySelectorAll('.tab-menu [data-action="artifact"] .menu-gutter > span')].map((icon) => icon.className)).toEqual([...artifacts].reverse().map((one) => seti(one.path)));
    // Measured unmeasured again, the strip shows every tab, Changes among them.
    narrow.mockRestore();
    strip.querySelector<HTMLElement>('[data-side="status"], [data-tab="status"]')!.click();

    root.querySelector<HTMLElement>('.changes-tab')!.click();
    await flush();
    root.querySelector<HTMLElement>('.changes-files')!.click();
    await flush();
    expect([...root.querySelectorAll('.change-row > span:first-child')].map((icon) => icon.className)).toEqual([seti('src/main.ts'), seti('Dockerfile')]);
    expect(fetch.mock.calls.filter(([url]) => url === '/page/file-icons.json')).toHaveLength(1);
    page.close();
  });
});

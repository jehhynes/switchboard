import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactView, ItemView, ReplyView, SessionView, WindowScope } from '@switchboard/hub';
import { artifactCsp, artifactFile, artifactPage, assetResolver, assetsRoot, rewriteResources, unopened } from '../src/artifactModel.js';
import { applyEvent, artifactIcon, EMPTY_CONVERSATION, placeArtifacts, timeline } from '../src/conversationModel.js';
import type { ConversationState } from '../src/conversationModel.js';
import { extendMarkdownIt } from '../src/markdownMermaid.js';
import { startConversation } from '../src/webview/conversationMain.js';
import { renderConversation } from '../src/webview/conversationRender.js';
import { drawDiagrams, mermaidTheme } from '../src/webview/mermaidPreview.js';

const T0 = Date.UTC(2026, 10, 19, 12);
const SCOPE: WindowScope = { kind: 'item', workItemId: 2, key: 'k1', title: 'Fix the badge', cwd: 'D:/w', scopeGen: 1, sessionId: 's2' };
const SESSION: SessionView = { id: 's2', kind: 'task', title: 'Task session aaaa', state: 'idle', waitingFor: null, launch: 'l', current: true, conversation: 'full', reason: null };
const artifact = (path: string, updatedAt: number, patch: Partial<ArtifactView> = {}): ArtifactView => ({ path, owner: path.split('/')[0]!, kind: 'comparison', title: `Title of ${path}`, ext: 'md', type: 'markdown', updatedAt, ...patch });
const reply = (id: string, at: number): ReplyView => ({ type: 'reply', id, sessionId: 's2', at, ord: at, provisional: false, kind: 'reply', answers: null, opening: `Reply ${id}`, source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, unread: false });
const message = (id: string, at: number): ItemView => ({ type: 'message', id, sessionId: 's2', at, ord: at, origin: 'terminal', text: `Message ${id}`, provisional: false, withdrawn: false, delivery: null, error: null });
const state = (patch: Partial<ConversationState> = {}): ConversationState => ({ ...EMPTY_CONVERSATION, scope: SCOPE, session: SESSION, connected: true, artifactsDir: 'D:/w/.wip/artifacts/w2', ...patch });

describe('artifacts in the conversation state', () => {
  it('takes the artifacts from hello newest first, adds, replaces and removes them by path, and drops them when the work item changes', () => {
    let shown = applyEvent(EMPTY_CONVERSATION, { type: 'hello', scope: SCOPE, sessions: [SESSION], items: [], more: false, status: null, artifactsDir: 'D:/w/.wip/artifacts/w2', artifacts: [artifact('chat/a.md', T0), artifact('chat/b.md', T0 + 5)] });

    expect(shown.artifactsDir).toBe('D:/w/.wip/artifacts/w2');
    expect(shown.artifacts.map((one) => one.path)).toEqual(['chat/b.md', 'chat/a.md']);
    shown = applyEvent(shown, { type: 'artifact', artifact: artifact('chat/a.md', T0 + 9, { title: 'Rewritten' }) });
    expect(shown.artifacts.map((one) => [one.path, one.title])).toEqual([['chat/a.md', 'Rewritten'], ['chat/b.md', 'Title of chat/b.md']]);
    shown = applyEvent(shown, { type: 'artifact', artifact: { path: 'chat/b.md' }, removed: true });
    expect(shown.artifacts.map((one) => one.path)).toEqual(['chat/a.md']);
    // A new session of the same work item keeps its artifacts; another work item's window starts without them.
    expect(applyEvent(shown, { type: 'scope', scope: { ...SCOPE, sessionId: 's9' } }).artifacts).toHaveLength(1);
    expect(applyEvent(shown, { type: 'scope', scope: { ...SCOPE, workItemId: 3 } })).toMatchObject({ artifacts: [], artifactsDir: null });
  });

  it('places each artifact after the last entry from no later than its write, and leaves out one written before the oldest entry shown', () => {
    const items = [message('m1', T0), reply('r1', T0 + 10), message('m2', T0 + 20), reply('r2', T0 + 30)];
    const ids = timeline(items, [artifact('chat/early.md', T0 - 1), artifact('chat/mid.md', T0 + 15), artifact('chat/tie.md', T0 + 10), artifact('chat/late.md', T0 + 99)]).map((entry) => (entry.type === 'artifact' ? entry.artifact.path : entry.item.id));

    expect(ids).toEqual(['m1', 'r1', 'chat/tie.md', 'chat/mid.md', 'm2', 'r2', 'chat/late.md']);
    expect(placeArtifacts([], [artifact('chat/a.md', T0)])).toEqual([]);
  });

  it('names a codicon for each type', () => {
    expect((['markdown', 'html', 'image', 'audio', 'video', 'file'] as const).map(artifactIcon)).toEqual(['markdown', 'globe', 'file-media', 'unmute', 'device-camera-video', 'file']);
  });
});

describe('artifact rows', () => {
  it('draws an artifact as a one-line row with its codicon, title and kind, escaped, that opens it by click or Enter', () => {
    const root = document.createElement('div');
    const live = document.createElement('div');
    const posted: Array<{ type: string; [field: string]: unknown }> = [];

    document.body.replaceChildren(root, live);
    startConversation(root, live, { postMessage: (one: { type: string }) => posted.push(one), getState: () => null, setState: () => undefined });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: state({ items: [message('m1', T0), reply('r1', T0 + 10)], artifacts: [artifact('chat/comparison-x.html', T0 + 5, { type: 'html', title: 'A <b>vs</b> B', kind: 'comparison' })] }) } }));

    const row = root.querySelector<HTMLElement>('li.artifact')!;

    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.className)).toEqual(['message', 'artifact', 'reply reply']);
    expect(row.querySelector('.codicon')?.className).toBe('codicon codicon-globe');
    expect(row.querySelector('.artifact-title')?.innerHTML).toBe('A &lt;b&gt;vs&lt;/b&gt; B');
    expect(row.querySelector('.artifact-kind')?.textContent).toBe('comparison');
    row.querySelector<HTMLButtonElement>('button')!.click();
    row.focus();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(posted.filter((one) => one.type === 'artifact')).toEqual([
      { type: 'artifact', path: 'chat/comparison-x.html' },
      { type: 'artifact', path: 'chat/comparison-x.html' },
    ]);
  });

  it('shows no artifact rows before the session has messages', () => {
    expect(renderConversation(state({ artifacts: [artifact('chat/a.md', T0)] }))).not.toContain('artifact-open');
  });
});

describe('the Artifacts tab', () => {
  it('lists the artifacts newest first with codicon, title, kind and age, marks and counts the new or changed ones, and opens one on a click', () => {
    const root = document.createElement('div');
    const live = document.createElement('div');
    const posted: Array<{ type: string; [field: string]: unknown }> = [];
    const artifacts = [artifact('chat/b.html', T0 - 4 * 60_000, { type: 'html', title: 'B <i>page</i>' }), artifact('chat/a.md', T0 - 2 * 3_600_000)];

    vi.useFakeTimers();
    vi.setSystemTime(T0);
    document.body.replaceChildren(root, live);
    startConversation(root, live, { postMessage: (one: { type: string }) => posted.push(one), getState: () => ({ open: [], scroll: null, tab: 'artifacts' }), setState: () => undefined });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: state({ artifacts }), unopened: ['chat/b.html', 'chat/gone.md'] } }));

    const rows = [...root.querySelectorAll<HTMLElement>('.artifact-list > li')];

    expect(rows.map((row) => row.className)).toEqual(['artifact-item unopened', 'artifact-item']);
    expect(rows[0]!.querySelector('.codicon')?.className).toBe('codicon codicon-globe');
    expect(rows[0]!.querySelector('.artifact-title')?.innerHTML).toBe('B &lt;i&gt;page&lt;/i&gt;');
    expect(rows.map((row) => row.querySelector('.artifact-kind')?.textContent)).toEqual(['comparison · 4 min ago', 'comparison · 2 h ago']);
    expect(rows[0]!.querySelector('button')?.getAttribute('aria-label')).toBe('Open artifact: B <i>page</i>, comparison, new or changed');
    expect(rows[1]!.querySelector('.artifact-new')).toBeNull();
    // Only paths of the window's artifacts count.
    expect(root.querySelector('[data-tab="artifacts"] .tab-badge')?.textContent).toBe('1');
    rows[1]!.querySelector('button')!.click();
    expect(posted.filter((one) => one.type === 'artifact')).toEqual([{ type: 'artifact', path: 'chat/a.md' }]);

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: state({ artifacts }), unopened: [] } }));
    expect(root.querySelector('[data-tab="artifacts"] .tab-badge')).toBeNull();
    vi.advanceTimersByTime(30_000 * 4);
    expect(root.querySelector('.artifact-kind')?.textContent).toBe('comparison · 6 min ago');
    vi.useRealTimers();

    expect(renderConversation(state(), new Set(), T0, false, { tab: 'artifacts', unopened: new Set() })).toContain("The session's artifacts show here as it writes them");
  });
});

describe('artifact files', () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'artifact-files-'));
    dir = join(root, 'w2');
    mkdirSync(join(dir, 'chat', 'page', 'img'), { recursive: true });
    writeFileSync(join(dir, 'chat', 'page.html'), '<p>x</p>');
    writeFileSync(join(dir, 'chat', 'page', 'img', 'a b.png'), 'png');
    writeFileSync(join(dir, 'chat', 'notes.md'), '# Notes');
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside', 'secret.png'), 'secret');
    symlinkSync(join(root, 'outside'), join(dir, 'chat', 'page', 'out'), 'junction');
    symlinkSync(join(root, 'outside', 'secret.png'), join(dir, 'chat', 'linked.md'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("opens only an artifact of the window's list, by its real path inside the folder", () => {
    const list = [artifact('chat/notes.md', T0), artifact('chat/linked.md', T0), artifact('../w2/chat/notes.md', T0)];

    expect(artifactFile(dir, list, 'chat/notes.md')).toEqual({ artifact: list[0], file: expect.stringMatching(/notes\.md$/) as unknown });
    expect(artifactFile(dir, list, 'chat/page.html')).toBeNull();
    expect(artifactFile(dir, list, 'chat/linked.md')).toBeNull();
    expect(artifactFile(dir, list, '../w2/chat/notes.md')).toBeNull();
    expect(artifactFile(null, list, 'chat/notes.md')).toBeNull();
  });

  it('resolves an HTML artifact\'s relative resources only inside the folder beside it', () => {
    const resolve = assetResolver(dir, 'chat/page.html');

    expect(resolve('page/img/a%20b.png?v=2#top')).toMatch(/a b\.png$/);
    expect(resolve('./page/img/a b.png')).toMatch(/a b\.png$/);
    expect(resolve('notes.md')).toBeNull();
    expect(resolve('page/../notes.md')).toBeNull();
    expect(resolve('page/out/secret.png')).toBeNull();
    expect(resolve('page/missing.png')).toBeNull();
    expect(resolve(join(dir, 'chat', 'page', 'img', 'a b.png'))).toBeNull();
    expect(resolve('https://x.test/a.png')).toBeNull();
    expect(resolve('//x.test/a.png')).toBeNull();
    expect(resolve('%E0%A4%A')).toBeNull();
    expect(assetResolver(dir, 'chat/notes.md')('notes/a.png')).toBeNull();
    expect(resolve('page/img/a b.png?x=1&amp;y=2')).toMatch(/a b\.png$/);
  });

  it('grants the folder beside an artifact only when it is inside the artifact folder by its real path', () => {
    symlinkSync(join(root, 'outside'), join(dir, 'chat', 'elsewhere'), 'junction');

    expect(assetsRoot(dir, 'chat/page.html')).toMatch(/page$/);
    expect(assetsRoot(dir, 'chat/elsewhere.html')).toBeNull();
    expect(assetResolver(dir, 'chat/elsewhere.html')('elsewhere/secret.png')).toBeNull();
    expect(assetsRoot(dir, 'chat/missing.html')).toBeNull();
  });

  it('counts the artifacts written or rewritten since they were last opened', () => {
    const list = [artifact('chat/a.md', T0 + 5), artifact('chat/b.md', T0), artifact('chat/c.md', T0)];

    expect(unopened(list, { 'chat/a.md': T0, 'chat/b.md': T0 }).map((one) => one.path)).toEqual(['chat/a.md', 'chat/c.md']);
  });
});

describe('HTML artifact pages', () => {
  const toUri = (file: string) => `https://file+.vscode-resource/${file}`;
  const resolve = (url: string) => (url.startsWith('page/') ? `/w/chat/${url}` : null);

  it('rewrites every src, href and poster to a file it uses, keeps fragments and data URLs, and empties the rest', () => {
    expect(rewriteResources('<video poster="page/p.png" src=\'page/v.mp4\'></video><img src=page/a.png alt="src=x"><a href="#top">t</a><a href="https://x.test">x</a><img src="data:image/png;base64,AA"><link href="other.css">', resolve, toUri)).toBe(
      '<video poster="https://file+.vscode-resource//w/chat/page/p.png" src="https://file+.vscode-resource//w/chat/page/v.mp4"></video><img src="https://file+.vscode-resource//w/chat/page/a.png" alt="src=x"><a href="#top">t</a><a href="">x</a><img src="data:image/png;base64,AA"><link href="">',
    );
  });

  it('leaves the text of scripts, styles and comments as written, and reads a quoted > inside a tag', () => {
    const page = '<script src="page/s.js">document.body.innerHTML = "<img src=\'page/a.png\'>";</script><style>a[href="x"] {}</style><!-- <img src="page/c.png"> --><img alt="A > B" src="page/b.png">';

    expect(rewriteResources(page, resolve, toUri)).toBe(
      '<script src="https://file+.vscode-resource//w/chat/page/s.js">document.body.innerHTML = "<img src=\'page/a.png\'>";</script><style>a[href="x"] {}</style><!-- <img src="page/c.png"> --><img alt="A > B" src="https://file+.vscode-resource//w/chat/page/b.png">',
    );
  });

  it('puts the policy and the navigation guard before the page, after its doctype, with no connect-src', () => {
    const page = artifactPage('\uFEFF<!DOCTYPE html><html><head><title>T</title></head><body><img src="page/a.png"></body></html>', 'vscode-webview://abc', resolve, toUri);

    expect(page.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' vscode-webview://abc;')).toBe(true);
    expect(page).toContain("form-action 'none'; base-uri 'none'\">");
    expect(page).toContain('window.open = () => null');
    expect(page).toContain('<img src="https://file+.vscode-resource//w/chat/page/a.png">');
    expect(artifactCsp('S')).not.toContain('connect-src');
    expect(artifactPage('<p>bare</p>', 'S', resolve, toUri)).toMatch(/^<!doctype html><meta [^>]*><script>[\s\S]*<\/script><p>bare<\/p>$/);
  });

  it('keeps a link click from leaving the page, and lets an in-page link through', () => {
    const html = artifactPage('<a id="out" href="https://x.test">out</a><a id="in" href="#here">in</a>', 'S', resolve, toUri);
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;

    document.body.innerHTML = '<a id="out" href="https://x.test">out</a><a id="in" href="#here">in</a>';
    // VS Code's own webview script, which opens a clicked link even when it was prevented.
    const opened: string[] = [];
    const host = (event: Event) => opened.push((event.target as HTMLAnchorElement).id);

    window.addEventListener('click', host);
    new Function(script)();

    const out = new MouseEvent('click', { bubbles: true, cancelable: true });
    const inside = new MouseEvent('click', { bubbles: true, cancelable: true });

    document.getElementById('out')!.dispatchEvent(out);
    document.getElementById('in')!.dispatchEvent(inside);
    expect(out.defaultPrevented).toBe(true);
    expect(inside.defaultPrevented).toBe(false);
    expect(opened).toEqual(['in']);
    window.removeEventListener('click', host);
    expect(window.open('https://x.test')).toBeNull();
  });
});

describe('Mermaid in the Markdown preview', () => {
  it('turns a mermaid fence into an escaped placeholder and leaves other fences to the renderer', () => {
    const md = extendMarkdownIt(new MarkdownIt());

    expect(md.render('```mermaid\ngraph TD; A-->B<script>\n```')).toBe('<pre class="switchboard-mermaid" data-line="0">graph TD; A--&gt;B&lt;script&gt;\n</pre>\n');
    expect(md.render('```Mermaid title\nx\n```')).toContain('class="switchboard-mermaid"');
    expect(md.render('```ts\nconst a = 1;\n```')).toBe('<pre><code class="language-ts">const a = 1;\n</code></pre>\n');
  });

  it("draws each placeholder once in the theme's colours, and keeps the source of one Mermaid cannot read with why", async () => {
    document.body.className = 'vscode-body vscode-dark';
    document.body.innerHTML = '<pre class="switchboard-mermaid">graph TD; A--&gt;B</pre><pre class="switchboard-mermaid">bad</pre>';

    const configs: Array<Record<string, unknown>> = [];
    const mermaid = {
      initialize: (config: Record<string, unknown>) => void configs.push(config),
      render: async (id: string, text: string) => {
        if (text === 'bad') {
          throw new Error('Parse error');
        }

        return { svg: `<svg id="${id}"><text>${text}</text></svg>` };
      },
    };

    // Two draws at once, as the preview's load and the wait for Mermaid can start, draw each diagram once.
    expect(await Promise.all([drawDiagrams(document, mermaid), drawDiagrams(document, mermaid)])).toEqual([1, 0]);
    expect(configs).toEqual([{ startOnLoad: false, securityLevel: 'strict', theme: 'dark' }]);

    const [good, bad] = [...document.querySelectorAll<HTMLElement>('.switchboard-mermaid')];

    expect(good!.dataset['drawn']).toBe('yes');
    expect(good!.querySelector('svg text')?.textContent).toBe('graph TD; A-->B');
    expect(bad!.dataset['drawn']).toBe('error');
    expect(bad!.textContent).toBe('bad');
    expect(bad!.nextElementSibling?.textContent).toBe('Mermaid could not draw this diagram: Parse error');
    // Drawn placeholders are not drawn again; without Mermaid nothing is drawn.
    expect(await drawDiagrams(document, mermaid)).toBe(0);
    expect(await drawDiagrams(document, undefined)).toBe(0);
    expect(mermaidTheme({ classList: { contains: (name) => name === 'vscode-light' } })).toBe('default');
    expect(mermaidTheme({ classList: { contains: (name) => name === 'vscode-high-contrast' } })).toBe('dark');
  });
});

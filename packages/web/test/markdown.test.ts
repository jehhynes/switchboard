import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCardText, renderInline, renderMarkdown, slug } from '../src/markdown.js';

/** The Markdown as the page would hold it: parsed into a detached host. */
const dom = (text: string): HTMLElement => {
  const host = document.createElement('div');

  host.innerHTML = renderMarkdown(text);
  return host;
};
const css = readFileSync(join(__dirname, '../src/page.css'), 'utf8');
const rule = (selector: string): string => {
  const at = css.indexOf(`\n${selector} {`);

  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at + 1, css.indexOf('}', at) + 1);
};

describe('GitHub-flavoured Markdown', () => {
  it('draws every link in Markdown in the link colour, visited or not, always underlined, with the focus ring on keyboard focus', () => {
    expect(rule('.body a, .body a:visited')).toBe('.body a, .body a:visited { color: var(--vscode-textLink-foreground); text-decoration: underline; }');
    expect(rule('.body a:focus-visible')).toContain('outline: 1px solid var(--vscode-focusBorder);');
    expect(css).not.toMatch(/\.body a(?! code)[^{]*\{[^}]*(text-decoration: (none|underline dotted)|color: inherit)/);
    // Code in a link takes the link's colour.
    expect(rule('.body a code')).toContain('color: inherit;');
  });

  it("styles only the renderer's own disclosures, not the page's folds, and gives an alert's title its own spacing over a document's paragraphs", () => {
    expect(rule('.body details:not(.fold)')).toContain('margin: 0.5em 0;');
    expect(css).not.toMatch(/\n\.body details \{/);
    expect(rule('.body blockquote.markdown-alert > .markdown-alert-title')).toContain('margin: 0 0 4px;');
  });

  it('draws root bullets as discs, then circles, then squares, in every Markdown surface, whatever list it sits in', () => {
    expect(rule('.body ul')).toContain('list-style-type: disc;');
    expect(rule('.body :is(ul, ol) ul')).toContain('list-style-type: circle;');
    expect(rule('.body :is(ul, ol) :is(ul, ol) ul')).toContain('list-style-type: square;');
    // The reply's own dot is its own box, not a list marker, and the timeline's items have none.
    expect(css).toMatch(/\.reply \.dot \{[^}]*border-radius: 50%/);
    expect(css).toMatch(/\.timeline \{ list-style: none;/);
  });

  it('typesets the Status tab, an artifact and a file as one Markdown document, with no Status rules of its own but the stage dimmed', () => {
    expect(rule('.body.md-doc')).toBe('.body.md-doc { font-size: 15px; line-height: 1.55; }');
    expect(css).not.toMatch(/\.body\.artifact-doc (?!pre\.artifact-text)/);
    expect(css.match(/^[^\n{]*\.state-body[^\n{]*\{[^}]*\}/gm)).toEqual(['.state-view.stale .state-headline, .state-view.stale .state-body { color: var(--vscode-descriptionForeground); }']);
  });

  it('draws <details> with its <summary> as a disclosure, its body as Markdown, nested and open', () => {
    const host = dom('<details>\n<summary>More **here**</summary>\n\nHidden *text*\n\n<details><summary>Inner</summary>\n\n- a\n\n</details>\n\n</details>\n\n<details open>\n<summary>Shown</summary>\n\nBody\n</details>');
    const outer = host.querySelector('details')!;

    expect(outer.querySelector(':scope > summary')!.innerHTML).toBe('More <strong>here</strong>');
    expect(outer.querySelector(':scope > p em')!.textContent).toBe('text');
    expect(outer.querySelector(':scope > details > summary')!.textContent).toBe('Inner');
    expect(outer.querySelector(':scope > details > ul > li')!.textContent).toBe('a');
    expect(outer.open).toBe(false);
    expect(host.querySelectorAll(':scope > details')).toHaveLength(2);
    expect(host.querySelectorAll(':scope > details')[1]!.hasAttribute('open')).toBe(true);
    expect(host.textContent).not.toContain('<');
  });

  it('takes a summary over several lines or none at all, and keeps a <details> with attributes or trailing text as text', () => {
    expect(dom('<details>\n<summary>\nTwo\nlines\n</summary>\n\nx\n</details>').querySelector('summary')!.textContent).toBe('Two\nlines');
    expect(dom('<details>\n\nNo summary\n\n</details>').querySelector('details > p')!.textContent).toBe('No summary');

    for (const text of ['<details onclick="alert(1)">\n<summary>x</summary>\n</details>', '<details class="x">\n</details>', '<details><summary>x</summary> after\n</details>']) {
      const host = dom(text);

      expect(host.querySelector('details'), text).toBeNull();
      expect(host.querySelector('[onclick], [class="x"]')).toBeNull();
    }
  });

  it('keeps a <summary> to its own container and a few lines, leaving the rest as text', () => {
    const host = dom('- <details>\n  <summary>hi\n- next\n</summary>');

    expect(host.querySelector('details')).toBeNull();
    expect(dom('- <details>\n<summary>outside</summary>\n\nafter').querySelector('li summary')).toBeNull();
    expect(dom('> <details>\n<summary>outside</summary>').querySelector('blockquote summary')).toBeNull();
    expect([...host.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['<details>\n<summary>hi', 'next\n</summary>']);
    expect(dom(`<details>\n<summary>${'\nline'.repeat(18)}\n</summary>\n</details>`).querySelector('summary')).not.toBeNull();
    expect(dom(`<details>\n<summary>${'\nline'.repeat(19)}\n</summary>\n</details>`).querySelector('details')).toBeNull();
  });

  it('reads many unclosed comments and summaries in linear time', () => {
    // The process's own CPU time, which other processes loading the machine do not add to; a quadratic reading takes many seconds.
    const started = process.cpuUsage();

    renderMarkdown('<!-- x\n'.repeat(20_000));
    renderMarkdown(`p ${'<!-- '.repeat(20_000)}`);
    renderMarkdown('<details>\n<summary>a\n'.repeat(5_000));

    const used = process.cpuUsage(started);

    expect((used.user + used.system) / 1000).toBeLessThan(1_500);
  });

  it('closes an unclosed <details> where its container ends and drops a </details> with no opening, so none reaches outside its place', () => {
    const host = dom('- item\n\n  <details>\n  <summary>In a list</summary>\n\n  inside\n\n- next\n\n</details>\n\nAfter');

    expect(host.querySelector('ul > li > details > summary')!.textContent).toBe('In a list');
    expect(host.querySelectorAll('ul > li')).toHaveLength(2);
    expect(host.querySelector(':scope > p')!.textContent).toBe('After');
    expect(renderMarkdown('</details>\n\ntext')).toBe('<p>text</p>\n');
    expect(renderMarkdown('<details>\n<summary>s</summary>\n\nopen to the end')).toMatch(/<\/details>\n$/);
  });

  it('draws GitHub alerts with their icon, title and class, and leaves other quotes as quotes', () => {
    const types = { NOTE: ['info', 'Note'], TIP: ['lightbulb', 'Tip'], IMPORTANT: ['report', 'Important'], WARNING: ['warning', 'Warning'], CAUTION: ['stop-circle', 'Caution'] };

    for (const [type, [icon, title]] of Object.entries(types)) {
      const quote = dom(`> [!${type}]\n> Some *text*.\n>\n> More.`).querySelector('blockquote')!;

      expect(quote.className).toBe(`markdown-alert markdown-alert-${type.toLowerCase()}`);
      expect(quote.querySelector('.markdown-alert-title')!.textContent).toBe(title);
      expect(quote.querySelector(`.markdown-alert-title .codicon-${icon}`)).not.toBeNull();
      expect([...quote.querySelectorAll('p:not(.markdown-alert-title)')].map((p) => p.innerHTML)).toEqual(['Some <em>text</em>.', 'More.']);
    }

    expect(dom('> [!note]\n> lower case').querySelector('blockquote')!.className).toBe('markdown-alert markdown-alert-note');
    expect(dom('> [!NOTE]\n\n> apart').querySelector('.markdown-alert')).toBeNull();
    expect(dom('> [!NOTE] same line').querySelector('.markdown-alert')).toBeNull();
    expect(dom('> [!OTHER]\n> x').querySelector('.markdown-alert')).toBeNull();
    expect(dom('> A quote').querySelector('blockquote')!.className).toBe('');
    expect(css).toMatch(/--sb-alert-note: #4493f8;[^}]*--sb-alert-caution: #f85149;/);
    expect(css).toMatch(/prefers-color-scheme: light\) \{\n {2}:root \{ --sb-alert-note: #0969da;/);
  });

  it('draws task list items with a read-only checkbox, only in a list', () => {
    const host = dom('- [x] done\n- [ ] to do\n  - [X] nested\n- plain\n\n[ ] not a list');
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input')];

    expect(boxes.map((box) => [box.type, box.checked, box.disabled])).toEqual([
      ['checkbox', true, true],
      ['checkbox', false, true],
      ['checkbox', true, true],
    ]);
    expect(host.querySelector('ul')!.className).toBe('contains-task-list');
    expect([...host.querySelectorAll('li.task-list-item')].map((li) => li.firstChild!.nextSibling!.textContent!.trim().split('\n')[0])).toEqual(['done', 'to do', 'nested']);
    expect(host.querySelectorAll('li:not(.task-list-item)')).toHaveLength(1);
    expect(host.querySelector(':scope > p')!.textContent).toBe('[ ] not a list');
  });

  it('draws <kbd>, <sub>, <sup> and <br> without attributes, an unpaired or unknown tag as text, and hides comments', () => {
    expect(renderInline('<kbd>Ctrl</kbd> H<sub>2</sub>O x<sup>2</sup> a<br>b<br/>c<br />d')).toBe('<kbd>Ctrl</kbd> H<sub>2</sub>O x<sup>2</sup> a<br>b<br>c<br>d');
    expect(renderInline('<kbd>open')).toBe('&lt;kbd&gt;open');
    expect(renderInline('close</sup>')).toBe('close&lt;/sup&gt;');
    expect(renderInline('<sub><kbd>x</sub></kbd>')).toBe('<sub>&lt;kbd&gt;x</sub>&lt;/kbd&gt;');
    expect(renderInline('<kbd onclick="x()">k</kbd>')).toBe('&lt;kbd onclick=&quot;x()&quot;&gt;k&lt;/kbd&gt;');
    expect(renderInline('<script>alert(1)</script><img src=x onerror=alert(1)>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(renderInline('a <!-- hidden --> b')).toBe('a  b');
    expect(renderMarkdown('before\n\n<!--\nhidden\n-->\n\nafter')).toBe('<p>before</p>\n<p>after</p>\n');
    // Text after a comment on its line stays, and so does an unclosed comment's.
    expect(renderMarkdown('<!-- first --> visible <!-- second -->')).toBe('<p> visible </p>\n');
    expect(renderMarkdown('<!-- open\n\ntext')).toBe('<p>&lt;!-- open</p>\n<p>text</p>\n');
    // A comment in a list item ends with it; one that would run past it stays text.
    expect(dom('- <!--\n- next -->').querySelectorAll('li')).toHaveLength(2);
    expect(renderInline('`<kbd>x</kbd>`')).toBe('<code>&lt;kbd&gt;x&lt;/kbd&gt;</code>');
  });

  it('draws an <img> with only src, alt, title, width and height, rebuilt and escaped, and keeps any other as text', () => {
    const base = (src: string): string => `/r/${src}`;
    const img = (text: string): Element | null => {
      const host = document.createElement('div');

      host.innerHTML = renderMarkdown(text, base);
      return host.querySelector('img');
    };

    const drawn = img('<img src="a b.png" alt=\'say "hi" &amp; bye\' title="t &amp; u" width="300" height="50%">')!;

    expect(drawn.getAttribute('src')).toBe('/r/a%20b.png');
    expect(drawn.getAttribute('alt')).toBe('say "hi" & bye');
    expect(drawn.getAttribute('title')).toBe('t & u');
    expect([drawn.getAttribute('width'), drawn.getAttribute('height')]).toEqual(['300', '50%']);
    expect(img('<IMG SRC=x.png />')!.getAttribute('src')).toBe('/r/x.png');
    // A size that is not a number is dropped; an event handler, srcset, style, a repeated attribute or no src leaves the tag as text.
    expect(img('<img src="x.png" width="1;x">')!.hasAttribute('width')).toBe(false);

    for (const text of ['<img src=x onerror=alert(1)>', '<img src="x.png" srcset="y.png 2x">', '<img src="x.png" style="x">', '<img src="x.png" src="y.png">', '<img alt="x">', '<img src="x.png" onload = "a()">']) {
      expect(renderInline(text), text).not.toContain('<img');
    }

    // A source of another scheme, written plainly, in capitals or with character references, is refused.
    for (const text of ['<img src="javascript:alert(1)">', '<img src="JaVaScRiPt:alert(1)">', '<img src="jav&#x61;script:alert(1)">', '<img src="data:image/svg+xml,<svg>">', '<img src="vbscript:x">']) {
      expect(renderInline(text), text).not.toContain('<img');
    }

    // A quote in a value cannot leave the attribute.
    expect(img('<img src=\'x.png" onerror="alert(1)\'>')!.getAttributeNames().sort()).toEqual(['alt', 'data-picture', 'src']);
    // Only a <p> or <div> with no attributes but align is dropped; any other stays text.
    expect(renderMarkdown('<p align="center">\n<img src="x.png">\n</p>', base)).not.toContain('&lt;p');
    expect(renderInline('<div class="x">a')).toBe('&lt;div class=&quot;x&quot;&gt;a');
  });

  it('puts a note in the place of a picture with no source the page can read, naming it by its alt text or file name', () => {
    expect(dom('![](shots/my%20shot.png)').querySelector('.picture.broken .picture-missing')!.textContent).toBe('Picture not shown: my shot.png');
    expect(dom('![The list](shots/a.png)').querySelector('.picture.broken .picture-missing')!.getAttribute('title')).toBe('shots/a.png');
    expect(dom('![x](shots/a.png)').querySelector('img')).toBeNull();
    // Hidden until the picture fails.
    expect(rule('.picture-missing')).toContain('display: none');
    expect(rule('.picture.broken > .picture-missing')).toContain('display: inline-block');
  });

  it('draws tables with their alignment, strikethrough, autolinks and line breaks as GitHub does', () => {
    const cells = [...dom('| L | C | R | N |\n|:--|:-:|--:|---|\n| a | b | c | d |').querySelectorAll<HTMLElement>('td')];

    expect(cells.map((cell) => cell.style.textAlign)).toEqual(['left', 'center', 'right', '']);
    expect(renderInline('~~gone~~ ~5 min')).toBe('<s>gone</s> ~5 min');
    expect(renderInline('see https://a.example/x and www.example.com')).toBe('see <a href="https://a.example/x" target="_blank" rel="noopener noreferrer">https://a.example/x</a> and <a href="http://www.example.com" target="_blank" rel="noopener noreferrer">www.example.com</a>');
    expect(renderInline('mail me@example.com')).toBe('mail <a href="mailto:me@example.com">me@example.com</a>');
    expect(renderMarkdown('one  \ntwo\\\nthree\nfour')).toBe('<p>one<br>\ntwo<br>\nthree\nfour</p>\n');
  });

  it('gives each heading its anchor and turns a #name link into one that scrolls there, never the page route', () => {
    const host = dom('# Hello, World!\n\n## Hello World\n\n## Hello World\n\n## Ünïcode `code` :rocket:\n\n[go](#hello-world-1) [quote](#a&b)');

    expect([...host.querySelectorAll('h1, h2')].map((h) => h.getAttribute('data-anchor'))).toEqual(['hello-world', 'hello-world-1', 'hello-world-2', 'ünïcode-code']);
    expect(host.querySelector('[id]')).toBeNull();

    const links = [...host.querySelectorAll<HTMLElement>('a.anchor-link')];

    expect(links.map((a) => [a.dataset['action'], a.dataset['target'], a.hasAttribute('href'), a.getAttribute('tabindex')])).toEqual([
      ['anchor', 'hello-world-1', false, '0'],
      ['anchor', 'a&b', false, '0'],
    ]);
    expect(slug('  A -- b_c  ', new Map())).toBe('a----b_c');
    const many = new Map<string, number>();
    const started = process.cpuUsage();

    expect(Array.from({ length: 5_000 }, () => slug('Same', many)).at(-1)).toBe('same-4999');

    const used = process.cpuUsage(started);

    // CPU time, as above: a slug that counted up from 1 each time would make some 12 million lookups here.
    expect((used.user + used.system) / 1000).toBeLessThan(200);
    // A repeated name never takes one another heading has, and a heading never takes a footnote's place.
    expect([...dom('# A\n# A\n# A-1\n# fn1\n\nx[^1]\n\n[^1]: n').querySelectorAll('h1')].map((h) => h.getAttribute('data-anchor'))).toEqual(['a', 'a-1', 'a-1-1', 'fn1']);
    expect(dom('# fn1\n\nx[^1]\n\n[^1]: n').querySelector<HTMLElement>('sup a')!.dataset['target']).toBe('^fn1');
  });

  it('draws footnotes at the end with links both ways, and no inline ^[note]', () => {
    const host = dom('Text[^a] and again[^a], then[^2].\n\n[^a]: First *note*.\n[^2]: Second.\n\nInline ^[not a note].');
    const refs = [...host.querySelectorAll<HTMLElement>('sup.footnote-ref a')];

    expect(refs.map((a) => [a.textContent, a.dataset['target'], a.dataset['anchor']])).toEqual([
      ['1', '^fn1', '^fnref1'],
      ['1', '^fn1', '^fnref1:1'],
      ['2', '^fn2', '^fnref2'],
    ]);
    expect([...host.querySelectorAll<HTMLElement>('section.footnotes li')].map((li) => li.dataset['anchor'])).toEqual(['^fn1', '^fn2']);
    expect(host.querySelector('section.footnotes li em')!.textContent).toBe('note');
    expect([...host.querySelectorAll<HTMLElement>('.footnote-backref')].map((a) => a.dataset['target'])).toEqual(['^fnref1', '^fnref1:1', '^fnref2']);
    expect(host.querySelector('.footnote-backref')!.className).toBe('anchor-link footnote-backref');
    expect(host.textContent).toContain('^[not a note]');
  });

  it("draws emoji shortcodes as GitHub's, without turning :) into one", () => {
    expect(renderInline(':+1: :sparkles: :rocket: :) :not_an_emoji: 10:30:00')).toBe('👍 ✨ 🚀 :) :not_an_emoji: 10:30:00');
  });

  it('colours a diff block by line and escapes it, keeping the copy button and a fence language as GitHub names it', () => {
    const host = dom('```diff\n@@ -1 +1 @@\n-<old>\n+new\n same\n```\n\n```ts\nconst a = 1;\n```');
    const code = host.querySelector('code.language-diff')!;

    expect([...code.children].map((line) => [line.className, line.textContent])).toEqual([
      ['diff-hunk', '@@ -1 +1 @@\n'],
      ['diff-del', '-<old>\n'],
      ['diff-add', '+new\n'],
      ['diff-line', ' same\n'],
    ]);
    expect(code.closest('.code-block')!.querySelector('button[data-action="copy-code"]')).not.toBeNull();
    expect(host.querySelector('pre')!.textContent).toBe('@@ -1 +1 @@\n-<old>\n+new\n same\n');
    expect(host.querySelector('code.language-ts')!.textContent).toBe('const a = 1;\n');
  });

  it('draws every feature of the sample artifact', () => {
    const host = dom(readFileSync(join(__dirname, 'gfm-sample.md'), 'utf8'));

    expect(host.querySelectorAll('details')).toHaveLength(3);
    expect(host.querySelectorAll('.markdown-alert')).toHaveLength(5);
    expect(host.querySelectorAll('input.task-list-item-checkbox')).toHaveLength(3);
    expect(host.querySelectorAll('kbd')).toHaveLength(3);
    expect(host.querySelectorAll('sub, sup:not(.footnote-ref)')).toHaveLength(2);
    expect(host.querySelectorAll('section.footnotes li')).toHaveLength(1);
    expect(host.querySelectorAll('a.anchor-link')).toHaveLength(4);
    expect(host.querySelectorAll('td[style*="right"]')).toHaveLength(2);
    expect(host.querySelector('code.language-diff .diff-add')).not.toBeNull();
    expect(host.querySelector('s')!.textContent).toBe('strikethrough');
    expect(host.textContent).toContain('🚀');
    expect(host.textContent).not.toMatch(/<!--|\[!NOTE\]|<\/?(details|summary|kbd)>/);
    // Nothing but the renderer's own attributes reaches the page.
    const names = new Set([...host.querySelectorAll('*')].flatMap((node) => [...node.attributes].map((one) => one.name)));

    expect([...names].sort()).toEqual(['aria-hidden', 'aria-label', 'checked', 'class', 'data-action', 'data-anchor', 'data-target', 'disabled', 'href', 'open', 'rel', 'role', 'style', 'tabindex', 'target', 'title', 'type']);
  });
});

describe("a question card's Markdown (renderCardText)", () => {
  const card = (text: string): HTMLElement => {
    const host = document.createElement('div');

    host.innerHTML = renderCardText(text);
    return host;
  };

  it('draws paragraphs, bulleted, numbered and nested lists, emphasis, code and links', () => {
    const host = card('They are:\n- **one**, *two* and `three`;\n- nested:\n  - deeper\n\nThen [the docs](https://example.com/docs) and [a file](D:/x/plan.md).\n\n3. third\n4. fourth');

    expect([...host.children].map((one) => one.tagName)).toEqual(['P', 'UL', 'P', 'OL']);
    expect(host.querySelector('ul > li > strong')?.textContent).toBe('one');
    expect(host.querySelector('ul > li > em')?.textContent).toBe('two');
    expect(host.querySelector('ul > li > code')?.textContent).toBe('three');
    expect(host.querySelector('ul > li > ul > li')?.textContent).toBe('deeper');
    expect(host.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(host.querySelector('a[href="https://example.com/docs"]')?.getAttribute('target')).toBe('_blank');
    expect(host.querySelector('a[href="https://example.com/docs"]')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(host.querySelector('a.path-link')?.getAttribute('data-target')).toBe('D:/x/plan.md');
  });

  it('joins a hard-wrapped paragraph and breaks a line at a backslash, as replies do', () => {
    expect(renderCardText('one\ntwo')).toBe('<p>one\ntwo</p>');
    expect(card('one\\\ntwo').querySelector('p > br')).not.toBeNull();
  });

  it('keeps raw HTML, headings, tables, quotes, code blocks, pictures and unsafe links as text', () => {
    const host = card('<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n# Heading\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n    indented\n\n![pic](https://example.com/a.png) [run](javascript:alert(1)) [run](JaVaScRiPt:alert(1)) <javascript:alert(1)>');

    expect(host.querySelector('script, img, h1, table, blockquote, pre, code, iframe')).toBeNull();
    // A picture shows as a link to it, opening in a new tab.
    expect([...host.querySelectorAll('a')].map((one) => one.getAttribute('href'))).toEqual(['https://example.com/a.png']);
    expect([...host.querySelectorAll('*')].flatMap((one) => one.getAttributeNames()).filter((name) => name.startsWith('on'))).toEqual([]);
    expect(host.textContent).toContain('<script>alert(1)</script>');
    expect(host.textContent).toContain('# Heading');
  });
});

describe('links a caller refuses', () => {
  it('render as text with why, never as a file tab link, for a relative path, an absolute path and a file: URI', () => {
    const asked: string[] = [];
    const host = document.createElement('div');

    host.innerHTML = renderMarkdown('[rel](../out.md) [abs](/etc/passwd) [uri](file:///D:/x.ts) [ok](a.md) [web](https://example.com)', undefined, (href) => {
      asked.push(href);
      return href === 'a.md' ? 'data-action="changes-file" data-path="a.md"' : { denied: 'Only files of this worktree <open> here.' };
    });

    expect(asked).toEqual(['../out.md', '/etc/passwd', 'file:///D:/x.ts', 'a.md']);

    const links = [...host.querySelectorAll('a')];

    for (const link of links.slice(0, 3)) {
      expect(link.classList.contains('denied')).toBe(true);
      expect(link.getAttribute('aria-disabled')).toBe('true');
      expect(link.getAttribute('title')).toBe('Only files of this worktree <open> here.');
      expect(link.hasAttribute('data-action')).toBe(false);
      expect(link.hasAttribute('data-target')).toBe(false);
      expect(link.hasAttribute('tabindex')).toBe(false);
    }

    expect(links[3]!.dataset['action']).toBe('changes-file');
    expect(links[4]!.getAttribute('target')).toBe('_blank');
  });

  it('keeps a file tab link when the resolver answers null, as before', () => {
    const host = document.createElement('div');

    host.innerHTML = renderMarkdown('[x](notes.md)', undefined, () => null);
    expect(host.querySelector('a')!.dataset['action']).toBe('local-file');
  });
});

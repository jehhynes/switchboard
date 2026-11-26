import MarkdownIt from 'markdown-it';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import { full as emoji } from 'markdown-it-emoji';
import footnote from 'markdown-it-footnote';

/**
 * GitHub-flavoured Markdown (architecture.md § Web page, Markdown). Raw HTML stays off, so a reply's text can never inject markup; the few
 * tags GitHub allows that a document needs (`<details>` and `<summary>`, `<kbd>`, `<sub>`, `<sup>`, `<br>` and the like) are read by
 * rules of their own, only without attributes, and drawn by this file. Tables, code spans and fences as GitHub draws them.
 */
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

/** Which link targets open in the browser: web pages; a path or a `file:` URI opens in the page's file tab, and any other scheme shows as text. */
export function webLink(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

const mailLink = (url: string): boolean => /^mailto:/i.test(url.trim());

// markdown-it's own check refuses `file:`, which agents use for a file on another drive or outside the working folder.
markdown.validateLink = (url) => webLink(url) || mailLink(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url.trim()) || /^(?:[a-z]:|file:)/i.test(url.trim());

export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

// Emoji shortcodes as GitHub's, without the `:)` shortcuts GitHub does not have.
markdown.use(emoji, { shortcuts: {} });
// Footnotes as GitHub's: `[^1]` and `[^1]: text`, not the plugin's inline `^[text]`.
markdown.use(footnote);
markdown.inline.ruler.disable('footnote_inline');

/** A link to a place in the same document: no `href`, so the page's own route in the address is never changed; the page scrolls to it. */
const anchorLink = (target: string, extra = ''): string => `class="anchor-link${extra}" tabindex="0" role="link" data-action="anchor" data-target="${escape(target)}"`;

const footnoteName = (tokens: Token[], index: number): string => {
  const meta = tokens[index]!.meta as { id: number; subId: number };

  return `${meta.id + 1}${meta.subId > 0 ? `:${meta.subId}` : ''}`;
};

markdown.renderer.rules['footnote_ref'] = (tokens, index) => {
  const meta = tokens[index]!.meta as { id: number };

  return `<sup class="footnote-ref"><a ${anchorLink(`^fn${meta.id + 1}`)} data-anchor="^fnref${footnoteName(tokens, index)}">${meta.id + 1}</a></sup>`;
};
markdown.renderer.rules['footnote_block_open'] = () => '<section class="footnotes"><ol class="footnotes-list">\n';
markdown.renderer.rules['footnote_open'] = (tokens, index) => `<li class="footnote-item" data-anchor="^fn${(tokens[index]!.meta as { id: number }).id + 1}">`;
markdown.renderer.rules['footnote_anchor'] = (tokens, index) => ` <a ${anchorLink(`^fnref${footnoteName(tokens, index)}`, ' footnote-backref')} aria-label="Back to the reference">\u21a9\uFE0E</a>`;

/** The inline tags GitHub keeps that the page draws, without attributes; `<br>` stands alone. */
const INLINE_TAGS = new Set(['kbd', 'sub', 'sup', 'ins', 'del', 's', 'mark', 'b', 'i', 'em', 'strong', 'u', 'small', 'samp', 'var', 'cite', 'dfn', 'q', 'code']);

function inlineTag(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x3c /* < */) {
    return false;
  }

  const end = state.src.startsWith('<!--', state.pos) ? commentEnd(state.env as Record<string, unknown>, state.src, state.pos + 4) : -1;

  if (end !== -1) {
    // An HTML comment shows nothing, as on GitHub.
    state.pos = end + 3;
    return true;
  }

  const rest = state.src.slice(state.pos);
  const wrapper = /^<\/?(?:p|div)(?:\s+align\s*=\s*(?:"[a-z]*"|'[a-z]*'|[a-z]+))?\s*>/i.exec(rest);

  if (wrapper !== null) {
    // A `<p>` or `<div>`, as a README wraps centred pictures in, shows nothing, so the pictures inside it show.
    state.pos += wrapper[0].length;
    return true;
  }

  const picture = htmlPicture(rest);

  if (picture !== null) {
    if (!silent) {
      state.push('html_inline', '', 0).content = picture.html;
    }

    state.pos += picture.length;
    return true;
  }

  const br = /^<br\s*\/?>/i.exec(rest);
  const tag = br === null ? /^<(\/?)([a-z]+)\s*>/i.exec(rest) : null;

  if (br === null && (tag === null || !INLINE_TAGS.has(tag[2]!.toLowerCase()))) {
    return false;
  }

  if (!silent) {
    const token = state.push('html_inline', '', 0);

    token.content = br !== null ? '<br>' : `<${tag![1]}${tag![2]!.toLowerCase()}>`;
    token.meta = { gfmTag: br !== null ? 'br' : tag![2]!.toLowerCase(), close: br === null && tag![1] === '/' };
  }

  state.pos += (br ?? tag)![0].length;
  return true;
}

markdown.inline.ruler.before('html_inline', 'gfm_tag', inlineTag);

/** An `<img>` tag's attributes: names, then a value in double or single quotes, bare, or none. */
const IMG_TAG = /^<img((?:\s+[a-z][a-z0-9-]*(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'|[^\s"'=<>`]+))?)*)\s*\/?>/i;
const IMG_ATTRIBUTE = /([a-z][a-z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;

/**
 * An `<img>` tag as GitHub draws one in Markdown, rebuilt as markdown-it draws a picture, so `linkify` resolves its source as any other:
 * only `src`, `alt`, `title`, `width` and `height` (a number, or a percentage), each once, with `src` a link `validateLink` takes. A
 * tag with any other attribute, such as an event handler or `srcset`, stays text. Character references in a value are read as such.
 */
function htmlPicture(text: string): { html: string; length: number } | null {
  const tag = IMG_TAG.exec(text);

  if (tag === null) {
    return null;
  }

  const values = new Map<string, string>();

  for (const [, name, double, single, bare] of tag[1]!.matchAll(IMG_ATTRIBUTE)) {
    const key = name!.toLowerCase();

    if (!['src', 'alt', 'title', 'width', 'height'].includes(key) || values.has(key)) {
      return null;
    }

    values.set(key, markdown.utils.unescapeAll(double ?? single ?? bare ?? ''));
  }

  const src = values.get('src')?.trim() ?? '';
  const size = (key: string): string => {
    const value = values.get(key);

    return value === undefined || !/^\d{1,5}%?$/.test(value) ? '' : ` ${key}="${value}"`;
  };

  if (src === '' || !markdown.validateLink(src)) {
    return null;
  }

  const title = values.get('title');
  const html = `<img src="${markdown.utils.escapeHtml(markdown.normalizeLink(src))}" alt="${markdown.utils.escapeHtml(values.get('alt') ?? '')}"${title === undefined ? '' : ` title="${markdown.utils.escapeHtml(title)}"`}${size('width')}${size('height')}>`;

  return { html, length: tag[0].length };
}

const DETAILS_OPEN = /^<details(\s+open)?\s*>/i;
/** The most lines a `<summary>` may take. */
const SUMMARY_LINES = 20;

/** A `<details>` line, with its `<summary>` on the same line or the lines after it, up to a blank line; a line of only `</details>` closes it. */
function details(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) {
    return false;
  }

  const line = (at: number): string => state.src.slice(state.bMarks[at]! + state.tShift[at]!, state.eMarks[at]);
  const first = line(startLine);

  if (/^<\/details\s*>\s*$/i.test(first)) {
    if (!silent) {
      state.push('details_close', 'details', 0);
      state.line = startLine + 1;
    }

    return true;
  }

  const open = DETAILS_OPEN.exec(first);

  if (open === null) {
    return false;
  }

  // The summary: the rest of the line and the lines after it, up to one ending in </summary>, before any blank line.
  let text = first.slice(open[0].length);
  let next = startLine + 1;
  let summary: string | null = null;

  if (text.trim() !== '' || (next < endLine && !state.isEmpty(next) && state.sCount[next]! >= state.blkIndent && /^<summary\s*>/i.test(line(next)))) {
    if (text.trim() === '') {
      text = line(next++);
    }

    const lines = [text];

    for (;;) {
      if (/<\/summary\s*>/i.test(lines[lines.length - 1]!)) {
        // Text after </summary> on its line makes it raw HTML on GitHub; here it stays text.
        const found = /^\s*<summary\s*>([\s\S]*?)<\/summary\s*>\s*$/i.exec(lines.join('\n'));

        if (found === null) {
          return false;
        }

        summary = found[1]!.trim();
        break;
      }

      // The summary stays in its own container (a list item's indent, a quote) and within a few lines.
      if (next >= endLine || lines.length >= SUMMARY_LINES || state.isEmpty(next) || state.sCount[next]! < state.blkIndent) {
        return false;
      }

      lines.push(line(next++));
    }
  }

  if (silent) {
    return true;
  }

  const token = state.push('details_open', 'details', 0);

  token.meta = { open: open[1] !== undefined };
  token.map = [startLine, next];

  if (summary !== null) {
    state.push('summary_open', 'summary', 0);
    const inline = state.push('inline', '', 0);

    inline.content = summary;
    inline.map = [startLine, next];
    inline.children = [];
    state.push('summary_close', 'summary', 0);
  }

  state.line = next;
  return true;
}

markdown.block.ruler.before('html_block', 'gfm_details', details, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

/**
 * Where the first `-->` at or after `from` starts in `src`, or -1. The last search is kept in the render's `env`, so the openers of a
 * text with many unclosed comments cost one pass, not one each.
 */
function commentEnd(env: Record<string, unknown>, src: string, from: number): number {
  const kept = env['gfmComment'] as { src: string; from: number; at: number } | undefined;

  if (kept !== undefined && kept.src === src && from >= kept.from && (kept.at === -1 || from <= kept.at)) {
    return kept.at;
  }

  const at = src.indexOf('-->', from);

  env['gfmComment'] = { src, from, at };
  return at;
}

/** An HTML comment on lines of its own, in its own container, shows nothing, as on GitHub; one with text after it is read inline. */
function comment(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine]! + state.tShift[startLine]!;

  if (state.sCount[startLine]! - state.blkIndent >= 4 || !state.src.startsWith('<!--', start)) {
    return false;
  }

  const end = commentEnd(state.env as Record<string, unknown>, state.src, start + 4);
  let next = startLine;

  if (end === -1) {
    return false;
  }

  while (state.eMarks[next]! < end + 3) {
    next++;

    if (next >= endLine || state.sCount[next]! < state.blkIndent) {
      return false;
    }
  }

  if (state.src.slice(end + 3, state.eMarks[next]).trim() !== '') {
    return false;
  }

  if (!silent) {
    state.line = next + 1;
  }

  return true;
}

markdown.block.ruler.before('html_block', 'gfm_comment', comment, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

markdown.renderer.rules['details_open'] = (tokens, index) => `<details${(tokens[index]!.meta as { open: boolean }).open ? ' open' : ''}>\n`;
markdown.renderer.rules['details_close'] = () => '</details>\n';
markdown.renderer.rules['summary_open'] = () => '<summary>';
markdown.renderer.rules['summary_close'] = () => '</summary>\n';

/**
 * Pairs each `<details>` with a `</details>` in the same container: a close with no open is dropped, and an open left unclosed is closed where
 * its container ends, so a tag in a reply can never close or wrap markup outside its own place.
 */
function pairDetails(state: StateCore): void {
  const out: Token[] = [];
  const open: number[] = [];

  const closeTo = (level: number): void => {
    while (open.length > 0 && open[open.length - 1]! > level) {
      out.push(new state.Token('details_close', 'details', 0));
      open.pop();
    }
  };

  for (const token of state.tokens) {
    if (token.nesting === -1) {
      closeTo(token.level);
    }

    if (token.type === 'details_open') {
      open.push(token.level);
    } else if (token.type === 'details_close') {
      if (open.length === 0 || open[open.length - 1] !== token.level) {
        continue;
      }

      open.pop();
    }

    out.push(token);
  }

  closeTo(-1);
  state.tokens = out;
}

markdown.core.ruler.after('block', 'gfm_details_pair', pairDetails);

/** GitHub's alert types, with their codicon and title. */
const ALERTS: Record<string, [icon: string, title: string]> = {
  note: ['info', 'Note'],
  tip: ['lightbulb', 'Tip'],
  important: ['report', 'Important'],
  warning: ['warning', 'Warning'],
  caution: ['stop-circle', 'Caution'],
};

/** A quote whose first line is only `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`, with more after it, is an alert. */
function alerts(state: StateCore): void {
  const tokens = state.tokens;

  for (let index = 0; index < tokens.length; index++) {
    const quote = tokens[index]!;
    const inline = tokens[index + 2];

    if (quote.type !== 'blockquote_open' || tokens[index + 1]?.type !== 'paragraph_open' || inline?.type !== 'inline') {
      continue;
    }

    const marker = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i.exec(inline.content);

    if (marker === null) {
      continue;
    }

    const rest = inline.content.slice(marker[0].length);
    const type = marker[1]!.toLowerCase();
    const [icon, title] = ALERTS[type]!;
    // An alert with nothing after its marker stays a quote, as on GitHub.
    const empty = rest.trim() === '' && tokens[index + 4]?.type === 'blockquote_close';

    if (empty) {
      continue;
    }

    quote.attrSet('class', `markdown-alert markdown-alert-${type}`);

    const head = new state.Token('html_block', '', 0);

    head.content = `<p class="markdown-alert-title"><span class="codicon codicon-${icon}" aria-hidden="true"></span>${title}</p>\n`;

    if (rest.trim() === '') {
      tokens.splice(index + 1, 3, head);
    } else {
      inline.content = rest;
      tokens.splice(index + 1, 0, head);
    }
  }
}

markdown.core.ruler.after('block', 'gfm_alerts', alerts);

/**
 * A heading's anchor, as GitHub makes it: lower case, punctuation dropped, spaces as hyphens, and -1, -2 after a repeated one, skipping any
 * another heading already has. A footnote's marks start with `^`, which no anchor has, so a heading never takes a footnote's place.
 */
export function slug(text: string, seen: Map<string, number>): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
  // `seen` holds every name given, each with the next suffix to try after it, so repeats cost no search from -1 again.
  let count = seen.get(base) ?? 0;
  let name = count === 0 ? base : `${base}-${count}`;

  while (count > 0 && seen.has(name)) {
    name = `${base}-${++count}`;
  }

  seen.set(base, count + 1);

  if (name !== base) {
    seen.set(name, seen.get(name) ?? 1);
  }

  return name;
}

const plain = (tokens: Token[]): string => tokens.map((token) => (token.type === 'text' || token.type === 'code_inline' ? token.content : token.type === 'emoji' ? '' : plain(token.children ?? []))).join('');

/**
 * After the inline pass: each heading's anchor (`data-anchor`, not an id, so it never clashes with the page's own ids), task list items with a
 * read-only checkbox, and the inline tags paired, an unpaired one shown as the text it was.
 */
function finish(state: StateCore): void {
  const tokens = state.tokens;
  const seen = new Map<string, number>();

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;

    if (token.type === 'heading_open') {
      token.attrSet('data-anchor', slug(plain(tokens[index + 1]?.children ?? []), seen));
    }

    if (token.type !== 'inline' || token.children === null) {
      continue;
    }

    pairTags(token.children);

    const first = token.children[0];
    const task = first?.type === 'text' ? /^\[([ xX])\](?=\s|$)\s?/.exec(first.content) : null;

    if (task === null || tokens[index - 1]?.type !== 'paragraph_open' || tokens[index - 2]?.type !== 'list_item_open') {
      continue;
    }

    const box = new state.Token('html_inline', '', 0);

    box.content = `<input type="checkbox" class="task-list-item-checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> `;
    first!.content = first!.content.slice(task[0].length);
    token.children.unshift(box);

    const item = tokens[index - 2]!;

    item.attrJoin('class', 'task-list-item');

    for (let back = index - 3; back >= 0; back--) {
      const list = tokens[back]!;

      if ((list.type === 'bullet_list_open' || list.type === 'ordered_list_open') && list.level === item.level - 1) {
        if (!(list.attrGet('class') ?? '').split(' ').includes('contains-task-list')) {
          list.attrJoin('class', 'contains-task-list');
        }

        break;
      }
    }
  }
}

/** Pairs a run's inline tags; one with no partner becomes its own text again, escaped as text. */
function pairTags(children: Token[]): void {
  const open: Token[] = [];
  const unpaired = new Set<Token>();

  for (const child of children) {
    const meta = child.meta as { gfmTag?: string; close?: boolean } | null;

    if (child.type !== 'html_inline' || meta?.gfmTag === undefined || meta.gfmTag === 'br') {
      continue;
    }

    if (!meta.close) {
      open.push(child);
      continue;
    }

    const at = open.map((one) => (one.meta as { gfmTag: string }).gfmTag).lastIndexOf(meta.gfmTag);

    if (at === -1) {
      unpaired.add(child);
    } else {
      open.splice(at).slice(1).forEach((one) => unpaired.add(one));
    }
  }

  open.forEach((one) => unpaired.add(one));

  for (const child of unpaired) {
    child.type = 'text';
  }
}

// Last, so a heading's anchor sees its emoji drawn, as GitHub's leaves them out.
markdown.core.ruler.push('gfm_finish', finish);

const defaultFence = markdown.renderer.rules.fence!;

// A Mermaid block becomes a diagram once Mermaid loads; every other block sits in a frame with its copy button. Mermaid replaces the block's
// contents with its drawing, so the block is keyed by its place and its source: a changed source is a new block, drawn afresh, never a
// drawing left over its old source. A `diff` block colours its added and removed lines, as GitHub does.
markdown.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  const lang = token.info.trim().split(/\s+/)[0];

  if (lang === 'mermaid') {
    return `<pre class="mermaid" data-key="mermaid:${index}:${escape(token.content)}">${escape(token.content)}</pre>`;
  }

  if (lang === 'diff') {
    const lines = token.content.replace(/\n$/, '').split('\n');
    const kind = (line: string): string => (line.startsWith('@@') ? 'diff-hunk' : line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : 'diff-line');
    const code = lines.map((line) => `<span class="${kind(line)}">${escape(line)}\n</span>`).join('');

    return `<div class="code-block">${copyButton('copy-code', 'Copy code')}<pre><code class="language-diff">${code}</code></pre></div>`;
  }

  return `<div class="code-block">${copyButton('copy-code', 'Copy code')}${defaultFence(tokens, index, options, env, self)}</div>`;
};

const defaultCode = markdown.renderer.rules.code_block!;

markdown.renderer.rules.code_block = (...args) => `<div class="code-block">${copyButton('copy-code', 'Copy code')}${defaultCode(...args)}</div>`;

/** A copy button, in a code block's corner or under a reply, shown on hover or focus. */
export function copyButton(action: 'copy-code' | 'copy-reply', label: string): string {
  return `<button class="copy" type="button" data-action="${action}" title="${label}" aria-label="${label} to clipboard"><span class="codicon codicon-copy" aria-hidden="true"></span></button>`;
}

/** What a link resolver answers for a link to a path: the attributes of its `<a>`, null to open it in a file tab, or why it may not open. */
export type LinkAnswer = string | null | { denied: string };

/**
 * Markdown as HTML: a web link opens in a new tab with no referrer; a link to a place in the text (`#name`) scrolls to it; a link to a path
 * keeps its text, shows its target as a tooltip and opens in a file tab of the page (`data-action="local-file"`). `base`, when given, turns an
 * image's relative source into the artifact file route, for an artifact's Markdown, and `link` a link's target into the attributes of its
 * `<a>`, null for a file tab, or `denied` for plain text that says why it does not open, so a link the caller refuses never falls back to
 * the file tab's wider route.
 */
export function renderMarkdown(text: string, base?: (path: string) => string | null, link?: (href: string) => LinkAnswer): string {
  return linkify(markdown.render(text), base, link);
}

export function renderInline(text: string): string {
  return linkify(markdown.renderInline(text));
}

/**
 * The Markdown a question card draws in a question's context and an option's description (architecture.md § Question cards): paragraphs,
 * lists, hard line breaks, emphasis, strikethrough, code spans and links. Anything else, such as a heading, a table, a picture or raw HTML,
 * stays text.
 */
const cardMarkdown = new MarkdownIt('zero', { html: false, linkify: true, breaks: false }).enable(['list', 'newline', 'escape', 'entity', 'backticks', 'emphasis', 'strikethrough', 'link', 'autolink', 'linkify']);

cardMarkdown.validateLink = markdown.validateLink;

/** A card's context or description as HTML, its links as `renderMarkdown` draws them. */
export function renderCardText(text: string): string {
  return linkify(cardMarkdown.render(text)).trimEnd();
}

/** The place a `#name` link names, as written before markdown-it escaped and encoded it. */
function anchorTarget(href: string): string {
  const plain = href.slice(1).replace(/&(amp|quot|lt|gt|#39);/g, (_match, name: string) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'" })[name]!);

  try {
    return decodeURIComponent(plain);
  } catch {
    return plain;
  }
}

function linkify(html: string, base?: (path: string) => string | null, link?: (href: string) => LinkAnswer): string {
  return html
    .replace(/<a href="([^"]*)"/g, (_match, href: string) => {
      if (webLink(href)) {
        return `<a href="${href}" target="_blank" rel="noopener noreferrer"`;
      }

      if (mailLink(href)) {
        return `<a href="${href}"`;
      }

      if (href.startsWith('#')) {
        return `<a ${anchorLink(anchorTarget(href))}`;
      }

      const to = link?.(href) ?? null;

      if (to !== null && typeof to === 'object') {
        // Text with no action: nothing the page could open, with why as its tooltip.
        return `<a class="path-link denied" aria-disabled="true" title="${escape(to.denied)}"`;
      }

      // The page opens a path's file in a tab (`LocalFilesController`); a focusable link, though it has no href a browser could follow.
      return to === null ? `<a class="path-link" title="${href}" tabindex="0" role="link" data-action="local-file" data-target="${href}"` : `<a ${to}`;
    })
    .replace(/<img src="([^"]*)" alt="([^"]*)"([^>]*)>/g, (_match, src: string, alt: string, rest: string) => {
      const web = /^(?:https?:|data:)/i.test(src);
      const to = web ? src : (base?.(src) ?? null);

      return picture(to === null ? null : web ? src : escape(to), src, alt, rest);
    });
}

/**
 * A picture in its frame (`.picture`), with a note in its place, shown by the page when it cannot show the picture (`watchPictures`): when the
 * source names no file the page may read (`to` null), the hub refuses or lacks it, or it is on the web, which the page's CSP blocks. The
 * note names the picture by its alt text or file name, gives its source as a tooltip, and opens a web picture in a browser tab. `src`,
 * `alt` and `rest` are markdown-it's escaped attributes; `to` is escaped.
 */
function picture(to: string | null, src: string, alt: string, rest: string): string {
  // Without alt text, the file name, decoded as written (`anchorTarget` undoes markdown-it's escaping and encoding).
  const named = alt !== '' ? alt : escape(anchorTarget(`#${src.split(/[?#]/)[0]!.split('/').pop() ?? ''}`));
  const open = webLink(src) ? ` <a href="${src}" target="_blank" rel="noopener noreferrer">Open</a>` : '';
  const note = `<span class="picture-missing" title="${src}">Picture not shown: ${named}${open}</span>`;

  return to === null ? `<span class="picture broken">${note}</span>` : `<span class="picture"><img src="${to}" alt="${alt}"${rest} data-picture="">${note}</span>`;
}

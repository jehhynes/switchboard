import MarkdownIt from 'markdown-it';

/** Raw HTML off, so a reply's text can never inject markup; tables, code spans and fences as GitHub draws them. */
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

/** Which link targets stay links: web pages; a path or any other scheme shows as text, since a browser page cannot open a local file. */
export function webLink(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

markdown.validateLink = (url) => webLink(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url.trim()) || /^[a-z]:/i.test(url.trim());

export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const defaultFence = markdown.renderer.rules.fence!;

// A Mermaid block becomes a diagram once Mermaid loads; every other block sits in a frame with its copy button. Mermaid replaces the block's
// contents with its drawing, so the block is keyed by its place and its source: a changed source is a new block, drawn afresh, never a
// drawing left over its old source.
markdown.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index]!;

  if (token.info.trim().split(/\s+/)[0] === 'mermaid') {
    return `<pre class="mermaid" data-key="mermaid:${index}:${escape(token.content)}">${escape(token.content)}</pre>`;
  }

  return `<div class="code-block">${copyButton('copy-code', 'Copy code')}${defaultFence(tokens, index, options, env, self)}</div>`;
};

const defaultCode = markdown.renderer.rules.code_block!;

markdown.renderer.rules.code_block = (...args) => `<div class="code-block">${copyButton('copy-code', 'Copy code')}${defaultCode(...args)}</div>`;

/** A copy button, in a code block's corner or under a reply, shown on hover or focus. */
export function copyButton(action: 'copy-code' | 'copy-reply', label: string): string {
  return `<button class="copy" type="button" data-action="${action}" title="${label}" aria-label="${label} to clipboard"><span class="codicon codicon-copy" aria-hidden="true"></span></button>`;
}

/**
 * Markdown as HTML: a web link opens in a new tab with no referrer; a link to a path, which a browser cannot open, keeps its text and shows its
 * target as a tooltip. `base`, when given, turns an image's relative source into the artifact file route, for an artifact's Markdown, and
 * `link` a relative link's target into the attributes of its `<a>`, or null to keep it as text.
 */
export function renderMarkdown(text: string, base?: (path: string) => string | null, link?: (href: string) => string | null): string {
  return linkify(markdown.render(text), base, link);
}

export function renderInline(text: string): string {
  return linkify(markdown.renderInline(text));
}

function linkify(html: string, base?: (path: string) => string | null, link?: (href: string) => string | null): string {
  return html
    .replace(/<a href="([^"]*)"/g, (_match, href: string) => {
      if (webLink(href)) {
        return `<a href="${href}" target="_blank" rel="noopener noreferrer"`;
      }

      const to = link?.(href) ?? null;

      return to === null ? `<a class="path-link" title="${href}"` : `<a ${to}`;
    })
    .replace(/<img src="([^"]*)"/g, (_match, src: string) => {
      if (/^(?:https?:|data:)/i.test(src)) {
        return `<img src="${src}"`;
      }

      const to = base?.(src) ?? null;

      return to === null ? '<img' : `<img src="${escape(to)}"`;
    });
}

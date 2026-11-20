import type MarkdownIt from 'markdown-it';

/** The class of a Mermaid diagram's placeholder, which the preview script draws (`webview/mermaidPreview.ts`). */
export const MERMAID_CLASS = 'switchboard-mermaid';

/**
 * The Markdown preview's Mermaid support (voice-design § 4.4, architecture.md § Artifacts): VS Code's Markdown extension calls this with its
 * markdown-it, because the extension declares `markdown.markdownItPlugins`. A ```mermaid fence becomes a placeholder holding its source, which
 * the bundled preview script turns into a diagram, offline; every other fence renders as before.
 */
export function extendMarkdownIt(md: MarkdownIt): MarkdownIt {
  const fence = md.renderer.rules.fence;

  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index]!;

    if (token.info.trim().split(/\s+/)[0]?.toLowerCase() === 'mermaid') {
      const line = token.map === null ? '' : ` data-line="${token.map[0]}"`;

      return `<pre class="${MERMAID_CLASS}"${line}>${md.utils.escapeHtml(token.content)}</pre>\n`;
    }

    return fence === undefined ? self.renderToken(tokens, index, options) : fence(tokens, index, options, env, self);
  };

  return md;
}

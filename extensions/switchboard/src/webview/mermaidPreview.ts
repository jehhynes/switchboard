/**
 * Draws the Markdown preview's Mermaid placeholders (`markdownMermaid.ts`) with the bundled `mermaid.min.js`, which the preview loads before this
 * script (`markdown.previewScripts`): offline, in the theme's light or dark colours, again whenever the preview updates its content. A diagram
 * Mermaid cannot read keeps its source, with Mermaid's error under it.
 */
export interface Mermaid {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

const CLASS = 'switchboard-mermaid';
let next = 0;

/** Mermaid's theme for the preview's: VS Code marks the body with `vscode-dark`, `vscode-light` or a high contrast class. */
export function mermaidTheme(body: { classList: { contains(name: string): boolean } }): 'dark' | 'default' {
  return body.classList.contains('vscode-dark') || body.classList.contains('vscode-high-contrast') ? 'dark' : 'default';
}

export async function drawDiagrams(document: Document, mermaid: Mermaid | undefined): Promise<number> {
  const pending = [...document.querySelectorAll<HTMLElement>(`.${CLASS}:not([data-drawn])`)];

  if (mermaid === undefined || pending.length === 0) {
    return 0;
  }

  // Marked before the first wait, so a draw that starts meanwhile, as on load, takes none of them again.
  for (const element of pending) {
    element.dataset['drawn'] = 'pending';
  }

  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: mermaidTheme(document.body) });

  let drawn = 0;

  for (const element of pending) {
    const source = element.textContent ?? '';
    const id = `${CLASS}-${++next}`;

    try {
      const { svg } = await mermaid.render(id, source);

      element.innerHTML = svg;
      element.dataset['drawn'] = 'yes';
      drawn++;
    } catch (error) {
      // Mermaid can leave its scratch element behind after a failure.
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
      element.dataset['drawn'] = 'error';

      const why = document.createElement('div');

      why.className = `${CLASS}-error`;
      why.textContent = `Mermaid could not draw this diagram: ${error instanceof Error ? error.message : String(error)}`;
      element.after(why);
    }
  }

  return drawn;
}

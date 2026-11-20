import { drawDiagrams } from './mermaidPreview.js';
import type { Mermaid } from './mermaidPreview.js';

/** How long the script waits for `mermaid.min.js`, which the preview may load after it, since it loads both with `async`. */
const WAIT_MS = 10_000;

const mermaidOf = (): Mermaid | undefined => (window as unknown as { mermaid?: Mermaid }).mermaid;
const draw = (): void => void drawDiagrams(document, mermaidOf());
const started = Date.now();
const waitForMermaid = (): void => {
  if (mermaidOf() !== undefined) {
    draw();
  } else if (Date.now() - started < WAIT_MS) {
    setTimeout(waitForMermaid, 50);
  }
};

window.addEventListener('vscode.markdown.updateContent', draw);
window.addEventListener('load', draw);
waitForMermaid();

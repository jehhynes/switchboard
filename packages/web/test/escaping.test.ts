import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The page's Preact parts (`src/**/*.tsx`) build no HTML strings, so JSX escapes every text and attribute they draw (architecture.md § Web page).
const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const RULES: Array<[string, RegExp]> = [
  ['sets innerHTML', /\binnerHTML\b/],
  ['sets outerHTML', /\bouterHTML\b/],
  ['calls insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['uses dangerouslySetInnerHTML', /\bdangerouslySetInnerHTML\b/],
  ['calls createContextualFragment', /\bcreateContextualFragment\b/],
  ['calls document.write', /\bdocument\.write(ln)?\b/],
  ['calls setHTMLUnsafe or parseHTMLUnsafe', /\b(setHTMLUnsafe|parseHTMLUnsafe)\b/],
  ['uses DOMParser', /\bDOMParser\b/],
  ['sets srcdoc', /\bsrcdoc\b/i],
  ['draws with morph', /\bmorph\b/],
  ['imports escape', /import\s*\{[^}]*\bescape\b[^}]*\}\s*from/],
];

/** What a file breaks of the rules. */
const broken = (text: string): string[] => RULES.flatMap(([rule, pattern]) => (pattern.test(text) ? [rule] : []));

describe('escaping by default', () => {
  const parts = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.tsx'));

  it('covers the Preact parts', () => {
    expect(parts).toContain('attachments.tsx');
  });

  it('finds each way to put an HTML string in the page', () => {
    expect(broken("host.innerHTML = '<b>'; el.outerHTML = x; el.insertAdjacentHTML('beforeend', x); <div dangerouslySetInnerHTML={x} />")).toEqual([
      'sets innerHTML',
      'sets outerHTML',
      'calls insertAdjacentHTML',
      'uses dangerouslySetInnerHTML',
    ]);
    expect(broken("range.createContextualFragment(x); document.writeln(x); morph(host, x); import { escape, renderMarkdown } from './markdown.js';")).toEqual([
      'calls createContextualFragment',
      'calls document.write',
      'draws with morph',
      'imports escape',
    ]);
    expect(broken("el.setHTMLUnsafe(x); new DOMParser().parseFromString(x, 'text/html'); <iframe srcDoc={x} />")).toEqual([
      'calls setHTMLUnsafe or parseHTMLUnsafe',
      'uses DOMParser',
      'sets srcdoc',
    ]);
    expect(broken('<span class="attachment-name">{file.name}</span>')).toEqual([]);
  });

  it('finds no HTML string in a Preact part', () => {
    expect(parts.flatMap((name) => broken(readFileSync(join(SRC, name), 'utf8')).map((rule) => `${name} ${rule}`))).toEqual([]);
  });
});

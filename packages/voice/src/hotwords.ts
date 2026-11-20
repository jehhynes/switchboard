import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Hotword biasing for the recogniser (architecture.md § Dictation), from claude-collab's `hotwords.js`: words the operator says that the model
 * mishears ("work train" for worktree). sherpa-onnx boosts them in its modified beam search, splitting each into the model's BPE pieces with a
 * `bpe.vocab`, which the model does not ship: `tokens.txt` lists the tokens in merge order, so each gets the score `-id`, the merge priority a
 * sentencepiece BPE model would give it.
 */
export function bpeVocab(tokens: string): string {
  return `${tokens
    .split(/\r?\n/)
    .map((line) => line.split(' '))
    .filter(([token, id]) => token !== undefined && token !== '' && id !== undefined && token !== '<blk>')
    .map(([token, id]) => `${token}\t${token === '<unk>' ? 0 : -Number(id)}`)
    .join('\n')}\n`;
}

/** The hotword list: the fixed terms, then the learnt ones, spaces collapsed, each once ignoring case. */
export function hotwordList(fixed: readonly string[], learned: readonly string[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const term of [...fixed, ...learned].map((one) => one.trim().replace(/\s+/g, ' '))) {
    if (term !== '' && !seen.has(term.toLowerCase())) {
      seen.add(term.toLowerCase());
      terms.push(term);
    }
  }

  return terms;
}

/**
 * Writes the model's `bpe.vocab` and a hotwords file for the terms into `<voice home>/hotwords`, the file named by its terms, so recognisers
 * built at the same time for different repositories never share one; null for the file with no terms. sherpa-onnx documents no hotword limit
 * and they cost graph build time, not decode time; the learnt terms' cap is against false boosts.
 */
export function writeHotwords(voiceHome: string, modelDir: string, terms: readonly string[]): { bpeVocab: string; hotwordsFile: string | null } {
  const dir = join(voiceHome, 'hotwords');
  const vocab = join(dir, 'bpe.vocab');

  mkdirSync(dir, { recursive: true });
  writeFileSync(vocab, bpeVocab(readFileSync(join(modelDir, 'tokens.txt'), 'utf8')));

  if (terms.length === 0) {
    return { bpeVocab: vocab, hotwordsFile: null };
  }

  const text = `${terms.join('\n')}\n`;
  const file = join(dir, `hotwords-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.txt`);

  writeFileSync(file, text);
  return { bpeVocab: vocab, hotwordsFile: file };
}

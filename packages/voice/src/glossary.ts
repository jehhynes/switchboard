import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isLearnable } from './terms.js';

/**
 * The learnt glossary (architecture.md § Dictation), from claude-collab's `glossary.js`: the mishearings Claude tagged with a heard tag, counted per
 * pair, and when each learnt term was last used. One per Switchboard home, in `voice/glossary.json`, shared by every repository; only the voice
 * process writes it. It only feeds the recogniser's hotwords; nothing replaces words with it.
 *
 * A pair's meant term becomes a hotword once the same heard phrase was tagged with the same meant term `CONFIRM` times, so a one-off changes
 * nothing, and only if it is a name or a technical term (`isLearnable`); other pairs are dropped on load and never recorded. At most
 * `MAX_LEARNED` learnt terms are boosted besides the fixed ones: the most recently used (a tag, or the term in the operator's recognised words),
 * then the most used, since a term that works as a hotword stops being missed.
 */
export interface Glossary {
  pairs: Record<string, { meant: string; count: number }>;
  used: Record<string, { term: string; last: number; uses: number }>;
}

export const CONFIRM = 2;
export const MAX_LEARNED = 50;

export function glossaryFile(voiceHome: string): string {
  return join(voiceHome, 'glossary.json');
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads the glossary; a missing or unreadable file is empty, and pairs and uses whose term fails `isLearnable` are dropped. */
export function loadGlossary(file: string, user: readonly string[] = []): Glossary {
  let raw: unknown = {};

  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // None yet.
  }

  const glossary: Glossary = { pairs: {}, used: {} };
  const root = isObject(raw) ? raw : {};

  for (const [heard, pair] of Object.entries(isObject(root.pairs) ? root.pairs : {})) {
    if (isObject(pair) && typeof pair.meant === 'string' && isLearnable(pair.meant, user)) {
      glossary.pairs[heard.toLowerCase()] = { meant: pair.meant.normalize('NFC'), count: Math.max(1, Number(pair.count) || 1) };
    }
  }

  for (const [key, use] of Object.entries(isObject(root.used) ? root.used : {})) {
    if (!isObject(use) || typeof use.term !== 'string' || !isLearnable(use.term, user)) {
      continue;
    }

    // Spellings that come to one key merge: the latest use, the most uses.
    const k = key.normalize('NFC').toLowerCase();
    const before = glossary.used[k];

    glossary.used[k] = { term: use.term.normalize('NFC'), last: Math.max(Number(use.last) || 0, before?.last ?? 0), uses: Math.max(Math.max(0, Number(use.uses) || 0), before?.uses ?? 0) };
  }

  return glossary;
}

/** Writes a temporary file first and renames it over the glossary, so a reader never sees half of one. */
export function saveGlossary(file: string, glossary: Glossary): void {
  mkdirSync(dirname(file), { recursive: true });

  const temporary = `${file}.${process.pid}.tmp`;

  writeFileSync(temporary, JSON.stringify({ pairs: glossary.pairs, used: glossary.used }, null, 2));
  renameSync(temporary, file);
}

function touch(glossary: Glossary, term: string, now: number): void {
  const key = term.toLowerCase();

  glossary.used[key] = { term, last: now, uses: (glossary.used[key]?.uses ?? 0) + 1 };
}

/**
 * Counts one tagged mishearing: a heard phrase tagged with a different meant term starts again at 1, so only identical failures add up. A meant term
 * that fails the guard is not recorded: null. Otherwise the pair, and whether this tag confirmed it.
 */
export function recordHeard(glossary: Glossary, heard: string, meant: string, now: number, user: readonly string[] = []): { meant: string; count: number; confirmed: boolean } | null {
  const term = meant.normalize('NFC').trim();

  if (!isLearnable(term, user)) {
    return null;
  }

  const key = heard.trim().toLowerCase();
  const before = glossary.pairs[key];
  const pair = before !== undefined && before.meant === term ? { meant: term, count: before.count + 1 } : { meant: term, count: 1 };

  glossary.pairs[key] = pair;
  touch(glossary, term, now);

  return { ...pair, confirmed: pair.count === CONFIRM };
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Marks each learnt term the operator's recognised words hold, as whole words in any case, as used now; the terms found. */
export function noteUsed(glossary: Glossary, text: string, now: number): string[] {
  const found: string[] = [];
  const terms = new Map<string, string>();

  for (const { meant } of Object.values(glossary.pairs)) {
    if (!terms.has(meant.toLowerCase())) {
      terms.set(meant.toLowerCase(), meant);
    }
  }

  for (const term of terms.values()) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escapeRe(term).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{M}\\p{N}])`, 'iu');

    if (pattern.test(text.normalize('NFC'))) {
      touch(glossary, term, now);
      found.push(term);
    }
  }

  return found;
}

/** The learnt terms to boost: the meant terms of the confirmed pairs, each once, without the fixed terms, at most `max` by latest then most use. */
export function learnedTerms(glossary: Glossary, fixed: readonly string[], max = MAX_LEARNED): string[] {
  const fixedKeys = new Set(fixed.map((term) => term.toLowerCase()));
  const terms = new Map<string, string>();

  for (const { meant, count } of Object.values(glossary.pairs)) {
    if (count >= CONFIRM && !fixedKeys.has(meant.toLowerCase()) && !terms.has(meant.toLowerCase())) {
      terms.set(meant.toLowerCase(), meant);
    }
  }

  const usage = (key: string): { last: number; uses: number } => glossary.used[key] ?? { last: 0, uses: 0 };

  return [...terms.entries()]
    .sort(([a], [b]) => usage(b).last - usage(a).last || usage(b).uses - usage(a).uses)
    .slice(0, max)
    .map(([, term]) => term);
}

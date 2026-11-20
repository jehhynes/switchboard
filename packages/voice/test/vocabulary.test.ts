import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIRM, MAX_LEARNED, glossaryFile, learnedTerms, loadGlossary, noteUsed, recordHeard } from '../src/glossary.js';
import { bpeVocab, hotwordList, writeHotwords } from '../src/hotwords.js';
import { fixedTerms, isCommonWord, isLearnable, readTerms } from '../src/terms.js';
import { Vocabulary } from '../src/vocabulary.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'voice-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const terms = (path: string, text: string): void => {
  mkdirSync(join(home, 'terms', ...path.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(home, 'terms', ...path.split('/')), text);
};

describe('terms', () => {
  it('reads the user terms and the repository\'s, each once, skipping comments and blank lines', () => {
    terms('user.txt', '# mine\nClaude Code\n\n  worktree  \n');
    terms('repos/acme/app.txt', 'worktree\nAcme # the product\n');
    expect(readTerms(join(home, 'missing.txt'))).toEqual([]);
    expect(fixedTerms(home, null)).toEqual(['Claude Code', 'worktree']);
    expect(fixedTerms(home, 'acme/app')).toEqual(['Claude Code', 'worktree', 'Acme']);
    expect(fixedTerms(home, 'acme/other')).toEqual(['Claude Code', 'worktree']);
  });

  it('learns names and technical terms only, judged by the meant term', () => {
    expect(isCommonWord('sessions')).toBe(true);
    expect(isCommonWord('running')).toBe(true);
    expect(isCommonWord('Ares')).toBe(false);
    expect(isCommonWord('on-their-own')).toBe(true);
    expect(isCommonWord('Half-Life')).toBe(false);
    expect(isLearnable('Nemotron')).toBe(true);
    expect(isLearnable('fixup')).toBe(true);
    expect(isLearnable('wait')).toBe(false);
    expect(isLearnable('Code Mode')).toBe(true);
    expect(isLearnable('voice model')).toBe(false);
    expect(isLearnable('git-flow')).toBe(true);
    expect(isLearnable('main', ['main'])).toBe(true);
    expect(isLearnable('  ')).toBe(false);
    expect(isLearnable('!!')).toBe(false);
  });
});

describe('glossary', () => {
  it('promotes a pair after the same mishearing is tagged twice, and starts again when the meant term changes', () => {
    const glossary = loadGlossary(glossaryFile(home));

    expect(recordHeard(glossary, 'A Llama', 'Ollama', 1)).toEqual({ meant: 'Ollama', count: 1, confirmed: false });
    expect(learnedTerms(glossary, [])).toEqual([]);
    expect(recordHeard(glossary, 'a llama', 'Ollama', 2)).toEqual({ meant: 'Ollama', count: CONFIRM, confirmed: true });
    expect(learnedTerms(glossary, [])).toEqual(['Ollama']);
    expect(recordHeard(glossary, 'a llama', 'Llama', 3)).toMatchObject({ count: 1 });
    expect(learnedTerms(glossary, [])).toEqual([]);
    expect(recordHeard(glossary, 'weight', 'wait', 4)).toBeNull();
  });

  it('boosts at most 50 learnt terms, the most recently used first, leaving out the fixed ones', () => {
    const glossary = loadGlossary(glossaryFile(home));

    for (let index = 0; index < MAX_LEARNED + 5; index++) {
      recordHeard(glossary, `heard${index}`, `Term${index}x`, index);
      recordHeard(glossary, `heard${index}`, `Term${index}x`, index);
    }

    expect(noteUsed(glossary, 'about term0x and TERM1X now', 1_000)).toEqual(['Term0x', 'Term1x']);
    expect(noteUsed(glossary, 'TERM1X again, not term1xy', 2_000)).toEqual(['Term1x']);

    const learned = learnedTerms(glossary, ['Term2x']);

    expect(learned).toHaveLength(MAX_LEARNED);
    expect(learned.slice(0, 2)).toEqual(['Term1x', 'Term0x']);
    expect(learned).not.toContain('Term2x');
    expect(learned).not.toContain('Term3x');
  });

  it('reads back what it saved, dropping pairs whose term is not learnable, and treats a broken file as empty', () => {
    const vocabulary = new Vocabulary(home, () => 5, () => undefined);

    vocabulary.heard('nema tron', 'Nemotron');
    expect(vocabulary.heard('nema tron', 'Nemotron')).toBe(true);
    expect(JSON.parse(readFileSync(glossaryFile(home), 'utf8'))).toEqual({ pairs: { 'nema tron': { meant: 'Nemotron', count: 2 } }, used: { nemotron: { term: 'Nemotron', last: 5, uses: 2 } } });
    writeFileSync(glossaryFile(home), JSON.stringify({ pairs: { x: { meant: 'wait', count: 4 }, y: { meant: 'Zod', count: 0 } }, used: { wait: { term: 'wait', last: 1, uses: 1 }, ZOD: { term: 'Zod', last: 2, uses: 3 }, zod: { term: 'Zod', last: 9, uses: 1 } } }));
    expect(loadGlossary(glossaryFile(home))).toEqual({ pairs: { y: { meant: 'Zod', count: 1 } }, used: { zod: { term: 'Zod', last: 9, uses: 3 } } });
    writeFileSync(glossaryFile(home), '{');
    expect(loadGlossary(glossaryFile(home))).toEqual({ pairs: {}, used: {} });
  });

  it('gives the recogniser the fixed terms, then the confirmed learnt ones, and keeps a term used', () => {
    const logs: string[] = [];
    const vocabulary = new Vocabulary(home, () => 7, (line) => logs.push(line));

    terms('user.txt', 'Switchboard\n');
    terms('repos/acme/app.txt', 'Acme\n');
    expect(vocabulary.heard('fix up', 'wait')).toBe(false);
    expect(logs).toEqual(['heard tag "fix up" = "wait" not learnt: not a name or a technical term']);
    vocabulary.heard('fix up', 'fixup');
    vocabulary.heard('fix up', 'fixup');
    expect(vocabulary.terms('acme/app')).toEqual(['Switchboard', 'Acme', 'fixup']);
    expect(vocabulary.terms(null)).toEqual(['Switchboard', 'fixup']);
    vocabulary.used('an autosquash fixup');
    expect(JSON.parse(readFileSync(glossaryFile(home), 'utf8')).used.fixup.uses).toBe(3);
  });
});

describe('hotwords', () => {
  it('scores each BPE token by its merge order and writes one hotwords file per term list', () => {
    expect(bpeVocab('<blk> 0\n<unk> 1\n▁the 2\ns 3\n')).toBe('<unk>\t0\n▁the\t-2\ns\t-3\n');
    expect(hotwordList(['Claude  Code', 'worktree'], ['WORKTREE', ' ', 'Ollama'])).toEqual(['Claude Code', 'worktree', 'Ollama']);

    const model = join(home, 'model');

    mkdirSync(model);
    writeFileSync(join(model, 'tokens.txt'), '<blk> 0\n▁a 1\n');

    const one = writeHotwords(home, model, ['Ollama']);
    const two = writeHotwords(home, model, ['Ollama', 'fixup']);

    expect(readFileSync(one.bpeVocab, 'utf8')).toBe('▁a\t-1\n');
    expect(readFileSync(one.hotwordsFile!, 'utf8')).toBe('Ollama\n');
    expect(two.hotwordsFile).not.toBe(one.hotwordsFile);
    expect(writeHotwords(home, model, []).hotwordsFile).toBeNull();
  });
});

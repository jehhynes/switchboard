import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { promptKeyData, readPrompt, screenRows } from '../src/prompt.js';

// Screens recorded from Claude Code 2.1.330 in the classic renderer, paths scrubbed (mechanics M102).
const screen = (name: string): string[] => readFileSync(join(import.meta.dirname, 'fixtures', 'prompts', `${name}.txt`), 'utf8').split('\n');

describe('readPrompt', () => {
  it("reads a permission prompt from the rule above it, with each numbered option and the cursor's", () => {
    const prompt = readPrompt(screen('permission'))!;

    expect(prompt.lines[0]).toBe(' Bash command');
    expect(prompt.lines).toContain(' Do you want to proceed?');
    expect(prompt.lines.at(-1)).toBe(' Esc to cancel · Tab to amend');
    expect(prompt.options.map((option) => [option.key, option.label.slice(0, 20), option.selected])).toEqual([
      ['1', 'Yes', true],
      ['2', 'Yes, and always allo', false],
      ['3', 'Yes, and switch to a', false],
      ['4', 'No', false],
    ]);
    expect(prompt.next).toBe(false);
  });

  it("reads a question form's options without Type something, with its tab strip, and its review step", () => {
    const form = readPrompt(screen('question-form'))!;

    expect(form.options.map((option) => [option.key, option.label])).toEqual([['1', 'Red'], ['2', 'Blue'], ['4', 'Chat about this']]);
    expect(form.next).toBe(true);
    expect(form.lines).toContain('Pick a color');

    const review = readPrompt(screen('question-review'))!;

    expect(review.options.map((option) => option.label)).toEqual(['Submit answers', 'Cancel']);
    expect(review.id).not.toBe(form.id);
  });

  it('reads a permission prompt drawn without TERM, its cursor ">", and takes a quoted list for none (mechanics M121)', () => {
    const ascii = screen('permission').map((line) => line.replace('❯', '>'));
    const prompt = readPrompt(ascii)!;

    expect(prompt.options.map((option) => [option.key, option.selected])).toEqual([['1', true], ['2', false], ['3', false], ['4', false]]);
    expect(readPrompt(['● Steps:', '', '> 1. Build', '> 2. Test', ''])).toBeNull();
    // The cursor on the last option, with the help line cut off.
    expect(readPrompt([' Do you want to proceed?', '   1. Yes', ' > 2. No'])!.options).toEqual([{ key: '1', label: 'Yes', selected: false }, { key: '2', label: 'No', selected: true }]);
  });

  it('shows the checks of a multi-select question in its labels, and finds nothing once the form is answered', () => {
    expect(readPrompt(screen('multi-select'))!.options.map((option) => option.label)).toEqual(['[✔] Apple', '[ ] Pear', '[✔] Plum', 'Chat about this']);
    expect(readPrompt(screen('answered'))).toBeNull();
    expect(readPrompt(['Some text', '  1. a list item in a reply', '  2. another'])).toBeNull();
  });

  it('gives the same prompt the same id, and another screen another', () => {
    expect(readPrompt(screen('permission'))!.id).toBe(readPrompt([...screen('permission'), '', ''])!.id);
    expect(readPrompt(screen('permission').map((line) => line.replace('echo spike', 'echo other')))!.id).not.toBe(readPrompt(screen('permission'))!.id);
  });

  it('writes a digit, Escape or the right arrow', () => {
    expect([promptKeyData('2'), promptKeyData('escape'), promptKeyData('next')]).toEqual(['2', '\u001b', '\u001b[C']);
  });

  it("reads a snapshot's visible rows as plain text", async () => {
    expect((await screenRows({ data: 'one\r\n\u001b[1mtwo\u001b[0m', cols: 20, rows: 3 })).slice(0, 2)).toEqual(['one', 'two']);
  });
});

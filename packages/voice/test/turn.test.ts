import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeTurnText, pauseWait, TEXT_QUIET_MS, textWait, turnModel, turnPrompt } from '../src/turn.js';

describe('turn detection', () => {
  it('waits the pause, twice after a dangling word', () => {
    expect(pauseWait('fix the login flow', 3000)).toBe(3000);
    expect(pauseWait('fix it and', 3000)).toBe(6000);
    expect(pauseWait('instead,', 3000)).toBe(6000);
  });

  it('shortens the wait on a log scale with the model\'s score, and not at all for a dangling word or a low score', () => {
    expect(textWait('fix it and', 0.9, 0.011, 3000)).toBe(0);
    expect(textWait('Fix it.', 0.001, 0.011, 3000)).toBe(TEXT_QUIET_MS);
    expect(textWait('fix it', 0.005, 0.011, 3000)).toBe(0);
    expect(textWait('fix it', 0.011, 0.011, 3000)).toBe(3000);
    expect(textWait('fix it', 0.6, 0.011, 3000)).toBe(TEXT_QUIET_MS);
    expect(textWait('fix it', 0.17, 0.011, 3000)).toBeCloseTo(1200, -2);
    expect(textWait('fix it', 0.025, 0.011, 3000)).toBeCloseTo(2460, -1);
  });

  it('writes the model\'s prompt from the last six turns, normalised, joined by speaker and open at the end', () => {
    expect(normalizeTurnText("Don't   STOP, re-run it!")).toBe("don't stop re-run it");
    expect(
      turnPrompt([
        { role: 'assistant', content: 'Which port?' },
        { role: 'user', content: '...' },
        { role: 'user', content: 'Use 8799,' },
        { role: 'user', content: 'please' },
      ]),
    ).toBe('<|im_start|>assistant\nwhich port<|im_end|>\n<|im_start|>user\nuse 8799 please');
  });

  it('asks the model in a child process, with its threshold, and fails a request when the child stops; none without the model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-'));

    try {
      expect(turnModel(dir, join(dir, 'turn.js'), () => undefined)).toBeNull();
      mkdirSync(join(dir, 'onnx'));
      writeFileSync(join(dir, 'onnx', 'model_q8.onnx'), '');
      writeFileSync(join(dir, 'languages.json'), JSON.stringify({ en: { threshold: 0.02 } }));
      writeFileSync(
        join(dir, 'turn.js'),
        `require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => { const { id, chat } = JSON.parse(line); if (chat[0].content === 'die') process.exit(1); process.stdout.write(JSON.stringify(chat[0].content === 'bad' ? { id, error: 'no' } : { id, p: chat.length / 10 }) + '\\n'); });`,
      );

      const logs: string[] = [];
      const model = turnModel(dir, join(dir, 'turn.js'), (line) => logs.push(line))!;

      expect(model.threshold).toBe(0.02);
      expect(await model.probability([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }])).toBe(0.2);
      await expect(model.probability([{ role: 'user', content: 'bad' }])).rejects.toThrow('no');
      await expect(model.probability([{ role: 'user', content: 'die' }])).rejects.toThrow('The turn model stopped.');
      expect(await model.probability([{ role: 'user', content: 'again' }])).toBe(0.1);
      model.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

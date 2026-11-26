import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { turnModel } from '../src/turn.js';

describe('turn detection', () => {
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

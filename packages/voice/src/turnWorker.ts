import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { TURN_SESSION_OPTIONS, turnPrompt } from './turn.js';
import type { ChatTurn } from './turn.js';

/**
 * The turn model's process (architecture.md § Dictation): reads `{id, chat}` lines and answers `{id, p}`, the probability that the last user turn
 * is finished, or `{id, error}`. It loads onnxruntime and the model's tokenizer on the first request and exits when stdin closes.
 */
interface Ort {
  InferenceSession: { create(path: string, options: Record<string, unknown>): Promise<{ run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>> }> };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}

interface TokenizerModule {
  Tokenizer: new (tokenizer: unknown, config: unknown) => { encode(text: string, options: { add_special_tokens: boolean }): { ids: number[] } };
}

const modelDir = process.argv.find((arg) => arg.startsWith('--model='))?.slice('--model='.length) ?? '';
const load = (async () => {
  // The script's own folder, whose node_modules hold onnxruntime and the tokenizer.
  const require = createRequire(process.argv[1]!);
  const ort = require('onnxruntime-node') as Ort;
  const { Tokenizer } = require('@huggingface/tokenizers') as TokenizerModule;
  const tokenizer = new Tokenizer(JSON.parse(readFileSync(join(modelDir, 'tokenizer.json'), 'utf8')), JSON.parse(readFileSync(join(modelDir, 'tokenizer_config.json'), 'utf8')));
  const session = await ort.InferenceSession.create(join(modelDir, 'onnx', 'model_q8.onnx'), TURN_SESSION_OPTIONS);

  return { ort, tokenizer, session };
})();

load.catch(() => undefined);

async function probability(chat: ChatTurn[]): Promise<number> {
  const { ort, tokenizer, session } = await load;
  const ids = tokenizer.encode(turnPrompt(chat), { add_special_tokens: false }).ids.slice(-128);
  const output = await session.run({ input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]) });
  const data = Object.values(output)[0]!.data;

  return Number(data[data.length - 1]);
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    let id: unknown = null;

    void (async () => {
      try {
        const request = JSON.parse(line) as { id: number; chat: ChatTurn[] };

        id = request.id;
        process.stdout.write(`${JSON.stringify({ id, p: await probability(request.chat) })}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ id, error: (error as Error).message })}\n`);
      }
    })();
  })
  .on('close', () => process.exit(0));

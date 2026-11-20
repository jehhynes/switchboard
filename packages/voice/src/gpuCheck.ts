import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * The GPU check, run by the voice process in a child process before it loads sherpa-onnx's CUDA build (`sherpa.ts`): computes one speaker
 * embedding on CUDA from the build in `--pkg` with the model `--model` and prints "ok". sherpa-onnx prints "Failed to enable CUDA" and falls
 * back to the CPU when CUDA cannot load, which the parent reads from stderr; the check runs apart because a build, once loaded, stays.
 */
interface Extractor {
  createStream(): { acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void };
  compute(stream: unknown): Float32Array;
}

const option = (name: string): string => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';

try {
  const sherpa = createRequire(join(option('pkg'), 'x.js'))('sherpa-onnx-node') as { SpeakerEmbeddingExtractor: new (config: Record<string, unknown>) => Extractor };
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: option('model'), numThreads: 1, debug: false, provider: 'cuda' });
  const stream = extractor.createStream();
  const samples = new Float32Array(16_000).map((_, index) => 0.1 * Math.sin(index / 7));

  stream.acceptWaveform({ sampleRate: 16_000, samples });
  stream.inputFinished();
  process.stdout.write(extractor.compute(stream).length > 0 ? 'ok\n' : 'no embedding\n');
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}

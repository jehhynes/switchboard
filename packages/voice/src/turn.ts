import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * Turn detection (architecture.md § Dictation), from claude-collab's `wrapper.js`, `turn-text.js` and `turn-detect.js`: LiveKit's text turn model
 * judges whether the words so far are a finished turn, given the session's last reply. Finished and no dangling last word closes the message after
 * a short quiet; otherwise it waits out the end-of-message pause, `voice.endPauseMs`.
 */

/** The turn model, LiveKit's multilingual turn detector (a Qwen2.5-0.5B fine-tune, int8 ONNX), in `<voice home>/models`. */
export const TURN_MODEL = 'livekit-turn-detector';
/**
 * The turn model's onnxruntime session options. Its threads do not spin waiting for work after a run: spinning cost about 1 CPU-second after each
 * request, against 0.13 to 0.18 s without, with latency within its run-to-run spread of 40 to 80 ms (mechanics.md M166).
 */
export const TURN_SESSION_OPTIONS = {
  intraOpNumThreads: 4,
  interOpNumThreads: 1,
  extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } },
} as const;
/** A message judged finished, or ending in a sentence's mark, closes after this quiet. */
export const TEXT_QUIET_MS = 500;
/** The model's English threshold when its `languages.json` does not say. */
const DEFAULT_THRESHOLD = 0.011;

/**
 * A message that stops on a word like "and", "so", "uh" or "instead of" is rarely finished: in claude-collab's first test drive those pauses ran
 * 2 to 5 seconds before the speaker went on. Such a message waits twice the pause. Prepositions like "on" and "in" often end a finished sentence.
 */
export const DANGLING = /\b(and|or|but|so|uh|um|er|the|a|an|to|of|for|with|that|if|because|then|which|my|your|our|instead)[,]?$/i;

/** How long the words must stay quiet before the message closes, from the pause alone: twice the pause after a dangling word. */
export function pauseWait(words: string, endPauseMs: number): number {
  return DANGLING.test(words) ? 2 * endPauseMs : endPauseMs;
}

/**
 * The quiet the model's judgement earns, or 0 when it earns no early close: a dangling last word earns none; a sentence's mark at the end closes
 * after `TEXT_QUIET_MS` whatever the score, since the recogniser punctuates; a score under the threshold earns none; and between, the wait falls
 * on a log scale from the whole pause at the threshold to `TEXT_QUIET_MS` at 0.5 or more (0.17 about 1.2 s, 0.07 about 1.8 s, 0.025 about 2.5 s
 * with a 3 s pause).
 */
export function textWait(words: string, p: number, threshold: number, endPauseMs: number): number {
  if (DANGLING.test(words)) {
    return 0;
  }

  if (/[.?!]$/.test(words)) {
    return TEXT_QUIET_MS;
  }

  if (p < threshold) {
    return 0;
  }

  const low = Math.log10(threshold);
  const high = Math.log10(0.5);
  const share = Math.min(1, Math.max(0, (Math.log10(p) - low) / (high - low)));

  return Math.round(endPauseMs - share * (endPauseMs - TEXT_QUIET_MS));
}

/** A chat turn as the model reads it: the session's last reply, then the operator's words so far. */
export interface ChatTurn {
  role: 'assistant' | 'user';
  content: string;
}

export interface TurnModel {
  readonly threshold: number;
  /** The probability that the last user turn is finished. */
  probability(chat: ChatTurn[]): Promise<number>;
  close(): void;
}

/**
 * The turn model in a child process, `turn.js` beside the voice process's script: onnxruntime cannot load in the process where sherpa-onnx loaded
 * its own runtime (claude-collab `turn-detect-worker.js`). Null without the model, and the pause alone decides.
 */
export function turnModel(modelDir: string, workerScript: string, log: (line: string) => void): TurnModel | null {
  if (!existsSync(join(modelDir, 'onnx', 'model_q8.onnx')) || !existsSync(workerScript)) {
    return null;
  }

  let threshold = DEFAULT_THRESHOLD;

  try {
    const read = (JSON.parse(readFileSync(join(modelDir, 'languages.json'), 'utf8')) as { en?: { threshold?: unknown } }).en?.threshold;

    threshold = typeof read === 'number' ? read : DEFAULT_THRESHOLD;
  } catch {
    // The default.
  }

  type Pending = Map<number, { resolve(p: number): void; reject(error: Error): void }>;
  let worker: { child: ChildProcess; pending: Pending } | null = null;
  let next = 0;
  // Each child answers and fails only its own requests, and clears `worker` only while it is still the one: a closed child's exit comes
  // after a request may have started its replacement.
  const start = (): { child: ChildProcess; pending: Pending } => {
    const child = spawn(process.execPath, [workerScript, `--model=${modelDir}`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const pending: Pending = new Map();
    const mine = { child, pending };

    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        const answer = JSON.parse(line) as { id: number; p?: number; error?: string };
        const waiting = pending.get(answer.id);

        pending.delete(answer.id);

        if (typeof answer.p === 'number') {
          waiting?.resolve(answer.p);
        } else {
          waiting?.reject(new Error(answer.error ?? 'The turn model did not answer.'));
        }
      } catch {
        log(`turn model: ${line}`);
      }
    });
    child.stderr!.on('data', (data: Buffer) => log(`turn model: ${data.toString('utf8').trim()}`));
    child.on('error', () => undefined);
    child.on('exit', () => {
      if (worker === mine) {
        worker = null;
      }

      for (const waiting of pending.values()) {
        waiting.reject(new Error('The turn model stopped.'));
      }

      pending.clear();
    });

    return mine;
  };

  return {
    threshold,
    probability: (chat) =>
      new Promise((resolve, reject) => {
        worker ??= start();

        const id = next++;

        worker.pending.set(id, { resolve, reject });
        worker.child.stdin!.write(`${JSON.stringify({ id, chat })}\n`);
      }),
    close: () => {
      worker?.child.kill();
      worker = null;
    },
  };
}

/** The model's text normalisation (livekit-plugins-turn-detector `base.py`): lower case, NFKC, punctuation dropped but apostrophes and hyphens. */
export function normalizeTurnText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\p{P}]/gu, (char) => (char === "'" || char === '-' ? char : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The model's input text: the last six turns, normalised, a speaker's consecutive turns joined, in its chat template (`<|im_start|>role\n…<|im_end|>\n`)
 * without the last turn's end, so the model judges whether that turn ends there.
 */
export function turnPrompt(chat: ChatTurn[]): string {
  const turns: ChatTurn[] = [];

  for (const turn of chat.slice(-6)) {
    const content = normalizeTurnText(turn.content);

    if (content === '') {
      continue;
    }

    const last = turns.at(-1);

    if (last?.role === turn.role) {
      last.content += ` ${content}`;
    } else {
      turns.push({ role: turn.role, content });
    }
  }

  const text = turns.map((turn) => `<|im_start|>${turn.role}\n${turn.content}<|im_end|>\n`).join('');
  const end = text.lastIndexOf('<|im_end|>');

  return end === -1 ? text : text.slice(0, end);
}

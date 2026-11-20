import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@switchboard/core/settings';
import type { VoiceSettings } from '@switchboard/core/settings';
import { PHRASE_SILENCE_MS } from '../src/asr.js';
import { Dictation } from '../src/dictation.js';
import type { VoiceMessage } from '../src/protocol.js';
import type { ChatTurn } from '../src/turn.js';
import { Clock, FakeCapture, FakeEngine, settle } from './fakes.js';

type Sent = Extract<VoiceMessage, { type: 'words' | 'piece' | 'utterance' }>;

function setup(options: { turn?: (chat: ChatTurn[]) => number; watcher?: 'none' | 'manual'; recognizer?: { error: string }; settings?: Partial<VoiceSettings> } = {}) {
  const clock = new Clock();
  const capture = new FakeCapture();
  const engine = new FakeEngine();
  const sent: Sent[] = [];
  const logs: string[] = [];
  const chats: ChatTurn[][] = [];
  const termsAsked: Array<string | null> = [];
  const loads: string[][] = [];
  const used: string[] = [];
  let spoke = 0;
  let changed = 0;
  let id = 0;
  const watch: { changed: ((busy: boolean, apps: string[]) => void) | null; failed: (() => void) | null; closed: number } = { changed: null, failed: null, closed: 0 };
  const settings: VoiceSettings = { ...DEFAULT_SETTINGS.voice, enabled: true, ...options.settings };
  const dictation = new Dictation({
    capture,
    recognizer: (terms) => {
      loads.push(terms);
      return options.recognizer ?? engine;
    },
    vocabulary: {
      terms: (repo) => {
        termsAsked.push(repo);
        return repo === null ? ['Switchboard'] : ['Switchboard', repo];
      },
      used: (text) => used.push(text),
    },
    turn:
      options.turn === undefined
        ? null
        : {
            threshold: 0.011,
            probability: async (chat) => {
              chats.push(chat);
              return options.turn!(chat);
            },
            close: () => undefined,
          },
    watchMicUse: (onChanged, onFailed) => {
      if (options.watcher === 'none') {
        return null;
      }

      watch.changed = onChanged;
      watch.failed = onFailed;
      return { close: () => void watch.closed++ };
    },
    settings: () => settings,
    send: (message) => sent.push(message),
    changed: () => void changed++,
    spoke: () => void spoke++,
    newId: () => `id${++id}`,
    now: clock.now,
    log: (line) => logs.push(line),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    every: clock.every,
  });
  /** Says `text` (the recogniser's whole text so far) and lets `ms` of audio pass, 100 ms at a time. */
  const say = (text: string, ms = 100): void => {
    engine.text = text;

    for (let at = 0; at < ms; at += 100) {
      capture.pcm(100);
      clock.advance(100);
    }
  };
  const quiet = (ms: number): void => say(engine.text, ms);
  /** Mic on with the watcher saying no other app records, and a target. */
  const listening = async (): Promise<void> => {
    dictation.target(1, 's1', 'acme/app');
    dictation.mic(true);
    watch.changed?.(false, []);
    await settle();
  };

  return { clock, capture, engine, sent, logs, chats, termsAsked, loads, used, watch, settings, dictation, say, quiet, listening, spoke: () => spoke, changed: () => changed };
}

const kinds = (sent: Sent[]): string[] => sent.map((one) => (one.type === 'words' ? `words "${one.text}"` : one.type === 'piece' ? `piece "${one.text}"` : `utterance "${one.text}" ${one.final ? 'final' : 'cut'}`));

describe('Dictation', () => {
  it('captures only once the watcher says no other app records, and loads the recogniser with the target repository\'s terms', async () => {
    const { capture, dictation, watch, termsAsked, loads } = setup();

    expect(dictation.state).toBe('off');
    dictation.target(1, 's1', 'acme/app');
    dictation.mic(true);
    await settle();
    expect(capture.opens).toBe(0);
    expect(dictation.state).toBe('starting');
    watch.changed!(false, []);
    await settle();
    expect(capture.opens).toBe(1);
    expect(capture.devices).toEqual([null]);
    expect(termsAsked).toEqual(['acme/app']);
    expect(loads).toEqual([['Switchboard', 'acme/app']]);
    expect(dictation.state).toBe('listening');
  });

  it('turns live words into pieces after their pause and ends the utterance after the end-of-message pause, as final', async () => {
    const { dictation, say, quiet, sent, used, listening, spoke } = setup();

    await listening();
    say('fix the login', 300);
    expect(dictation.state).toBe('hearing');
    expect(kinds(sent)).toEqual(['words "fix the login"']);
    expect(sent[0]).toMatchObject({ gen: 1, sessionId: 's1', utteranceId: 'id1' });
    expect(spoke()).toBeGreaterThan(0);
    quiet(PHRASE_SILENCE_MS);
    expect(kinds(sent)).toEqual(['words "fix the login"', 'piece "fix the login"', 'words ""']);
    expect(used).toEqual(['fix the login']);
    say('fix the login flow', 100);
    quiet(2_000);
    expect(kinds(sent).slice(3)).toEqual(['words "flow"', 'piece "flow"', 'words ""']);
    // 3 s of quiet since the words last grew ends it.
    quiet(900);
    expect(kinds(sent).slice(6)).toEqual(['utterance "fix the login flow" final']);
    expect(dictation.state).toBe('listening');
  });

  it('closes after the short wait the turn model earned, waits twice the pause after a dangling word, and reads the session\'s last reply', async () => {
    const finished = setup({ turn: () => 0.6 });

    await finished.listening();
    finished.dictation.context('s1', 'Which port, 8765 or 8799?');
    finished.say('use 8799', 100);
    finished.quiet(400);
    await settle();
    expect(finished.chats).toEqual([[{ role: 'assistant', content: 'Which port, 8765 or 8799?' }, { role: 'user', content: 'use 8799' }]]);
    finished.quiet(200);
    expect(kinds(finished.sent).at(-1)).toBe('utterance "use 8799" final');

    const dangling = setup({ turn: () => 0.9 });

    await dangling.listening();
    dangling.say('fix it and', 100);
    dangling.quiet(5_500);
    expect(dangling.sent.some((one) => one.type === 'utterance')).toBe(false);
    dangling.quiet(600);
    expect(kinds(dangling.sent).at(-1)).toBe('utterance "fix it and" final');
  });

  it('reports an utterance cut by another app\'s recording even before its first piece settled', async () => {
    const { dictation, say, sent, watch, listening } = setup();

    await listening();
    say('fix the', 200);
    watch.changed!(true, ['teams']);
    expect(kinds(sent)).toEqual(['words "fix the"', 'words ""', 'utterance "" cut']);
    expect(dictation.state).toBe('paused-other-app');
  });

  it('finishes the words in flight when the composer takes the focus, reports the utterance cut, and listens again when it leaves', async () => {
    const { dictation, engine, say, sent, capture, listening } = setup();

    await listening();
    say('rename the', 200);
    engine.held = 'button';
    dictation.typing(true);
    expect(kinds(sent)).toEqual(['words "rename the"', 'piece "rename the button"', 'words ""', 'utterance "rename the button" cut']);
    expect(dictation.state).toBe('typing');
    expect(capture.stream!.stopped).toBe(true);
    dictation.typing(false);
    await settle();
    expect(capture.opens).toBe(2);
    expect(dictation.state).toBe('listening');
  });

  it('drops what it was hearing when another app records, sends no end, and resumes only when that app stops', async () => {
    const { dictation, say, quiet, sent, capture, watch, logs, listening } = setup();

    await listening();
    say('first part', 100);
    quiet(PHRASE_SILENCE_MS);
    say('first part and the rest', 300);
    watch.changed!(true, ['Teams']);
    expect(kinds(sent)).toEqual(['words "first part"', 'piece "first part"', 'words ""', 'words "and the rest"', 'words ""', 'utterance "first part" cut']);
    expect(dictation.state).toBe('paused-other-app');
    expect(capture.stream!.stopped).toBe(true);
    expect(logs).toContain('listening paused: Teams is recording');
    quiet(10_000);
    expect(sent).toHaveLength(6);
    watch.changed!(false, []);
    await settle();
    expect(dictation.state).toBe('listening');
    expect(capture.opens).toBe(2);
  });

  it('closes an utterance open at a voice move as cut under its own generation, and stops listening with no target', async () => {
    const { dictation, say, sent, listening, capture, loads } = setup();

    await listening();
    say('about the', 200);
    dictation.target(2, 's2', 'acme/app');
    expect(kinds(sent).slice(-2)).toEqual(['words ""', 'utterance "about the" cut']);
    expect(sent.at(-1)).toMatchObject({ gen: 1, sessionId: 's1' });
    // The same terms keep the recogniser.
    expect(loads).toHaveLength(1);
    dictation.target(3, 's3', 'acme/other');
    expect(loads).toHaveLength(2);
    dictation.target(4, null, null);
    expect(dictation.state).toBe('idle-off');
    expect(capture.stream!.stopped).toBe(true);
  });

  it('stops capture after the mic idle timeout, until the mic is turned on again; 0 never stops it', async () => {
    const idle = setup({ settings: { micIdleMinutes: 1 } });

    await idle.listening();
    idle.clock.advance(59_000);
    idle.say('still here', 100);
    idle.quiet(4_000);
    // A minute from the last words, not from the utterance's end.
    idle.clock.advance(55_000);
    expect(idle.dictation.state).toBe('listening');
    idle.clock.advance(1_000);
    expect(idle.dictation.state).toBe('idle-off');
    expect(idle.capture.stream!.stopped).toBe(true);
    idle.dictation.mic(true);
    await settle();
    expect(idle.dictation.state).toBe('listening');

    const never = setup({ settings: { micIdleMinutes: 0 } });

    await never.listening();
    never.clock.advance(24 * 60 * 60_000);
    expect(never.dictation.state).toBe('listening');
  });

  it('says why when recognition or the device cannot run, and tries again when the mic is turned on', async () => {
    const missing = setup({ recognizer: { error: 'No speech recognition model in m.' } });

    await missing.listening();
    expect(missing.dictation.state).toBe('unavailable');
    expect(missing.dictation.error).toBe('No speech recognition model in m.');
    expect(missing.capture.opens).toBe(0);

    const broken = setup();

    broken.capture.fail = new Error('no device');
    await broken.listening();
    expect(broken.dictation.state).toBe('unavailable');
    expect(broken.dictation.error).toBe('The microphone failed: no device');
    broken.capture.fail = null;
    broken.dictation.mic(true);
    await settle();
    expect(broken.dictation.state).toBe('listening');
    broken.say('hello', 200);
    broken.capture.stream!.onError(new Error('device removed'));
    expect(broken.dictation.error).toBe('The microphone failed: device removed');
    // What was heard before the failure stays in the draft, unsent.
    expect(kinds(broken.sent).slice(-3)).toEqual(['piece "hello"', 'words ""', 'utterance "hello" cut']);
  });

  it('loads the recogniser again at each attempt to listen, so a model put back needs no restart', async () => {
    const options: { recognizer?: { error: string } } = { recognizer: { error: 'No speech recognition model in m.' } };
    const missing = setup(options);

    await missing.listening();
    expect(missing.dictation.state).toBe('unavailable');
    missing.dictation.typing(true);
    missing.dictation.typing(false);
    await settle();
    expect(missing.dictation.state).toBe('unavailable');
    expect(missing.loads.length).toBe(2);
    expect(missing.logs.filter((line) => line.startsWith('No speech recognition model'))).toHaveLength(1);
    delete options.recognizer;
    missing.dictation.typing(true);
    missing.dictation.typing(false);
    await settle();
    expect(missing.dictation.state).toBe('listening');
    expect(missing.dictation.error).toBeNull();
    expect(missing.capture.opens).toBe(1);

    const turnedOn = setup(options);

    options.recognizer = { error: 'No speech recognition model in m.' };
    await turnedOn.listening();
    delete options.recognizer;
    turnedOn.dictation.mic(true);
    await settle();
    expect(turnedOn.dictation.state).toBe('listening');
  });

  it('listens with no watcher where nothing can watch, or once the watcher fails, and stops it with the mic', async () => {
    const none = setup({ watcher: 'none' });

    none.dictation.target(1, 's1', null);
    none.dictation.mic(true);
    await settle();
    expect(none.dictation.state).toBe('listening');

    const failing = setup();

    failing.dictation.target(1, 's1', null);
    failing.dictation.mic(true);
    failing.watch.failed!();
    await settle();
    expect(failing.dictation.state).toBe('listening');
    failing.dictation.mic(false);
    expect(failing.watch.closed).toBe(1);
    expect(failing.dictation.state).toBe('off');
    expect(failing.capture.stream!.stopped).toBe(true);
  });

  it('passes the audio played to the open capture as the echo canceller\'s reference', async () => {
    const { dictation, capture, listening } = setup();

    dictation.reference(Buffer.alloc(4));
    await listening();
    dictation.reference(Buffer.alloc(8));
    expect(capture.references.map((one) => one.length)).toEqual([8]);
    dictation.close();
    expect(capture.stream!.stopped).toBe(true);
  });
});

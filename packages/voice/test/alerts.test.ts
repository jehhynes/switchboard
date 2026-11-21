import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@switchboard/core/settings';
import type { VoiceSettings } from '@switchboard/core/settings';
import { ALERT_GAP_MS, ALERT_TICK_MS, ANSWER_GRACE_MS, Alerts, alertLine, declines } from '../src/alerts.js';
import type { Alert } from '../src/alerts.js';
import type { SpeechState, VoiceMessage } from '../src/protocol.js';
import { Clock } from './fakes.js';

const AS = { voice: 'cedar', style: 'none', personality: null } as const;

const alert = (alertId: string, sessionId = 's2', more: Partial<Alert> = {}): Alert => ({ alertId, sessionId, cause: 'turn-finished', title: 'Fix the badge', persona: 'Tinker', detail: 'The badge shows the count again.', as: AS, ...more });

function setup(options: { settings?: Partial<VoiceSettings>; answerable?: boolean; targets?: string[] } = {}) {
  const clock = new Clock();
  const said: Array<{ id: string; text: string; done: (state: SpeechState) => void }> = [];
  const unsaid: string[] = [];
  const sent: Array<Extract<VoiceMessage, { type: 'alert-done' }>> = [];
  const logs: string[] = [];
  const calls: string[] = [];
  const state = { quiet: true, playedUntil: -Infinity, hearing: false, wait: null as string | null, answerable: options.answerable ?? true, inFocus: new Set<string>(), targets: new Set(options.targets ?? ['s2']) };
  let answer: ((text: string | null, cut: boolean) => void) | null = null;
  const settings: VoiceSettings = { ...DEFAULT_SETTINGS.voice, enabled: true, operatorName: 'Alex', ...options.settings };
  const alerts = new Alerts({
    say: (id, text, as, done) => {
      expect(as).toEqual(AS);
      said.push({ id, text, done });
    },
    unsay: (id) => unsaid.push(id),
    quiet: () => state.quiet,
    playedUntil: () => state.playedUntil,
    hearing: () => state.hearing,
    waitReason: () => state.wait,
    answerable: () => state.answerable,
    listen: (given, accepted) => {
      answer = given;
      calls.push(given === null ? `listen off${accepted === true ? ' accepted' : ''}` : 'listen');
    },
    talkHere: (sessionId) => {
      calls.push(`talk here ${sessionId}`);
      return state.targets.has(sessionId);
    },
    inFocus: (sessionId) => state.inFocus.has(sessionId),
    settings: () => settings,
    send: (message) => sent.push(message),
    now: clock.now,
    log: (line) => logs.push(line),
    every: clock.every,
  });
  const outcomes = (): string[] => sent.map((one) => `${one.alertId} ${one.outcome}`);

  return { clock, said, unsaid, sent, logs, calls, state, alerts, settings, outcomes, answer: (text: string | null, cut = false) => answer!(text, cut), listening: () => answer !== null };
}

describe('alertLine', () => {
  it('calls the operator by the name in the settings, then says who needs them and why, by the persona when there is one', () => {
    expect(alertLine({ cause: 'turn-finished', title: 'Fix the badge', persona: 'Tinker' }, 'Alex')).toBe('Hey Alex? Tinker finished Fix the badge.');
    expect(alertLine({ cause: 'turn-finished', title: 'Fix the badge', persona: null }, 'Ann')).toBe('Hey Ann? Fix the badge finished.');
    expect(alertLine({ cause: 'question', title: 'Fix the badge', persona: 'Tinker' }, 'Alex')).toBe('Hey Alex? Tinker has a question on Fix the badge.');
    expect(alertLine({ cause: 'question', title: 'Fix the badge', persona: null }, 'Alex')).toBe('Hey Alex? Fix the badge has a question.');
    expect(alertLine({ cause: 'permission', title: 'Fix the badge', persona: 'Tinker' }, 'Alex')).toBe('Hey Alex? Tinker needs your permission on Fix the badge.');
    expect(alertLine({ cause: 'permission', title: 'Fix the badge', persona: ' ' }, ' ')).toBe('Hey? Fix the badge needs your permission.');
  });

  it('cuts a long title at a word', () => {
    const title = 'Show the unread count on the dock row and in the window title when replies arrive while away';

    expect(alertLine({ cause: 'turn-finished', title, persona: null }, 'Alex')).toBe('Hey Alex? Show the unread count on the dock row and in the window finished.');
  });
});

describe('declines', () => {
  it('reads a whole refusal as one, whatever its case and punctuation, and anything else as an answer', () => {
    expect(['No.', 'nope', 'Not now!', 'later', 'Skip it', 'never mind', 'Stop.'].every(declines)).toBe(true);
    expect(['yes', 'go ahead', 'tell me', 'no problem, go ahead', 'sure'].some(declines)).toBe(false);
  });
});

describe('Alerts', () => {
  it('says the first line, listens for an answer, moves the voice on one and reads the detail', () => {
    const t = setup();

    t.alerts.add(alert('a1'));
    expect(t.said.map((one) => [one.id, one.text])).toEqual([['alert:a1', 'Hey Alex? Tinker finished Fix the badge.']]);
    expect(t.calls).toEqual(['listen']);
    expect(t.alerts.active).toEqual({ alertId: 'a1', phase: 'prompting' });
    t.said[0]!.done('played');
    expect(t.alerts.active).toEqual({ alertId: 'a1', phase: 'awaiting' });

    t.clock.advance(4_000);
    t.answer('yes');
    expect(t.calls).toEqual(['listen', 'listen off accepted', 'talk here s2']);
    expect(t.said[1]).toMatchObject({ id: 'alert:a1:detail', text: 'The badge shows the count again.' });
    expect(t.alerts.active).toEqual({ alertId: 'a1', phase: 'announcing' });
    expect(t.sent).toEqual([]);
    t.said[1]!.done('played');
    expect(t.sent).toEqual([{ type: 'alert-done', alertId: 'a1', sessionId: 's2', outcome: 'announced' }]);
    expect(t.logs).toContain('alert a1 answered "yes": the voice moves to its session');
    expect(t.alerts.active).toBeNull();
  });

  it('reads the detail but leaves the voice where it is when the session cannot be a voice target', () => {
    const t = setup({ targets: [] });

    t.alerts.add(alert('a1'));
    t.said[0]!.done('played');
    t.answer('go ahead');
    t.said[1]!.done('played');
    expect(t.outcomes()).toEqual(['a1 announced']);
    expect(t.logs).toContain('alert a1 answered "go ahead": its session cannot be the voice target, so the voice stays');
  });

  it('ends unanswered after voice.alertAnswerSeconds of silence, and waits for an answer still being spoken up to a grace', () => {
    const t = setup({ settings: { alertAnswerSeconds: 5 } });

    t.alerts.add(alert('a1'));
    t.clock.advance(3_000);
    t.said[0]!.done('played');
    t.clock.advance(5_000 - ALERT_TICK_MS);
    expect(t.sent).toEqual([]);
    t.clock.advance(ALERT_TICK_MS);
    expect(t.outcomes()).toEqual(['a1 unanswered']);
    expect(t.calls).toEqual(['listen', 'listen off']);

    t.alerts.add(alert('a2'));
    t.clock.advance(ALERT_GAP_MS);
    t.said[1]!.done('played');
    t.clock.advance(4_000);
    t.state.hearing = true;
    t.clock.advance(5_000);
    expect(t.outcomes()).toEqual(['a1 unanswered']);
    t.clock.advance(ANSWER_GRACE_MS);
    expect(t.outcomes()).toEqual(['a1 unanswered', 'a2 unanswered']);
  });

  it('drops the alert on a refusal or an answer that kept no words, and reads nothing', () => {
    const t = setup();

    t.alerts.add(alert('a1'));
    t.said[0]!.done('played');
    t.answer('Not now.');
    t.alerts.add(alert('a2', 's3'));
    t.clock.advance(ALERT_GAP_MS);
    t.said[1]!.done('played');
    t.answer(null);
    expect(t.outcomes()).toEqual(['a1 declined', 'a2 unanswered']);
    expect(t.said.map((one) => one.id)).toEqual(['alert:a1', 'alert:a2']);
    expect(t.calls.filter((call) => call.startsWith('talk here'))).toEqual([]);
  });

  it('says the line but listens for nothing when no answer can be heard, as with the mic off, and ends it unanswered', () => {
    const t = setup({ answerable: false });

    t.alerts.add(alert('a1'));
    expect(t.listening()).toBe(false);
    t.said[0]!.done('played');
    expect(t.outcomes()).toEqual(['a1 unanswered']);
    expect(t.calls).toEqual([]);
    expect(t.logs[0]).toBe('alert a1 for session s2 (turn-finished): "Hey Alex? Tinker finished Fix the badge.", with no answer: the mic is not listening');
  });

  it('ends a handshake whose mic stops listening, as when the mic is turned off or another app records, also mid-answer', () => {
    const t = setup();

    t.alerts.add(alert('a1'));
    t.said[0]!.done('played');
    t.state.answerable = false;
    t.clock.advance(ALERT_TICK_MS);
    expect(t.outcomes()).toEqual(['a1 cancelled']);
    expect(t.calls).toEqual(['listen', 'listen off']);

    t.state.answerable = true;
    t.alerts.add(alert('a2'));
    t.clock.advance(ALERT_GAP_MS);
    t.said[1]!.done('played');
    t.answer(null, true);
    expect(t.outcomes()).toEqual(['a1 cancelled', 'a2 cancelled']);
    expect(t.logs).toContain('alert a2 for session s2 cancelled: its answer was cut off');
  });

  it('plays one at a time, each waiting for quiet, no speech, nothing holding alerts and a gap after the voice last played', () => {
    const t = setup();

    t.state.quiet = false;
    t.alerts.add(alert('a1'));
    t.alerts.add(alert('a2', 's3'));
    expect(t.said).toEqual([]);
    expect(t.alerts.pending).toEqual(['a1', 'a2']);
    t.state.quiet = true;
    t.state.hearing = true;
    t.clock.advance(ALERT_TICK_MS);
    t.state.hearing = false;
    t.state.wait = 'room hold';
    t.clock.advance(ALERT_TICK_MS);
    t.state.wait = null;
    t.state.playedUntil = t.clock.t;
    t.clock.advance(ALERT_TICK_MS);
    expect(t.said).toEqual([]);
    t.clock.advance(ALERT_GAP_MS);
    expect(t.said.map((one) => one.id)).toEqual(['alert:a1']);

    // The second waits for the first to end.
    t.said[0]!.done('played');
    t.clock.advance(ALERT_TICK_MS);
    expect(t.said).toHaveLength(1);
    t.answer(null);
    t.clock.advance(ALERT_TICK_MS);
    expect(t.said.map((one) => one.text)).toEqual(['Hey Alex? Tinker finished Fix the badge.', 'Hey Alex? Tinker finished Fix the badge.']);
    expect(t.said[1]!.id).toBe('alert:a2');
  });

  it('drops an alert whose conversation is in focus or the voice target, before it plays or during its handshake', () => {
    const t = setup();

    t.state.inFocus.add('s2');
    t.alerts.add(alert('a1'));
    t.state.quiet = false;
    t.state.inFocus.clear();
    t.alerts.add(alert('a2'));
    t.state.inFocus.add('s2');
    t.clock.advance(ALERT_TICK_MS);
    t.state.inFocus.clear();
    t.state.quiet = true;
    t.alerts.add(alert('a3'));
    t.state.inFocus.add('s2');
    t.clock.advance(ALERT_TICK_MS);
    expect(t.outcomes()).toEqual(['a1 cancelled', 'a2 cancelled', 'a3 cancelled']);
    expect(t.unsaid).toEqual(['alert:a3']);
    expect(t.calls).toEqual(['listen', 'listen off']);
  });

  it('cancels by ID, replaces an earlier alert of the same session, and keeps one being read', () => {
    const t = setup();

    t.state.quiet = false;
    t.alerts.add(alert('a1'));
    t.alerts.add(alert('a2', 's3'));
    t.alerts.add(alert('a3', 's2', { cause: 'question' }));
    t.alerts.cancel('a2');
    expect(t.outcomes()).toEqual(['a1 cancelled', 'a2 cancelled']);
    expect(t.alerts.pending).toEqual(['a3']);
    t.state.quiet = true;
    t.clock.advance(ALERT_TICK_MS);
    expect(t.said[0]!.text).toBe('Hey Alex? Tinker has a question on Fix the badge.');

    // A newer alert of the playing one's session replaces it.
    t.alerts.add(alert('a4', 's2', { cause: 'permission' }));
    expect(t.outcomes().at(-1)).toBe('a3 cancelled');
    expect(t.unsaid).toEqual(['alert:a3']);
    expect(t.said[1]!.text).toBe('Hey Alex? Tinker needs your permission on Fix the badge.');
    t.said[1]!.done('played');
    t.answer('tell me');
    t.alerts.cancel('a4');
    t.alerts.add(alert('a5'));
    expect(t.alerts.active).toEqual({ alertId: 'a4', phase: 'announcing' });
    t.said[2]!.done('played');
    expect(t.outcomes().slice(-1)).toEqual(['a4 announced']);
  });

  it('ends an alert whose line was stopped, as by Stop speaking, and drops every alert when alerts are turned off or all cancelled', () => {
    const t = setup();

    t.alerts.add(alert('a1'));
    t.said[0]!.done('interrupted');
    expect(t.outcomes()).toEqual(['a1 cancelled']);
    expect(t.logs).toContain('alert a1 for session s2 cancelled: its line was interrupted');

    t.state.quiet = false;
    t.alerts.add(alert('a2'));
    t.settings.spokenAlerts = false;
    t.clock.advance(ALERT_TICK_MS);
    t.alerts.add(alert('a3', 's3'));
    t.settings.spokenAlerts = true;
    t.alerts.add(alert('a4', 's4'));
    t.alerts.cancelAll('computer locked');
    expect(t.outcomes()).toEqual(['a1 cancelled', 'a2 cancelled', 'a3 cancelled', 'a4 cancelled']);
    expect(t.logs.at(-1)).toBe('alert a4 for session s4 cancelled: computer locked');

    // Turned off while its detail is read, the detail stops.
    t.state.quiet = true;
    t.alerts.add(alert('a5'));
    t.clock.advance(ALERT_GAP_MS);
    t.said.at(-1)!.done('played');
    t.answer('yes');
    expect(t.said.at(-1)!.id).toBe('alert:a5:detail');
    t.alerts.cancelAll('spoken alerts are off');
    expect(t.unsaid.at(-1)).toBe('alert:a5:detail');
    expect(t.outcomes().at(-1)).toBe('a5 cancelled');
  });
});

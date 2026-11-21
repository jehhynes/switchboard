import type { VoiceSettings } from '@switchboard/core/settings';
import type { AlertCause, AlertOutcome, SpeechState, VoiceMessage } from './protocol.js';
import type { SpeechVoice } from './tts.js';

/** How often a waiting alert checks whether it may play, and an answer window whether it ended. */
export const ALERT_TICK_MS = 250;
/** The quiet an alert waits for after the voice last played, so it never follows a reply without a pause. */
export const ALERT_GAP_MS = 1_000;
/** How long an answer begun within `voice.alertAnswerSeconds` may go on before the window closes anyway. */
export const ANSWER_GRACE_MS = 20_000;
/** A title longer than this is cut at a word when spoken. */
const TITLE_MAX = 60;

/** Whole answers that refuse an alert; anything else said in the window accepts it. */
const DECLINES = new Set(['no', 'nope', 'no thanks', 'no thank you', 'not now', 'not yet', 'later', 'skip', 'skip it', 'never mind', 'nevermind', 'stop']);

/** A spoken alert as the hub sends it, with the voice to speak it in. */
export interface Alert {
  alertId: string;
  sessionId: string;
  cause: AlertCause;
  title: string;
  persona: string | null;
  detail: string;
  as: SpeechVoice;
}

export interface AlertsDeps {
  /** Speaks a line in the speech queue, after what plays or waits; `done` gets what became of it. */
  say(id: string, text: string, as: SpeechVoice, done: (state: SpeechState) => void): void;
  /** Stops or drops a line said earlier. */
  unsay(id: string): void;
  /** Nothing plays or waits to play. */
  quiet(): boolean;
  /** When the voice last stopped playing (`Speech.playedUntil`). */
  playedUntil(): number;
  /** The operator is speaking. */
  hearing(): boolean;
  /** Why alerts wait now, such as a room hold or another app recording; null when they may play. */
  waitReason(): string | null;
  /** Whether an answer can be heard (`Dictation.answerable`). */
  answerable(): boolean;
  /** Listens for an answer, or stops listening (`Dictation.listen`); `cut` marks an answer cut off before turn detection ended it. */
  listen(answer: ((text: string | null, cut: boolean) => void) | null, accepted?: boolean): void;
  /** Moves the voice target to the session; false when it cannot be a target. */
  talkHere(sessionId: string): boolean;
  /** The session is the voice target or the focused conversation, so it needs no alert. */
  inFocus(sessionId: string): boolean;
  settings(): VoiceSettings;
  send(message: Extract<VoiceMessage, { type: 'alert-done' }>): void;
  now(): number;
  log(line: string): void;
  every?(run: () => void, ms: number): { stop(): void };
}

interface Active {
  alert: Alert;
  /** Saying the first line, waiting for an answer, or reading the detail after one. */
  phase: 'prompting' | 'awaiting' | 'announcing';
  /** Dictation listens for its answer. */
  listening: boolean;
  /** When the answer window closes, once the first line played. */
  deadline: number | null;
}

/** A title cut at a word to `TITLE_MAX` characters for speech. */
function spokenTitle(title: string): string {
  const text = title.trim().replace(/\s+/g, ' ');

  if (text.length <= TITLE_MAX) {
    return text;
  }

  const cut = text.slice(0, TITLE_MAX + 1);
  const space = cut.lastIndexOf(' ');

  return space > TITLE_MAX / 2 ? cut.slice(0, space) : text.slice(0, TITLE_MAX);
}

/**
 * An alert's first line (architecture.md § Spoken alerts): "Hey <name>?" with the operator's name from `voice.operatorName`, then who needs
 * them and why, by the persona's name when the session has one, such as "Hey Alex? Tinker finished Fix the badge."
 */
export function alertLine(alert: Pick<Alert, 'cause' | 'title' | 'persona'>, operatorName: string): string {
  const name = operatorName.trim();
  const title = spokenTitle(alert.title) || 'a session';
  const persona = alert.persona?.trim() || null;
  const what =
    alert.cause === 'turn-finished'
      ? persona === null
        ? `${title} finished.`
        : `${persona} finished ${title}.`
      : alert.cause === 'question'
        ? persona === null
          ? `${title} has a question.`
          : `${persona} has a question on ${title}.`
        : persona === null
          ? `${title} needs your permission.`
          : `${persona} needs your permission on ${title}.`;

  return `${name === '' ? 'Hey?' : `Hey ${name}?`} ${what}`;
}

/** Whether an answer refuses the alert: a whole utterance such as "no" or "not now". */
export function declines(text: string): boolean {
  return DECLINES.has(
    text
      .toLowerCase()
      .replace(/[^a-z ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/**
 * Spoken alerts in the voice process (architecture.md § Spoken alerts): one at a time, each waiting for a pause with nothing playing or waiting
 * to play, no speech, no room hold and no other app recording. Each says its first line, listens up to `voice.alertAnswerSeconds` for an answer
 * when an answer can be heard, and on an answer moves the voice to the session when it can and reads the alert's detail; a refusal, silence or
 * a cause resolved meanwhile ends it. It reports each end with `alert-done`.
 */
export class Alerts {
  readonly #pending: Alert[] = [];
  #active: Active | null = null;
  #ticker: { stop(): void } | null = null;

  constructor(private readonly deps: AlertsDeps) {}

  /** The alert playing or waiting for its answer, for tests and the log. */
  get active(): { alertId: string; phase: Active['phase'] } | null {
    return this.#active === null ? null : { alertId: this.#active.alert.alertId, phase: this.#active.phase };
  }

  get pending(): readonly string[] {
    return this.#pending.map((alert) => alert.alertId);
  }

  add(alert: Alert): void {
    const settings = this.deps.settings();

    if (!settings.enabled || !settings.spokenAlerts) {
      this.#done(alert, 'cancelled', 'spoken alerts are off');
      return;
    }

    if (this.deps.inFocus(alert.sessionId)) {
      this.#done(alert, 'cancelled', 'its conversation is in focus');
      return;
    }

    // A newer alert for a session replaces its earlier one, unless that one is already being read.
    for (const older of this.#pending.filter((one) => one.sessionId === alert.sessionId)) {
      this.#pending.splice(this.#pending.indexOf(older), 1);
      this.#done(older, 'cancelled', `replaced by alert ${alert.alertId}`);
    }

    const active = this.#active;

    if (active !== null && active.alert.sessionId === alert.sessionId && active.phase !== 'announcing') {
      this.#finish(active, 'cancelled', `replaced by alert ${alert.alertId}`);
      this.#pending.unshift(alert);
    } else {
      this.#pending.push(alert);
    }

    this.#tick();
  }

  /** The alert's cause was resolved: a waiting one is dropped and a handshake ends; one being read finishes. */
  cancel(alertId: string): void {
    const at = this.#pending.findIndex((alert) => alert.alertId === alertId);

    if (at !== -1) {
      const [alert] = this.#pending.splice(at, 1);

      this.#done(alert!, 'cancelled', 'its cause was resolved');
    } else if (this.#active?.alert.alertId === alertId && this.#active.phase !== 'announcing') {
      this.#finish(this.#active, 'cancelled', 'its cause was resolved');
    }

    this.#tick();
  }

  /** Drops every alert, as when the operator leaves the computer or turns alerts off. */
  cancelAll(why: string): void {
    for (const alert of this.#pending.splice(0)) {
      this.#done(alert, 'cancelled', why);
    }

    if (this.#active !== null) {
      this.#finish(this.#active, 'cancelled', why);
    }

    this.#tick();
  }

  close(): void {
    this.#ticker?.stop();
    this.#ticker = null;

    if (this.#active?.listening === true) {
      this.deps.listen(null);
    }

    this.#active = null;
    this.#pending.length = 0;
  }

  #tick(): void {
    for (const alert of this.#pending.filter((one) => this.deps.inFocus(one.sessionId))) {
      this.#pending.splice(this.#pending.indexOf(alert), 1);
      this.#done(alert, 'cancelled', 'its conversation is in focus');
    }

    const active = this.#active;

    if (active !== null) {
      this.#check(active);
    }

    if (this.#active === null && this.#pending.length > 0) {
      this.#next();
    }

    if (this.#active === null && this.#pending.length === 0) {
      this.#ticker?.stop();
      this.#ticker = null;
    } else if (this.#ticker === null) {
      this.#ticker = (this.deps.every ?? every)(() => this.#tick(), ALERT_TICK_MS);
    }
  }

  /** Ends a handshake whose session came into focus, whose mic stopped listening, or whose answer window closed with nothing said. */
  #check(active: Active): void {
    if (active.phase === 'announcing') {
      return;
    }

    if (this.deps.inFocus(active.alert.sessionId)) {
      this.#finish(active, 'cancelled', 'its conversation is in focus');
      return;
    }

    if (active.phase !== 'awaiting' || active.deadline === null) {
      return;
    }

    const now = this.deps.now();
    const hearing = this.deps.hearing();

    if (!hearing && !this.deps.answerable()) {
      this.#finish(active, 'cancelled', 'the mic stopped listening');
    } else if (now >= active.deadline + ANSWER_GRACE_MS || (now >= active.deadline && !hearing)) {
      this.#finish(active, 'unanswered', 'no answer');
    }
  }

  /** Starts the next alert once the voice is quiet, the operator is not speaking and nothing holds alerts. */
  #next(): void {
    const settings = this.deps.settings();

    if (!settings.enabled || !settings.spokenAlerts) {
      for (const alert of this.#pending.splice(0)) {
        this.#done(alert, 'cancelled', 'spoken alerts are off');
      }

      return;
    }

    if (!this.deps.quiet() || this.deps.hearing() || this.deps.waitReason() !== null || this.deps.now() < this.deps.playedUntil() + ALERT_GAP_MS) {
      return;
    }

    const alert = this.#pending.shift()!;
    const active: Active = { alert, phase: 'prompting', listening: this.deps.answerable(), deadline: null };
    const line = alertLine(alert, settings.operatorName);

    this.#active = active;
    this.deps.log(`alert ${alert.alertId} for session ${alert.sessionId} (${alert.cause}): "${line}"${active.listening ? '' : ', with no answer: the mic is not listening'}`);

    if (active.listening) {
      this.deps.listen((text, cut) => this.#answered(active, text, cut));
    }

    this.deps.say(`alert:${alert.alertId}`, line, alert.as, (state) => this.#prompted(active, state));
  }

  #prompted(active: Active, state: SpeechState): void {
    if (this.#active !== active || active.phase !== 'prompting') {
      return;
    }

    if (state !== 'played') {
      this.#finish(active, 'cancelled', `its line was ${state}`);
    } else if (!active.listening) {
      this.#finish(active, 'unanswered', 'the mic is not listening');
    } else {
      active.phase = 'awaiting';
      active.deadline = this.deps.now() + this.deps.settings().alertAnswerSeconds * 1000;
    }
  }

  #answered(active: Active, text: string | null, cut: boolean): void {
    if (this.#active !== active || active.phase === 'announcing') {
      return;
    }

    if (text === null) {
      this.#finish(active, cut ? 'cancelled' : 'unanswered', cut ? 'its answer was cut off' : 'no answer');
      return;
    }

    if (declines(text)) {
      this.#finish(active, 'declined', `"${text}"`);
      return;
    }

    const { alert } = active;

    active.phase = 'announcing';
    active.listening = false;
    this.deps.listen(null, true);

    const moved = this.deps.talkHere(alert.sessionId);

    this.deps.log(`alert ${alert.alertId} answered "${text}": ${moved ? 'the voice moves to its session' : 'its session cannot be the voice target, so the voice stays'}`);
    this.deps.say(`alert:${alert.alertId}:detail`, alert.detail, alert.as, (state) => {
      if (this.#active === active) {
        this.#finish(active, state === 'played' ? 'announced' : 'cancelled', state === 'played' ? 'read' : `its detail was ${state}`);
      }
    });
  }

  #finish(active: Active, outcome: AlertOutcome, why: string): void {
    if (this.#active !== active) {
      return;
    }

    this.#active = null;

    if (active.listening) {
      active.listening = false;
      this.deps.listen(null);
    }

    if (active.phase === 'prompting') {
      this.deps.unsay(`alert:${active.alert.alertId}`);
    } else if (active.phase === 'announcing') {
      this.deps.unsay(`alert:${active.alert.alertId}:detail`);
    }

    this.#done(active.alert, outcome, why);
  }

  #done(alert: Alert, outcome: AlertOutcome, why: string): void {
    this.deps.log(`alert ${alert.alertId} for session ${alert.sessionId} ${outcome}: ${why}`);
    this.deps.send({ type: 'alert-done', alertId: alert.alertId, sessionId: alert.sessionId, outcome });
  }
}

function every(run: () => void, ms: number): { stop(): void } {
  const timer = setInterval(run, ms);

  return { stop: () => clearInterval(timer) };
}

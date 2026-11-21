/** A needs-you message the hub sends the page that raises alerts (`alerts.surface`, architecture.md § Web page). */
export interface NeedsItem {
  workItemId: number;
  message: string;
}

/** The two tones of the voice process's needs-you chime (`needsYouChime` in packages/voice), in hertz and seconds. */
const CHIME = [
  { hz: 880, seconds: 0.11 },
  { hz: 1320, seconds: 0.16 },
];

/** Plays the needs-you chime with Web Audio; nothing where the browser has none or refuses to play before the operator used the page. */
export function playChime(): void {
  const Context = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;

  if (Context === undefined) {
    return;
  }

  try {
    const audio = new Context();
    let at = audio.currentTime;

    for (const tone of CHIME) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();

      oscillator.frequency.value = tone.hz;
      // A short fade at each end, so the tone does not click.
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.25, at + 0.01);
      gain.gain.linearRampToValueAtTime(0, at + tone.seconds);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + tone.seconds);
      at += tone.seconds;
    }

    setTimeout(() => void audio.close(), (at - audio.currentTime) * 1000 + 100);
  } catch {
    // A page that may not play sound yet stays silent.
  }
}

/**
 * Shows each message as a silent browser notification, one per work item, whose click brings the page forward and shows that work item; nothing
 * until the operator allowed notifications.
 */
export function notifyNeeds(items: readonly NeedsItem[], show: (workItemId: number) => void): void {
  const Notice = (globalThis as { Notification?: typeof Notification }).Notification;

  if (Notice === undefined || Notice.permission !== 'granted') {
    return;
  }

  for (const item of items) {
    const notice = new Notice('Switchboard', { body: item.message.replace(/^Switchboard: /, ''), tag: `switchboard-needs-${item.workItemId}`, silent: true });

    notice.onclick = () => {
      window.focus();
      notice.close();
      show(item.workItemId);
    };
  }
}

/** Whether the browser lets the page show notifications. */
export function notificationsAllowed(): boolean {
  return (globalThis as { Notification?: typeof Notification }).Notification?.permission === 'granted';
}

/**
 * Asks once to show notifications, on the operator's first press in the page, since a browser asks only after a user gesture; `answered` runs
 * once the operator answered.
 */
export function askForNotifications(target: EventTarget, answered: () => void): void {
  const Notice = (globalThis as { Notification?: typeof Notification }).Notification;

  if (Notice?.permission === 'default') {
    target.addEventListener('pointerdown', () => void Notice.requestPermission().then(answered, () => {}), { once: true });
  }
}

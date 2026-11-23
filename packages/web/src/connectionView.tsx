// What the page shows of its connection (architecture.md § Web page, Connection): a dot in the heads, a banner once offline, a screen in the
// page's place when it never connected or is signed out, and the Update ready chip. Nothing changes during the grace period.
import type { VNode } from 'preact';
import type { ConnectionState } from './connection.js';

/** How long offline before the dot turns from amber to grey. */
export const GREY_MS = 60_000;

/** The connection as the page draws it. */
export interface ConnectionView {
  state: ConnectionState;
  since: number;
  lastLiveAt: number | null;
  nextAt: number | null;
  update: boolean;
}

/** The dot's colour and words: none before the page first connected. */
export interface DotView {
  tone: 'live' | 'waiting' | 'off';
  label: string;
}

const clock = (at: number): string => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function dotView(view: ConnectionView, now: number): DotView | null {
  if (view.state === 'connecting') {
    return null;
  }

  if (view.state === 'live' || view.state === 'reconnecting') {
    return { tone: 'live', label: 'Connected' };
  }

  if (view.state === 'signedOut') {
    return { tone: 'off', label: 'Signed out' };
  }

  return now - view.since < GREY_MS ? { tone: 'waiting', label: 'Offline. Reconnecting…' } : { tone: 'off', label: 'Offline' };
}

export function ConnectionDot({ dot }: { dot: DotView | null | undefined }): VNode | null {
  return dot == null ? null : <span class={`conn-dot ${dot.tone}`} role="img" title={dot.label} aria-label={dot.label}></span>;
}

/** When the next attempt runs, in words. */
function retryText(view: ConnectionView, now: number): string {
  return view.nextAt === null ? 'Trying now…' : `Trying again in ${Math.max(1, Math.ceil((view.nextAt - now) / 1000))} s.`;
}

/** Over the list and the conversation once a page that was live is offline: what it shows is as it was when the connection was lost. */
export function renderBanner(view: ConnectionView, now: number): VNode | null {
  if (view.state !== 'offline' || view.lastLiveAt === null) {
    return null;
  }

  return (
    <div class="conn-banner" role="status">
      <span class="conn-banner-text">Offline. Showing what was here at {clock(view.lastLiveAt)}.</span>
      <button type="button" class="conn-retry" data-action="conn-retry" title={retryText(view, now)}>
        Retry
      </button>
    </div>
  );
}

/**
 * In the page's place: Can't reach Switchboard while a page that never connected is offline, with Start Switchboard on this computer only, which
 * can start it; Signed out once the hub says this browser's sign-in is gone. No work items show on either, since the page keeps none.
 */
export function renderScreen(view: ConnectionView, local: boolean, now: number): VNode | null {
  if (view.state === 'signedOut') {
    return (
      <div class="conn-screen" role="alert">
        <div class="conn-screen-body">
          <img class="conn-screen-icon" src="icon-192.png" alt="" width="48" height="48" />
          <h2>Signed out</h2>
          <p>{local ? 'This browser is signed out. Run node ~/.switchboard/hub.js web on this computer and open the link it prints.' : 'This device is signed out. Pair it again to continue.'}</p>
          {local ? null : (
            <a class="conn-primary" href="/page/">
              Pair again
            </a>
          )}
        </div>
      </div>
    );
  }

  if (view.state !== 'offline' || view.lastLiveAt !== null) {
    return null;
  }

  return (
    <div class="conn-screen" role="alert">
      <div class="conn-screen-body">
        <img class="conn-screen-icon" src="icon-192.png" alt="" width="48" height="48" />
        <h2>Can't reach Switchboard</h2>
        <p class="conn-screen-status">{retryText(view, now)}</p>
        <button type="button" class="conn-primary" data-action="conn-retry">
          Try now
        </button>
        {local ? (
          <p class="conn-screen-start">
            <a href="switchboard:start">Start Switchboard</a>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The hub runs another build: the page reloads only when asked, so nothing typed, picked or playing is lost by surprise. */
export function renderUpdate(view: ConnectionView): VNode | null {
  return !view.update || view.state === 'signedOut' ? null : (
    <div class="conn-update" role="status">
      <span>Update ready</span>
      <button type="button" class="conn-reload" data-action="conn-reload">
        Reload
      </button>
    </div>
  );
}

// What the page does when its stream fails (architecture.md § Web page): a restarted hub with the same build takes the page back by the browser's
// own reconnect, which selects its work item again; this covers a hub of another build, and a stream the browser gave up on.

/** How often a page that lost its stream asks whether the hub answers. */
export const RECONNECT_MS = 2_000;
/** `EventSource.CLOSED`: the browser will not reconnect by itself. */
const CLOSED = 2;

export interface ReconnectDeps {
  fetch(url: string, init?: RequestInit): Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;
  setTimeout(run: () => void, ms: number): unknown;
  reload(): void;
  /** The build of the hub that served this page, or null when unknown. */
  build: string | null;
  /**
   * Whether a reload for another build waits, asked every `RECONNECT_MS`: while the voice is on this phone, whose audio a reload ends until
   * the next tap, the page goes on with its build meanwhile (architecture.md § Hub lifecycle).
   */
  hold?(): boolean;
}

/**
 * Called on each stream error: asks `/page/ping` every `RECONNECT_MS` until the hub answers, then reloads the page when the hub runs another
 * build, so the page is always the one its hub serves, or when the browser stopped reconnecting, as after a revoke.
 */
export function reconnector(deps: ReconnectDeps): (source: { readyState?: number }) => void {
  let watching = false;
  let reloading = false;
  const reloadWhenFree = (): void => {
    if (deps.hold?.() === true) {
      deps.setTimeout(reloadWhenFree, RECONNECT_MS);
    } else {
      deps.reload();
    }
  };

  const ask = (source: { readyState?: number }): void => {
    void deps.fetch('/page/ping', { cache: 'no-store' }).then(
      async (response) => {
        const build = response.ok ? ((await response.json().catch(() => null)) as { build?: unknown } | null)?.build : undefined;

        if (typeof build !== 'string') {
          deps.setTimeout(() => ask(source), RECONNECT_MS);
          return;
        }

        watching = false;

        if (deps.build !== null && build !== deps.build) {
          if (!reloading) {
            reloading = true;
            reloadWhenFree();
          }
        } else if (source.readyState === CLOSED) {
          // A signed-out page reloads too, so the hub's signed-out page replaces the conversation it still shows.
          deps.reload();
        }
      },
      () => deps.setTimeout(() => ask(source), RECONNECT_MS),
    );
  };

  return (source) => {
    if (!watching) {
      watching = true;
      deps.setTimeout(() => ask(source), RECONNECT_MS);
    }
  };
}

// The offline page's script (architecture.md § Web page): it asks the hub every few seconds and reloads the page once the hub answers.

/** How often the offline page asks whether the hub is back. */
export const OFFLINE_RETRY_MS = 2_000;

export interface OfflineDeps {
  fetch(url: string): Promise<{ ok: boolean }>;
  reload(): void;
  setTimeout(run: () => void, ms: number): unknown;
}

/** Asks `/page/ping` until the hub answers, then reloads. */
export function waitForHub(deps: OfflineDeps): void {
  const ask = (): void => {
    void deps.fetch('/page/ping').then(
      (response) => (response.ok ? deps.reload() : deps.setTimeout(ask, OFFLINE_RETRY_MS)),
      () => deps.setTimeout(ask, OFFLINE_RETRY_MS),
    );
  };

  ask();
}

export type HostAccess = 'enabled' | 'offline' | 'refused';

export interface HostStartupDeps {
  probe(): Promise<HostAccess>;
  remembered(): Promise<boolean>;
  remember(value: boolean): Promise<void>;
  authority(enabled: boolean): void;
  shell(visible: boolean): void;
  note(text: string | null): void;
  leave(): void;
}

/** An earlier verification permits only the cached shell; website frames still need live authority. */
export class HostStartup {
  #pending: Promise<void> | null = null;
  #stopped = false;
  constructor(private readonly deps: HostStartupDeps) {}
  check(): Promise<void> {
    if (this.#pending !== null || this.#stopped) return Promise.resolve();
    this.#pending = this.#check().finally(() => { this.#pending = null; });
    return this.#pending;
  }
  async #check(): Promise<void> {
    try {
      const access = await this.deps.probe();
      if (this.#stopped) return;
      this.deps.authority(access === 'enabled');
      if (access === 'enabled') {
        await this.deps.remember(true);
        if (this.#stopped) return;
        this.deps.shell(true);
        this.deps.note(null);
      } else if (access === 'offline' && await this.deps.remembered()) {
        if (this.#stopped) return;
        this.deps.shell(true);
        this.deps.note(null);
      } else {
        if (access === 'refused') await this.deps.remember(false);
        this.deps.shell(false);
        this.deps.note(access === 'offline'
          ? 'Cannot reach Switchboard. Connect once to verify this hub, then retry.'
          : 'Sign in to Switchboard and enable Embedded browser tabs, then retry.');
      }
    } catch {
      if (this.#stopped) return;
      this.deps.authority(false);
      this.deps.shell(false);
      this.deps.note('Cannot read the extension’s saved hub. Reload the extension and retry.');
    }
  }
  async leave(): Promise<void> {
    this.#stopped = true;
    this.deps.authority(false);
    // A check already saving verification must finish before it is removed.
    await this.#pending;
    try {
      await this.deps.remember(false);
      this.deps.leave();
    } catch {
      this.deps.shell(false);
      this.deps.note('Cannot clear the saved hub. Reload the extension and retry.');
    }
  }
}

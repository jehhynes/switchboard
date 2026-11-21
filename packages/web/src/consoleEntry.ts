// The console's own script, which the page loads the first time it shows a console (architecture.md § Web page), so xterm.js never slows the page.
import { Terminal } from '@xterm/xterm';
import { mountConsole } from './console.js';
import type { ConsoleOptions, ConsoleTerm, MountedConsole } from './console.js';

(globalThis as { switchboardConsole?: { mount(host: HTMLElement, options: ConsoleOptions): MountedConsole } }).switchboardConsole = {
  mount: (host, options) => mountConsole(host, (termOptions) => new Terminal(termOptions) as unknown as ConsoleTerm, options),
};

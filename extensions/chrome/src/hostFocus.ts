/** Outer-window events can be missed while a child frame has focus. Polling reports changes only. */
export class HostFocus {
  #sent: boolean | null = null;
  constructor(private readonly read: () => boolean, private readonly send: (focused: boolean) => void) {}
  report(force = false): void {
    const focused = this.read();
    if (force || focused !== this.#sent) {
      this.#sent = focused;
      this.send(focused);
    }
  }
}

import { Attachment } from '@switchboard/holder';
import type { AttachOptions } from '@switchboard/holder';

/** How long `POST /attach` may take: a resume may start the holder and wait for its spawn. */
export const ATTACH_TIMEOUT_MS = 90_000;

const RETRY = 'Press Enter to try again, or close this terminal.';

/** An open attachment to a held session. */
export interface AttachLink {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface AttachDeps {
  /** The Switchboard session ID. */
  sessionId: string;
  /** Posts `POST /attach`; a string says why no hub could be asked. */
  post(body: { sessionId: string }): Promise<{ status: number; error: string | null; body: unknown } | string>;
  /** Attaches to the holder; `Attachment.open` by default. */
  open?(options: AttachOptions): Promise<AttachLink>;
  /** The terminal's columns and rows. */
  size(): { cols: number; rows: number };
  write(text: string): void;
  /** Turns the terminal's raw mode on or off; does nothing when input is not a terminal. */
  raw(on: boolean): void;
  onInput(listener: (data: string) => void): void;
  onResize(listener: () => void): void;
  /** Input ended, as when the terminal closed. */
  onEnd(listener: () => void): void;
}

function isHolder(body: unknown): body is { port: number; token: string; session: string } {
  const holder = body as { port?: unknown; token?: unknown; session?: unknown } | null;

  return typeof holder?.port === 'number' && typeof holder.token === 'string' && typeof holder.session === 'string';
}

/**
 * `hub.js attach <session ID>` (architecture.md § Attach client): attaches the terminal to a Code Mode session through the hub, which resumes it
 * when it has ended. After an exit, a refusal or a lost connection it waits for Enter and attaches again, so the terminal stays the session's.
 * Resolves 0 once input ends.
 */
export async function runAttach(deps: AttachDeps): Promise<number> {
  const open = deps.open ?? ((options: AttachOptions) => Attachment.open(options));
  let link: AttachLink | null = null;
  let enter: (() => void) | null = null;
  let ended = false;
  let end = (): void => {};
  const inputEnded = new Promise<'end'>((done) => (end = () => done('end')));

  deps.onInput((data) => {
    if (link !== null) {
      link.input(data);
    } else if (enter !== null && /[\r\n]/.test(data)) {
      const next = enter;

      enter = null;
      next();
    }
  });
  deps.onResize(() => {
    const { cols, rows } = deps.size();

    link?.resize(cols, rows);
  });
  deps.onEnd(() => {
    ended = true;
    link?.close();
    end();
  });

  /** One attach; resolves the line to print when it ends. */
  const attach = async (): Promise<string> => {
    const reply = await deps.post({ sessionId: deps.sessionId });

    if (typeof reply === 'string') {
      return `${reply} ${RETRY}\r\n`;
    }

    if (reply.status !== 200 || !isHolder(reply.body)) {
      return `Refused: ${reply.error ?? `status ${reply.status}`}\r\n${RETRY}\r\n`;
    }

    const holder = reply.body;

    return new Promise<string>((resolve) => {
      let done = false;
      const finish = (text: string): void => {
        if (done) {
          return;
        }

        done = true;
        link?.close();
        link = null;
        deps.raw(false);
        resolve(text);
      };
      const { cols, rows } = deps.size();

      open({
        port: holder.port,
        token: holder.token,
        session: holder.session,
        cols,
        rows,
        onData: (data) => deps.write(data),
        onExit: (exitCode) => finish(`\r\nThe session ended (exit code ${String(exitCode)}). Press Enter to resume it, or close this terminal.\r\n`),
        onClose: (error) => {
          if (error !== null) {
            finish(`\r\n${error.message} ${RETRY}\r\n`);
          }
        },
      }).then(
        (opened) => {
          if (done || ended) {
            opened.close();
          } else {
            link = opened;
            deps.raw(true);
          }
        },
        (error: Error) => finish(`${error.message} ${RETRY}\r\n`),
      );
    });
  };

  while (!ended) {
    const text = await Promise.race([attach(), inputEnded]);

    if (text === 'end') {
      break;
    }

    deps.write(text);

    if ((await Promise.race([new Promise<'enter'>((done) => (enter = () => done('enter'))), inputEnded])) === 'end') {
      break;
    }
  }

  return 0;
}

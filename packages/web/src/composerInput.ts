// The composer box's input state besides its text (architecture.md § Conversation view, Composer): the slash command chosen from the list,
// the walk through earlier messages and the `@` or `/` list's request still on its way. Every change of the box's text goes through it.

/** Whether `text` is one line that is `chosen` alone or followed by a space, so it still names the command chosen from the list. */
function startsWith(text: string, chosen: string): boolean {
  return !text.trim().includes('\n') && (text.trim() === chosen || text.startsWith(`${chosen} `));
}

export interface ComposerInput {
  /** The `/name` chosen from the list while the text still starts with it, else null. */
  readonly chosen: string | null;
  /** Whether Up and Down are walking earlier messages. */
  readonly walking: boolean;
  /** A change of the text other than a choice or a recall: keeps the chosen command only while the text starts with it, ends a walk and drops the list's request. */
  changed(text: string): void;
  /** Another work item, or New conversation…: nothing chosen, no walk, no request. */
  reset(): void;
  /** Chooses `/name` from the list, returning the box's new text. */
  choose(name: string): string;
  /**
   * The text Up or Down recalls from `texts`, oldest first, or null when there is none. The first Up sets the box's text and its chosen
   * command aside, so a recalled `/name` goes escaped, and Down past the newest gives both back.
   */
  recall(up: boolean, text: string, texts: readonly string[]): string | null;
  /** Whether `text` goes as the chosen slash command, with `command: true`. */
  asCommand(text: string): boolean;
  /** Starts a request for the list, returning its token. */
  ask(): number;
  /** Whether the request `token` is the latest and was not dropped since. */
  current(token: number): boolean;
  /** Drops the request on its way, so its answer opens no list. */
  cancel(): void;
}

export function composerInput(): ComposerInput {
  let chosen: string | null = null;
  let walk: { index: number; draft: string; chosen: string | null } | null = null;
  let asked = 0;

  return {
    get chosen() {
      return chosen;
    },
    get walking() {
      return walk !== null;
    },
    changed(text) {
      if (chosen !== null && !startsWith(text, chosen)) {
        chosen = null;
      }

      walk = null;
      asked++;
    },
    reset() {
      chosen = null;
      walk = null;
      asked++;
    },
    choose(name) {
      chosen = `/${name}`;
      walk = null;
      asked++;

      return `${chosen} `;
    },
    recall(up, text, texts) {
      if (!up && walk === null) {
        return null;
      }

      const index = walk === null ? texts.length - 1 : walk.index + (up ? -1 : 1);

      if (up && (texts.length === 0 || index < 0)) {
        return null;
      }

      walk ??= { index, draft: text, chosen };
      asked++;

      if (index >= texts.length) {
        const draft = walk;

        walk = null;
        chosen = draft.chosen;

        return draft.draft;
      }

      walk.index = index;
      chosen = null;

      return texts[index]!;
    },
    asCommand(text) {
      return chosen !== null && startsWith(text, chosen);
    },
    ask() {
      return ++asked;
    },
    current(token) {
      return token === asked;
    },
    cancel() {
      asked++;
    },
  };
}

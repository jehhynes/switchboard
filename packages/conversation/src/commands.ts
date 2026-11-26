import { readLines, skillListing } from './transcript.js';
import type { SlashCommand } from './transcript.js';

/**
 * Built-in commands the composer lists before the session's skills: those that finish without opening a menu in the terminal, which the view
 * cannot answer.
 */
export const BUILT_IN_COMMANDS: readonly SlashCommand[] = [
  { name: 'clear', description: 'Clear the conversation history and free up context' },
  { name: 'compact', description: 'Clear the conversation history but keep a summary in context. Optional: /compact [instructions]' },
];

/**
 * A session's slash commands (architecture.md § Slash commands): the built-ins, then the skills its transcript's `skill_listing` attachments name,
 * in their order. The transcript is read on from where the last call stopped, and from its start when the session's transcript file changes.
 */
export class SessionCommands {
  #path: string | null = null;
  #offset = 0;
  readonly #skills = new Map<string, string>();

  /** `readBytes`: the most one transcript read holds at once; `READ_LINES_BYTES` by default. */
  constructor(private readonly readBytes?: number) {}

  list(path: string | null): SlashCommand[] {
    if (path !== this.#path) {
      this.#path = path;
      this.#offset = 0;
      this.#skills.clear();
    }

    // Read to the transcript's end, a bounded segment at a time (mechanics M165).
    while (path !== null) {
      const read = readLines(path, this.#offset, this.readBytes);

      if (read === null || (read.lines.length === 0 && read.offset === this.#offset)) {
        break;
      }

      // A shorter file than the one read so far is read again from its start.
      if (read.offset < this.#offset) {
        this.#skills.clear();
      }

      this.#offset = read.offset;

      for (const line of read.lines) {
        const listing = skillListing(line);

        if (listing === null) {
          continue;
        }

        if (listing.initial) {
          this.#skills.clear();
        }

        for (const skill of listing.skills) {
          this.#skills.set(skill.name, skill.description);
        }
      }
    }

    const builtIn = new Set(BUILT_IN_COMMANDS.map((command) => command.name));

    return [...BUILT_IN_COMMANDS, ...[...this.#skills].filter(([name]) => !builtIn.has(name)).map(([name, description]) => ({ name, description }))];
  }
}

import { join } from 'node:path';
import { glossaryFile, learnedTerms, loadGlossary, noteUsed, recordHeard, saveGlossary } from './glossary.js';
import type { Glossary } from './glossary.js';
import { fixedTerms, readTerms, termsDir } from './terms.js';

/**
 * The words the recogniser is biased toward (architecture.md § Dictation): the fixed terms of the user and of the target's repository, then the
 * glossary's learnt terms; heard tags teach the glossary, and the operator's recognised words keep its terms in use.
 */
export class Vocabulary {
  #glossary: Glossary | null = null;

  constructor(
    private readonly voiceHome: string,
    private readonly now: () => number,
    private readonly log: (line: string) => void,
  ) {}

  /** The hotwords for a session of the repository (`owner/name`, or null). */
  terms(repo: string | null): string[] {
    const fixed = fixedTerms(this.voiceHome, repo);

    return [...fixed, ...learnedTerms(this.#loaded(), fixed)];
  }

  /** A heard tag; true when it confirmed a pair, whose term the next recogniser boosts. */
  heard(heard: string, meant: string): boolean {
    const pair = recordHeard(this.#loaded(), heard, meant, this.now(), this.#user());

    if (pair === null) {
      this.log(`heard tag "${heard}" = "${meant}" not learnt: not a name or a technical term`);
      return false;
    }

    this.#save();

    if (pair.confirmed) {
      this.log(`learnt "${pair.meant}" from "${heard}"`);
    }

    return pair.confirmed;
  }

  /** The operator said these words: the learnt terms in them were used now. */
  used(text: string): void {
    if (noteUsed(this.#loaded(), text, this.now()).length > 0) {
      this.#save();
    }
  }

  #user(): string[] {
    return readTerms(join(termsDir(this.voiceHome), 'user.txt'));
  }

  #loaded(): Glossary {
    this.#glossary ??= loadGlossary(glossaryFile(this.voiceHome), this.#user());

    return this.#glossary;
  }

  #save(): void {
    try {
      saveGlossary(glossaryFile(this.voiceHome), this.#loaded());
    } catch (error) {
      this.log(`the glossary could not be saved: ${(error as Error).message}`);
    }
  }
}

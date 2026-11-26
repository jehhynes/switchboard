/**
 * How many words a log line names instead of the words themselves (architecture.md § Hub log): voice.log is readable from the page, so it
 * keeps no heard, spoken or alert text.
 */
export function wordCount(text: string): string {
  const count = text.split(/\s+/).filter(Boolean).length;

  return count === 1 ? '1 word' : `${count} words`;
}

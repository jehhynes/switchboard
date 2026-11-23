// Versions for the files the page reads (architecture.md § Web page).

let reads = 0;

/**
 * A version for a file the page read, never given to another read while the page lives: the diff viewer's highlighting workers, one pool
 * for the page, keep a file's highlighted lines by its version alone and draw another file with them when the version matches.
 */
export function readVersion(): string {
  reads += 1;
  return `read ${reads}`;
}

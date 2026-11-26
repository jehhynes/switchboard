// A least-recently-used cache keyed by text, bounded by its entries and by the characters of their keys, for what the page draws from text.

/**
 * The bounds of the page's caches of drawn text (`trusted`, `renderMarkdown`): more entries than one draw of a 4000-item conversation walks, about
 * 4050 strings; 16 million characters of keys at most; and no key longer than 64 K characters, a reply's being a few K while an artifact's
 * document can be megabytes.
 */
export const KEPT_ENTRIES = 5000;
export const KEPT_CHARS = 16_000_000;
export const KEPT_LONGEST = 64 * 1024;

export interface TextCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  readonly size: number;
  /** The characters of the keys held. */
  readonly chars: number;
}

/**
 * At most `entries` values and `chars` characters of keys, the least recently used dropped first. A key longer than `longest` is never kept,
 * so one large document, such as an artifact's, cannot hold its old versions; the value it stands for is taken to grow with it.
 */
export function textCache<V>(entries: number, chars: number, longest: number): TextCache<V> {
  const held = new Map<string, V>();
  let total = 0;

  return {
    get(key) {
      const value = held.get(key);

      // Moved to the end of the Map's order: used last.
      if (value !== undefined) {
        held.delete(key);
        held.set(key, value);
      }

      return value;
    },
    set(key, value) {
      if (key.length > longest) {
        return;
      }

      if (held.delete(key)) {
        total -= key.length;
      }

      held.set(key, value);
      total += key.length;

      while (held.size > entries || total > chars) {
        const oldest = held.keys().next().value!;

        held.delete(oldest);
        total -= oldest.length;
      }
    },
    get size() {
      return held.size;
    },
    get chars() {
      return total;
    },
  };
}

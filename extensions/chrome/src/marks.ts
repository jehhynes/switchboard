import type { Mark } from '@switchboard/core/group';

// The codicon glyphs the panel shows for each mark (PRD R27), drawn with codicon.ttf; Queued's `clock` is an alias of `history`.
export const MARK_GLYPHS: Record<Mark, string> = {
  question: '\u{eb32}',
  send: '\u{ec0f}',
  review: '\u{ea70}', // eye
  blocked: '\u{ead1}', // debug-pause
  failed: '\u{ea87}', // error
  queued: '\u{ea82}', // clock
  setup: '\u{eb6d}', // tools
  running: '\u{ea77}', // sync
  triaging: '\u{eb19}', // loading
  'done-session': '\u{eab2}', // check
  'done-operator': '\u{eb99}', // account
  'done-unassigned': '\u{ea6e}', // sign-out
};

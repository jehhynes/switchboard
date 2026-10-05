import type { Snapshot } from '@switchboard/hub';

/** Sources with a title-bar toggle; package.json contributes an on and an off command for each (PRD R3). */
export const TOGGLED_SOURCES = ['github', 'zoho', 'forum'] as const;

/** The `switchboard.source.<name>` context value per toggled source: on, off, or undefined when it is not configured. */
export function sourceContexts(snapshot: Pick<Snapshot, 'sourceStates'>): Record<string, 'on' | 'off' | undefined> {
  return Object.fromEntries(
    TOGGLED_SOURCES.map((name) => {
      const state = snapshot.sourceStates.find((source) => source.name === name);

      return [name, state === undefined ? undefined : state.enabled ? 'on' : 'off'];
    }),
  );
}

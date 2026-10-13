import type { Triage } from './model.js';
import type { FocusPage } from './playbook.js';
import type { Anchor } from './source.js';

/**
 * The URL of the focus triage chose (PRD R79): the chosen anchor when it is on the playbook's page or the playbook names none, else the
 * playbook's page, else the ticket. Null when the context has no ticket anchor either.
 */
export function focusUrl(anchors: readonly Anchor[], id: string | null, page: FocusPage | null): string | null {
  const chosen = anchors.find((anchor) => anchor.id === id);

  if (chosen !== undefined && (page === null || chosen.page === page)) {
    return chosen.url;
  }

  return (anchors.find((anchor) => anchor.id === page) ?? anchors.find((anchor) => anchor.id === 'ticket'))?.url ?? null;
}

/** The focus of the latest successful triage, kept while a later one runs or after it fails, else the ticket's URL; null with neither (PRD R79). */
export function effectiveFocus(triages: readonly Triage[], ticketUrl: string): string | null {
  const latest = triages.filter((triage) => triage.playbook !== null).at(-1);

  return latest?.focus ?? (ticketUrl === '' ? null : ticketUrl);
}

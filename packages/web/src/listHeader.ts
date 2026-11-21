import { escape } from './markdown.js';
import { morph } from './morph.js';
import type { PageHeader, SourceGroup } from './types.js';

type Answer = { status: number; body: Record<string, unknown> };

export interface ListHeaderDeps {
  /** Posts a page command with the page key, as the page's other commands do. */
  post(name: string, body: Record<string, unknown>): Promise<Answer>;
  /** Draws the page again after the header changed what it shows. */
  redraw(): void;
}

/**
 * Each source kind's logo, as the dock's header draws it (`SourceGithub`, `SourceZoho` and `SourceForum` in the dock's `App.axaml`): GitHub's
 * mark, Zoho Desk's outline and Forum's letters, each in the colour of its ticket pill, grey while the kind is off.
 */
const LOGOS: Record<string, { viewBox: string; path: string; stroke: boolean; evenOdd: boolean }> = {
  github: {
    viewBox: '0 0 24 24',
    stroke: false,
    evenOdd: false,
    path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  },
  zoho: {
    viewBox: '11 2 28 35',
    stroke: true,
    evenOdd: false,
    path: 'M12 36 L15 18 Q15.3 16 17.5 16 L29.5 16 Q31 16 31.2 14.5 L31.6 11.6 Q31.7 10.4 30.5 10.1 Q29 9.7 29 8.4 L29 5 Q29 3 31 3 L35.5 3 Q37.5 3 37.5 5 L37.5 17.5 L25 24.5 L20 20.5 M35.6 24 L34.6 30.5 Q34.3 32 32.6 32 L17.5 32L12 36',
  },
  forum: {
    viewBox: '0 0 335 185',
    stroke: false,
    evenOdd: true,
    path: 'M75 20H260V145H160L100 180V145H75Z M95 40V125H120V145L150 125H240V40Z',
  },
};

/** A source kind's logo, grey while off; a kind without one shows a tag, so its button is never blank. */
export function sourceLogo(kind: string, enabled: boolean): string {
  const logo = LOGOS[kind];
  const state = enabled ? '' : ' off';

  if (logo === undefined) {
    return `<span class="codicon codicon-tag source-logo${state}" aria-hidden="true"></span>`;
  }

  const paint = logo.stroke ? 'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"' : `fill="currentColor"${logo.evenOdd ? ' fill-rule="evenodd"' : ''}`;

  return `<svg class="source-logo ${escape(kind)}${state}" viewBox="${logo.viewBox}" aria-hidden="true" focusable="false"><path ${paint} d="${logo.path}"/></svg>`;
}

/** A menu row's left gutter: a check mark for a checked row, or nothing, as the page's other menus draw it. */
function gutter(checked: boolean): string {
  return `<span class="menu-gutter" aria-hidden="true">${checked ? '<span class="codicon codicon-check"></span>' : ''}</span>`;
}

/** What the header has open: a source kind's menu by its kind, or nothing. */
export interface HeaderView {
  menu: string | null;
  /** A refusal the header's last action got, shown under it until dismissed or the next action. */
  notice: string | null;
}

/**
 * A source kind's header icon (PRD R3, R71), as the dock's: its logo, grey while every source of the kind is off, and the hub's tooltip. With one
 * source a click turns it on or off; with several it opens a menu with a check row per source, which stays open so several can change.
 */
function sourceButton(group: SourceGroup, view: HeaderView): string {
  const several = group.sources.length > 1;
  const name = several ? group.kind : (group.sources[0]?.name ?? group.kind);
  const open = view.menu === `source:${group.kind}`;
  const state = several ? `aria-haspopup="menu" aria-expanded="${open}"` : `aria-pressed="${group.enabled}"`;
  const menu =
    several && open
      ? `<ul class="glass menu source-menu" role="menu" aria-label="${escape(`${group.kind} sources`)}">${group.sources
          .map((one) => `<li role="none"><button type="button" class="menu-row" role="menuitemcheckbox" aria-checked="${one.enabled}" data-action="list-source-entry" data-source="${escape(one.name)}">${gutter(one.enabled)}<span class="title">${escape(one.name)}</span></button></li>`)
          .join('')}</ul>`
      : '';

  return `<div class="menu-anchor" data-key="source-${escape(group.kind)}"><button type="button" class="icon source-toggle" data-action="list-source" data-kind="${escape(group.kind)}" ${state} title="${escape(group.title)}" aria-label="${escape(name)}">${sourceLogo(group.kind, group.enabled)}</button>${menu}</div>`;
}

/**
 * The list's header (architecture.md § Web page), as the dock's title row: the title, which takes what is left and ends in an ellipsis, then
 * the source icons; a refusal shows under it.
 */
export function renderListHeader(header: PageHeader | null, view: HeaderView): string {
  const sources = header?.sources ?? [];
  const icons = sources.length === 0 ? '' : `<div class="header-sources">${sources.map((group) => sourceButton(group, view)).join('')}</div>`;
  const notice =
    view.notice === null
      ? ''
      : `<p class="list-notice" role="alert"><span class="list-notice-text">${escape(view.notice)}</span><button type="button" class="icon dismiss" data-action="list-dismiss" title="Dismiss" aria-label="Dismiss"><span class="codicon codicon-close" aria-hidden="true"></span></button></p>`;

  return `<div class="list-header"><span class="list-title">Switchboard</span>${icons}</div>${notice}`;
}

/**
 * The list's header (architecture.md § Web page): the dock header's source icons, drawn into `host` and run from its own clicks and keys. The
 * page calls `draw` with each state it draws.
 */
export function listHeader(host: HTMLElement, deps: ListHeaderDeps): { draw(header: PageHeader | null): void; close(): void } {
  const view: HeaderView = { menu: null, notice: null };
  let shown: PageHeader | null = null;

  const redraw = (): void => deps.redraw();
  const closeMenu = (focusOpener: boolean): void => {
    const kind = view.menu?.startsWith('source:') === true ? view.menu.slice('source:'.length) : null;

    view.menu = null;
    redraw();

    if (focusOpener && kind !== null) {
      [...host.querySelectorAll<HTMLElement>('[data-action="list-source"]')].find((one) => one.dataset['kind'] === kind)?.focus();
    }
  };
  /** Turns one source on or off; the hub's next list shows the change, and a refusal shows under the header. */
  const setSource = async (name: string, enabled: boolean): Promise<void> => {
    view.notice = null;
    redraw();

    const answer = await deps.post('page-source', { name, enabled });

    if (answer.status !== 200) {
      view.notice = String(answer.body['error'] ?? 'The source was not changed.');
      redraw();
    }
  };

  host.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');

    switch (button?.dataset['action']) {
      case 'list-source': {
        const group = shown?.sources.find((one) => one.kind === button.dataset['kind']);

        if (group === undefined) {
          break;
        }

        if (group.sources.length === 1) {
          view.menu = null;
          void setSource(group.sources[0]!.name, !group.sources[0]!.enabled);
        } else {
          view.menu = view.menu === `source:${group.kind}` ? null : `source:${group.kind}`;
          redraw();
        }

        break;
      }
      case 'list-source-entry': {
        const name = button.dataset['source'] ?? '';
        const one = shown?.sources.flatMap((group) => group.sources).find((entry) => entry.name === name);

        if (one !== undefined) {
          void setSource(name, !one.enabled);
        }

        break;
      }
      case 'list-dismiss':
        view.notice = null;
        redraw();
        break;
    }
  });
  host.addEventListener('keydown', (event) => {
    if (view.menu === null) {
      return;
    }

    if (event.key === 'Escape') {
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Up and Down move between the open menu's rows, as in the page's other menus.
      const rows = [...host.querySelectorAll<HTMLElement>('.menu .menu-row')];
      const at = rows.indexOf(document.activeElement as HTMLElement);

      if (rows.length > 0) {
        rows[at === -1 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]!.focus();
        event.preventDefault();
      }
    }
  });

  // An open menu closes on a press outside the header.
  const outside = (event: Event): void => {
    if (view.menu !== null && !(event.target instanceof Node && host.contains(event.target))) {
      closeMenu(false);
    }
  };

  document.addEventListener('pointerdown', outside);

  return {
    draw: (header) => {
      shown = header;

      // A kind whose menu is open and that is gone, or now has one source, has no menu.
      if (view.menu?.startsWith('source:') === true && (header?.sources.find((one) => `source:${one.kind}` === view.menu)?.sources.length ?? 0) < 2) {
        view.menu = null;
      }

      morph(host, renderListHeader(header, view));
    },
    close: () => document.removeEventListener('pointerdown', outside),
  };
}

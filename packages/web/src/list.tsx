// The page's list of work items (architecture.md § Web page), drawn as the dock's.
import type { ComponentChildren, VNode } from 'preact';
import { MARK_ICONS, SPINNING_MARKS } from '@switchboard/core/group';
import { bandOpen, rowKey } from './render.js';
import type { PageGroup, PageRow } from '@switchboard/protocol';
import type { DragView } from './reorder.js';
import { WindowRows } from './windowRows.js';

/** The codicon Returned shows, as the dock's pill does. */
const RETURNED_GLYPH = '\u{eae2}';

/**
 * A pill on line 2: its codicon glyph, if any, then its text, the full name in its tooltip. `opens` makes a pill with a link open it; without
 * it the pill is a label, a click on it the row's, while the browser pane shows the links.
 */
function Pill({ classes, glyph, text, title, opens }: { classes: string; glyph: string | null; text: string; title: string; opens?: Record<string, string> }) {
  return (
    <span class={`pill ${classes}`} title={title} {...opens}>
      {glyph === null ? null : <span class="codicon" aria-hidden="true">{glyph}</span>}
      <span class="pill-text">{text}</span>
    </span>
  );
}

/**
 * A row of the list, drawn as the dock's three lines from the hub's dock row: line 1 the priority dot, the title and the time; line 2 the
 * comment icon, the playbook with its namespace muted (or a hosted conversation's host), the ticket key as a pill in its source's colour, the
 * link pills and Returned, those that do not fit left out whole by the page's CSS (page.css, Line 2); line 3 the mark and the
 * details, a muted " · " between them, in their tones. The dock's stripe is on its left edge.
 */
function Row({ row, selected, menu, pillsOpen, movable, drag, position }: { row: PageRow; selected: boolean; menu: ComponentChildren | null; pillsOpen: boolean; movable: boolean; drag: DragView | null; position?: { index: number; total: number } }) {
  const kind = row.mark?.kind;
  const mark =
    row.mark === null || kind === undefined ? null : (
      <span class={`codicon codicon-${MARK_ICONS[kind]} mark${SPINNING_MARKS.has(kind) ? ' codicon-modifier-spin' : ''}${kind === 'failed' ? ' failed' : ''}`} role="img" title={row.mark.title} aria-label={row.mark.title}></span>
    );
  const colon = row.playbook.indexOf(':');
  const playbook =
    row.host !== null ? (
      <span class="playbook host" title={`Hosted by ${row.host}`}>{row.host}</span>
    ) : row.playbook === '' ? null : (
      <span class="playbook" title={row.playbook}>
        {colon === -1 ? null : <span class="namespace">{row.playbook.slice(0, colon + 1)}</span>}
        {row.playbook.slice(colon + 1)}
      </span>
    );
  // A Ready for review row can be dragged to a new place (reorder.ts); the drop line is on the edge of the row the drop lands next to.
  const dropEdge = drag?.drop?.edge === row.workItemId ? (drag.drop.below ? ['drop-below'] : ['drop-above']) : [];
  const dragged = drag !== null && drag.dragging === row.workItemId ? ['dragging'] : [];
  const classes = ['row', ...(row.stripe === null ? [] : [`stripe-${row.stripe}`]), ...(row.dim ? ['dim'] : []), ...(selected ? ['selected'] : []), ...(movable ? ['movable'] : []), ...dragged, ...dropEdge].join(' ');
  const key = rowKey(row);
  // Without the browser pane a pill with a link opens it instead of the row's click, as the dock's `OnPillTapped` (PRD R52).
  const opens = (which: string): Record<string, string> => (pillsOpen ? { 'data-action': 'open-link', 'data-row': key, 'data-link': which } : {});
  const details = row.details.map((detail, index) => [
    index > 0 ? <span class="row-detail-separator" aria-hidden="true">·</span> : null,
    <span class={`row-detail${detail.tone === null ? '' : ` ${detail.tone}`}`} title={detail.title ?? undefined}>{detail.text}</span>,
  ]);
  // A pool ticket has no conversation to open, so its click opens its menu under it.
  const click: Record<string, string> =
    row.workItemId === null
      ? { 'data-action': 'pool-menu', 'data-row': key, 'aria-haspopup': 'menu', 'aria-expanded': String(menu !== null) }
      : { 'data-action': 'select', 'data-work-item': String(row.workItemId), 'aria-current': String(selected) };

  return (
    <li class={row.workItemId === null ? 'pool-row' : undefined} data-window-row={position === undefined ? undefined : key} aria-posinset={position === undefined ? undefined : position.index + 1} aria-setsize={position?.total}>
      <button type="button" class={classes} {...click} title={row.title}>
        <span class="row-head">
          {row.priority === null ? null : <span class="priority" role="img" title={row.priority} aria-label={row.priority}></span>}
          <span class="row-title">{row.title}</span>
          {row.voice === null ? null : (
            <span class="codicon voice-mark" role="img" title={row.voice.title} aria-label={row.voice.title}>
              {row.voice.glyph}
            </span>
          )}
          {row.time === null ? null : <span class="row-time" title={row.time.title}>{row.time.text}</span>}
        </span>
        <span class="row-line">
          {row.comment === null ? null : <span class="codicon comment" role="img" title={row.comment.title} aria-label="Comments">{row.comment.glyph}</span>}
          {playbook}
          <Pill classes={`ticket source-${row.sourceKind}`} glyph={null} text={row.ticket} title={row.url === '' ? row.ticket : `${row.ticket}\n${row.url}`} opens={row.url === '' ? {} : opens('ticket')} />
          {row.links.length === 0 && row.returned === 0 ? null : (
            <span class="row-links">
              {row.links.map((link, index) => (
                <Pill classes={`link ${link.kind}${link.mentioned ? ' mentioned' : ''}`} glyph={link.glyph} text={link.badge} title={`${link.label}${link.mentioned ? ', named in the ticket' : ''}\n${link.url}`} opens={opens(String(index))} />
              ))}
              {row.returned > 0 ? <Pill classes="returned" glyph={RETURNED_GLYPH} text={String(row.returned)} title={`Returned ${row.returned}: earlier work items with this playbook, or one it is a return of, were done for this ticket`} /> : null}
            </span>
          )}
        </span>
        {mark === null && details.length === 0 ? null : (
          <span class="row-line row-details">
            {mark}
            {details}
          </span>
        )}
      </button>
      {menu === null ? null : (
        <ul class="glass menu row-menu" role="menu" aria-label={`Actions for ${row.ticket}`}>
          {menu}
        </ul>
      )}
    </li>
  );
}

/** A group's rows in runs of one band each, in their order; a row without a band is in a run with no heading. */
export function bandRuns(rows: readonly PageRow[]): Array<{ band: string | null; rows: PageRow[] }> {
  const runs: Array<{ band: string | null; rows: PageRow[] }> = [];

  for (const row of rows) {
    const band = row.band;
    const last = runs.at(-1);

    if (last !== undefined && last.band === band) {
      last.rows.push(row);
    } else {
      runs.push({ band, rows: [row] });
    }
  }

  return runs;
}

/**
 * The page's list (architecture.md § Web page): the dock's groups in its order, each a header with its codicon, title and count that opens or
 * collapses it, then its rows; a collapsed group still shows the selected row, so the selection is never hidden. While a search `filtering` it,
 * only the groups with rows show, every one open, and the search's end says when none matched. `menu` is the pool ticket row whose menu is
 * open, by its key, with the menu's rows. An open group's rows with a band, Done's, sit under their band's heading, a muted label with its count
 * and a rule that opens or closes it (`bands`, else `OPEN_BANDS`); a closed band still shows the selected row, and a search opens every band.
 * `drag` is a drag of a Ready for review row under way (reorder.ts): the dragged row and its drop line.
 */
export function renderList(groups: readonly PageGroup[], selected: number | null, collapsed: ReadonlySet<string>, filtering = false, menu: { row: string; rows: ComponentChildren } | null = null, bands: ReadonlyMap<string, boolean> = new Map(), pillsOpen = false, drag: DragView | null = null): VNode | null {
  if (groups.every((group) => group.rows.length === 0)) {
    return filtering ? null : <p class="empty">No work items yet. They appear here when Switchboard starts one.</p>;
  }

  return (
    <nav class="work-list" aria-label="Work items">
      {groups.map((group) => {
        const open = filtering || !collapsed.has(group.key);
        const rows = open ? group.rows : group.rows.filter((row) => row.workItemId === selected);
        const rowList = (shown: readonly PageRow[]) =>
          shown.length === 0 ? null : group.key === 'done' ? (
            <WindowRows rows={shown} selected={selected} renderRow={(row, index) => (
              <Row key={rowKey(row)} row={row} selected={row.workItemId !== null && row.workItemId === selected} menu={null} pillsOpen={pillsOpen} movable={false} drag={null} position={{ index, total: shown.length }} />
            )} />
          ) : (
            <ul class="rows">
              {shown.map((row) => (
                <Row key={rowKey(row)} row={row} selected={row.workItemId !== null && row.workItemId === selected} menu={menu !== null && menu.row === rowKey(row) ? menu.rows : null} pillsOpen={pillsOpen} movable={group.key === 'review' && row.workItemId !== null} drag={drag} />
              ))}
            </ul>
          );
        const banded = open && rows.some((row) => row.band !== null);

        return (
          <section class="group" data-group={group.key} key={group.key}>
            <button type="button" class="group-head" data-action="group" data-group={group.key} aria-expanded={open}>
              <span class={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden="true"></span>
              <span class="codicon group-icon" aria-hidden="true">{group.glyph}</span>
              <span class="group-title">{group.title}</span>
              <span class={`group-count${group.rows.length === 0 ? ' zero' : ''}`} aria-label={`${group.rows.length} work items`}>{group.rows.length}</span>
            </button>
            {!banded
              ? rowList(rows)
              : bandRuns(rows).map((run) => {
                  if (run.band === null) {
                    return rowList(run.rows);
                  }

                  const key = `${group.key}:${run.band}`;
                  const shown = filtering || bandOpen(key, bands);

                  return (
                    <div class="band" key={key}>
                      <button type="button" class="band-head" data-action="band" data-band={key} aria-expanded={shown}>
                        <span class={`codicon codicon-chevron-${shown ? 'down' : 'right'}`} aria-hidden="true"></span>
                        <span class="band-title">{run.band}</span>
                        <span class="band-count" aria-label={`${run.rows.length} work items`}>
                          {run.rows.length}
                        </span>
                        <span class="band-rule" aria-hidden="true"></span>
                      </button>
                      {rowList(shown ? run.rows : run.rows.filter((row) => row.workItemId !== null && row.workItemId === selected))}
                    </div>
                  );
                })}
            {open && group.rows.length === 0 && group.empty !== null ? <p class="group-empty">{group.empty}</p> : null}
          </section>
        );
      })}
    </nav>
  );
}

/** What the list's host shows: why the page's link no longer works, or a refused select, the list and the search's end. */
export function renderListPane(expired: boolean, error: string | null, list: VNode | null, end: VNode | null): VNode {
  if (expired) {
    return <p class="empty">This page's link is no longer valid. Open a new one with Switchboard: Open Web Page in VS Code, or hub.js web.</p>;
  }

  return (
    <>
      {error === null ? null : (
        <p class="list-error" role="alert">
          {error}
        </p>
      )}
      {list}
      {end}
    </>
  );
}

import type { PaneModel } from '../paneModel.js';

/** What a click in the pane asks the extension to do. */
export type PaneMessage = { type: 'ready' } | { type: 'open'; target: string } | { type: 'main'; key: string } | { type: 'dock' } | { type: 'size'; inner: number; outer: number; dpr: number };

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The pane's HTML: a block per work item with its pills, Report and main control, or with none the count that needs the operator (PRD R92). */
export function renderPane(model: PaneModel): string {
  if (model.items.length === 0) {
    const needs = model.needs === 0 ? 'Nothing needs you' : `${model.needs} ${model.needs === 1 ? 'needs' : 'need'} you`;

    return `<div class="idle"><span>${needs}</span><button data-dock="">Show the Dock</button></div>`;
  }

  return model.items
    .map((item) => {
      const pills = item.links
        .map((link) => {
          const glyph = link.glyph === null ? '' : `<span class="codicon">${escape(link.glyph)}</span>`;
          const kind = `pill ${link.kind}${link.mentioned ? ' mentioned' : ''}`;

          return link.url === null
            ? `<span class="${kind}" data-key="link:${escape(link.url ?? link.text)}" title="${escape(link.title)}">${glyph}${escape(link.text)}</span>`
            : `<button class="${kind}" data-key="link:${escape(link.url ?? link.text)}" data-open="${escape(link.url)}" title="${escape(link.title)}">${glyph}${escape(link.text)}</button>`;
        })
        .join('');
      const report = item.report === null ? '' : `<button data-key="report" data-open="${escape(item.report)}" title="${escape(item.report)}"><span class="codicon codicon-file"></span>Report</button>`;
      const main =
        item.main === null
          ? ''
          : `<button class="main" data-key="main" data-main="${escape(item.key)}" title="${escape(item.main.title)}">${item.main.glyph === null ? '' : `<span class="codicon">${escape(item.main.glyph)}</span>`}${escape(item.main.label)}</button>`;
      const actions = report === '' && main === '' ? '' : `<div class="actions">${report}${main}</div>`;

      return `<section class="item" data-key="${escape(item.key)}"><div class="pills">${pills}</div>${actions}</section>`;
    })
    .join('');
}

/** The message a click on `target` sends, or null for a click outside a button. */
export function clickMessage(target: Element | null): PaneMessage | null {
  const button = target?.closest('button');

  if (button === null || button === undefined) {
    return null;
  }

  if (button.dataset['open'] !== undefined) {
    return { type: 'open', target: button.dataset['open'] };
  }

  if (button.dataset['main'] !== undefined) {
    return { type: 'main', key: button.dataset['main'] };
  }

  return button.dataset['dock'] !== undefined ? { type: 'dock' } : null;
}

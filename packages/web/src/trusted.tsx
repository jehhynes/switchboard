// Markup the page does not build itself: Markdown from markdown-it, with raw HTML off, and the HTML of the renderers in
// `packages/conversation`, which escape what they draw. It becomes Preact nodes, so it is patched with the rest of the page.
import { h } from 'preact';
import type { ComponentChild } from 'preact';
import { KEPT_CHARS, KEPT_ENTRIES, KEPT_LONGEST, textCache } from './lru.js';

/** Attributes whose presence alone sets them, given to Preact as true so it sets the property. */
const BOOLEANS = new Set(['disabled', 'checked', 'selected', 'open', 'hidden', 'multiple', 'required', 'autofocus', 'reversed']);
/** Parsed HTML by its text, so a redraw does not parse it again (`textCache`); HTML longer than `KEPT_LONGEST`, such as an artifact's document, is parsed each time. */
const parsed = textCache<DocumentFragment>(KEPT_ENTRIES, KEPT_CHARS, KEPT_LONGEST);

function node(from: Node): ComponentChild {
  if (from.nodeType === 3) {
    return from.nodeValue;
  }

  if (from.nodeType !== 1) {
    return null;
  }

  const element = from as Element;
  const props: Record<string, unknown> = {};

  for (const { name, value } of element.attributes) {
    // No renderer draws an event handler; one is never carried over.
    if (!/^on/i.test(name)) {
      props[name] = BOOLEANS.has(name) ? true : value;
    }
  }

  // Keyed by `data-key`, `data-id` or `id`, so a control keyed apart, such as Stop and Spoken replies, is never one turned into the other.
  const key = element.getAttribute('data-key') ?? element.getAttribute('data-id') ?? (element.id === '' ? null : element.id);

  if (key !== null) {
    props['key'] = key;
  }

  return h(element.localName, props, ...[...element.childNodes].map(node));
}

/** Nodes for HTML a trusted renderer made (never text from the hub or the operator). */
export function trusted(html: string): ComponentChild {
  if (html === '') {
    return null;
  }

  let fragment = parsed.get(html);

  if (fragment === undefined) {
    const template = document.createElement('template');

    template.innerHTML = html;
    fragment = template.content;
    parsed.set(html, fragment);
  }
  const nodes = [...fragment.childNodes].map(node);

  return nodes.length === 1 ? nodes[0] : nodes;
}

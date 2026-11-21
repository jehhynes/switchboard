// Markup the page does not build itself: Markdown from markdown-it, with raw HTML off, and the HTML of the renderers the page shares with the
// Conversation view (`packages/conversation`), which escape what they draw. It becomes Preact nodes, so it is patched with the rest of the page.
import { h } from 'preact';
import type { ComponentChild } from 'preact';

/** Attributes whose presence alone sets them, given to Preact as true so it sets the property. */
const BOOLEANS = new Set(['disabled', 'checked', 'selected', 'open', 'hidden', 'multiple', 'required', 'autofocus', 'reversed']);
/** Parsed HTML by its text, so a redraw does not parse it again. */
const parsed = new Map<string, DocumentFragment>();
const KEPT = 500;

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

    if (parsed.size >= KEPT) {
      parsed.delete(parsed.keys().next().value!);
    }

    parsed.set(html, fragment);
  }

  const nodes = [...fragment.childNodes].map(node);

  return nodes.length === 1 ? nodes[0] : nodes;
}
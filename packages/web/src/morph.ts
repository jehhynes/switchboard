/**
 * Brings an element's children in line with new HTML by changing only what differs (architecture.md § Web page), so a redraw keeps the
 * nodes it does not change, and with them the focus, a text selection, the caret, scroll positions and open menus. Children are matched by
 * `data-key`, `data-id` or `id` where they have one, else by position and tag; a field's value is left alone while it has the focus.
 */
export function morph(target: Element, html: string): void {
  const doc = target.ownerDocument;
  const template = doc.createElement('template');
  const focused = doc.activeElement;
  const selection = doc.getSelection();
  // The anchor and focus as plain values, in the operator's direction, because a live range collapses when a node it holds is moved.
  const ends =
    selection !== null && selection.anchorNode !== null && selection.focusNode !== null && target.contains(selection.anchorNode) && target.contains(selection.focusNode)
      ? ([selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset] as const)
      : null;

  template.innerHTML = html;
  patchChildren(target, template.content);

  // Moving a node to reorder it drops the focus and selection inside it.
  if (focused instanceof HTMLElement && focused !== doc.activeElement && target.contains(focused)) {
    focused.focus({ preventScroll: true });
  }

  if (ends !== null && selection !== null && target.contains(ends[0]) && target.contains(ends[2])) {
    try {
      selection.setBaseAndExtent(...ends);
    } catch {
      // An end's offset no longer fits its node's changed text.
    }
  }
}

function keyOf(node: Node): string | null {
  if (node.nodeType !== 1) {
    return null;
  }

  const element = node as Element;
  const key = element.getAttribute('data-key') ?? element.getAttribute('data-id') ?? (element.id === '' ? null : element.id);

  return key === null ? null : `${element.tagName}#${key}`;
}

function same(a: Node, b: Node): boolean {
  return a.nodeType === b.nodeType && (a.nodeType !== 1 || ((a as Element).tagName === (b as Element).tagName && (a as Element).getAttribute('type') === (b as Element).getAttribute('type')));
}

function patchChildren(from: Node, to: Node): void {
  const keyed = new Map<string, Node>();
  const wanted = new Set<string>();

  for (let child = to.firstChild; child !== null; child = child.nextSibling) {
    const key = keyOf(child);

    if (key !== null) {
      wanted.add(key);
    }
  }

  // Keyed children that are gone are removed first, so the ones that stay are not moved past them.
  for (let child = from.firstChild; child !== null; ) {
    const after: ChildNode | null = child.nextSibling;
    const key = keyOf(child);

    if (key !== null && (!wanted.has(key) || keyed.has(key))) {
      from.removeChild(child);
    } else if (key !== null) {
      keyed.set(key, child);
    }

    child = after;
  }

  let cursor = from.firstChild;

  for (let next = to.firstChild; next !== null; ) {
    const after = next.nextSibling;
    const key = keyOf(next);
    let match: Node | null = null;

    if (key !== null) {
      const found = keyed.get(key);

      if (found !== undefined && same(found, next)) {
        match = found;
        keyed.delete(key);
      }
    } else if (cursor !== null && keyOf(cursor) === null && same(cursor, next)) {
      match = cursor;
    }

    if (match === null) {
      from.insertBefore(next, cursor);
    } else {
      if (match === cursor) {
        cursor = cursor.nextSibling;
      } else {
        from.insertBefore(match, cursor);
      }

      patch(match, next);
    }

    next = after;
  }

  while (cursor !== null) {
    const after: ChildNode | null = cursor.nextSibling;

    from.removeChild(cursor);
    cursor = after;
  }
}

function patch(from: Node, to: Node): void {
  if (from.nodeType !== 1) {
    if (from.nodeValue !== to.nodeValue) {
      from.nodeValue = to.nodeValue;
    }

    return;
  }

  const element = from as Element;
  const next = to as Element;

  for (const name of element.getAttributeNames()) {
    if (!next.hasAttribute(name)) {
      element.removeAttribute(name);
    }
  }

  for (const name of next.getAttributeNames()) {
    const value = next.getAttribute(name)!;

    if (element.getAttribute(name) !== value) {
      element.setAttribute(name, value);
    }
  }

  // A field keeps what the operator is typing; one without the focus shows the value drawn.
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const value = element instanceof HTMLTextAreaElement ? (next.textContent ?? '') : (next.getAttribute('value') ?? '');

    if (element.ownerDocument.activeElement !== element && element.value !== value) {
      element.value = value;
    }

    if (element instanceof HTMLInputElement) {
      element.checked = next.hasAttribute('checked');
    }

    return;
  }

  patchChildren(element, next);
}

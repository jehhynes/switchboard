// Text boxes in sheets that grow with their text (architecture.md § Web page, Sheets).
import type { ComponentProps } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

/**
 * Sizes `box` to its text: from its `rows` or CSS min-height up to its CSS max-height, past which it scrolls. A box not laid out, as in a
 * test's document, keeps its size.
 */
export function grow(box: HTMLTextAreaElement): void {
  box.style.height = 'auto';

  if (box.scrollHeight === 0) {
    box.style.height = '';
    return;
  }

  const style = getComputedStyle(box);
  const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);

  box.style.height = `${box.scrollHeight + border}px`;
}

/** A textarea that grows with its text as it is drawn and as it is typed in; its other attributes pass through. */
export function GrowingText(props: ComponentProps<'textarea'>) {
  const box = useRef<HTMLTextAreaElement>(null);

  // Every draw can change the text, as a redraw that restores a draft does.
  useLayoutEffect(() => {
    if (box.current !== null) {
      grow(box.current);
    }
  });

  return <textarea {...props} ref={box} onInput={(event) => grow(event.currentTarget)}></textarea>;
}

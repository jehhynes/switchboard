// Brief replies' fade (architecture.md § Web page, Speech): where a folded reply's details are cut, measured from the lines of text the page drew.

/** A line of text, from the top of the box it is drawn in. */
export interface TextLine {
  top: number;
  bottom: number;
}

/** Where the fade cuts a folded reply's details: its height, and how far down it the text stays wholly opaque. */
export interface FadeCut {
  height: number;
  solid: number;
}

/**
 * The cut for details drawn as `lines`: the first two lines whole, the third fading out below them. Null when the fade would hide less than
 * 1.5 lines (`lineHeight`) below it, or nothing, so the details show in full; a cut that hid less would only make the operator click for it.
 */
export function fadeCut(lines: TextLine[], lineHeight: number): FadeCut | null {
  if (lines.length < 3) {
    return null;
  }

  const height = Math.ceil(lines[2]!.bottom);

  return lines.at(-1)!.bottom - height < 1.5 * lineHeight ? null : { height, solid: Math.round(lines[1]!.bottom) };
}

/** The lines of text `box` draws, top down, from its top: the text boxes that share a row are one line, whatever blocks they are in. */
export function textLines(box: HTMLElement): TextLine[] {
  const top = box.getBoundingClientRect().top;
  const boxes: TextLine[] = [];
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);

  for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
    if (text.textContent?.trim() === '') {
      continue;
    }

    const range = document.createRange();

    range.selectNodeContents(text);
    for (const one of range.getClientRects()) {
      if (one.width > 0 && one.height > 0) {
        boxes.push({ top: one.top - top, bottom: one.bottom - top });
      }
    }
  }

  boxes.sort((a, b) => a.top - b.top);
  const lines: TextLine[] = [];

  for (const one of boxes) {
    const last = lines.at(-1);

    // A box whose middle is above the line's bottom shares its row, as a link or bold text in a line of plain text does.
    if (last !== undefined && (one.top + one.bottom) / 2 < last.bottom) {
      last.top = Math.min(last.top, one.top);
      last.bottom = Math.max(last.bottom, one.bottom);
    } else {
      lines.push({ ...one });
    }
  }

  return lines;
}

/**
 * Fits a folded reply's fade (`.reply-fade`) to its details: sets its height and solid part, or answers false when the details should show in
 * full; true too when nothing is drawn to measure, as in a hidden tab, which leaves the fade as it was.
 */
export function fitFade(fade: HTMLElement): boolean {
  const text = fade.firstElementChild as HTMLElement | null;

  if (text === null) {
    return true;
  }

  const lines = textLines(text);

  if (lines.length === 0) {
    return true;
  }

  const style = getComputedStyle(text.firstElementChild ?? text);
  const lineHeight = parseFloat(style.lineHeight) || lines[0]!.bottom - lines[0]!.top;
  const cut = fadeCut(lines, lineHeight);

  if (cut === null) {
    return false;
  }

  fade.style.setProperty('--sb-fade-height', `${cut.height}px`);
  fade.style.setProperty('--sb-fade-solid', `${cut.solid}px`);
  return true;
}

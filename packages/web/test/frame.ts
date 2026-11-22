/** The page's `frame` for tests: a draw it asks for runs at once, so a test reads the page right after an event, as before coalescing. */
export const drawAtOnce = (run: () => void): void => run();

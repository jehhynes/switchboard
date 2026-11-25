import { pageStorage, startLayout } from './layout.js';

// Runs at document_start, before GitHub paints, so a hidden sidebar or full width never flashes at its old size on a page load.
startLayout(document, pageStorage(window));

import { paneMarkerTitle } from './pane.js';

// The pane helper finds the pane window by this title while this tab is in front (architecture.md § Pane helper).
document.title = paneMarkerTitle(location.search, location.hash);

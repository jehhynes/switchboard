import { paneMarker } from './pane.js';

// The dock finds the pane window by this title while this tab is in front (architecture.md § Chrome pane).
const marker = paneMarker(location.hash.slice(1));

document.title = marker === null ? 'Switchboard pane' : `Switchboard pane ${marker}`;

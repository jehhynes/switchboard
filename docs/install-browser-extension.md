# Installing the browser extension on another computer

The browser extension shows Switchboard on GitHub project boards ([prd.md](prd.md) R56, R66, R67) and keeps the links the web page opens in a Switchboard tab group, one tab per kind (R123). On the computer that runs Switchboard, load `extensions/chrome/dist` from the repository. On another computer that uses the web page over Tailscale (R115), install it from the page (R121):

1. Pair the computer's browser with the web page, if it is not paired yet: on the computer that runs Switchboard, open More Actions › Pair a device… and open the link or type the code in that browser.
2. In the paired page, open More Actions › Get the browser extension… and select Download.
3. Extract `switchboard-extension.zip`.
4. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge and turn on Developer mode.
5. Select Load unpacked and choose the extracted `switchboard-extension` folder.

Load it in the same browser and profile as the paired page: the extension reaches the hub through the page's address with that browser's sign-in, and holds no key of its own. It stops working when the device is signed out, and works again once the browser pairs again.

## Troubleshooting

- **No pills on the board:** open the web page in the same browser. A page that asks for a pairing code means the browser is not signed in; pair it again.
- **The download answers that the hub has no browser extension:** the installed VS Code extension was built without `extensions/chrome`. Run `npm run build` in the repository, then package and install the extension (AGENTS.md § Reinstalling after a change).
- **After a Switchboard update:** download the extension again, replace the folder's files and select the extension's reload button in `chrome://extensions`. An unpacked extension does not update itself.
- **Firefox:** not offered. Release Firefox installs only a signed copy, and the signed build is made from the repository ([architecture.md § Browser extension](architecture.md#browser-extension)).

## GitHub iframe experiment

`web.iframeBrowser` is a disabled-by-default proof of concept on the experimental branch (R123). Enable **GitHub iframe (experiment)** under Settings → General → Web page on the hub computer, then reload the page. It takes precedence over Chrome pane.

Load this branch's `extensions/chrome/dist`, or download a fresh copy from the paired page after installing this branch's hub. Older remote copies cannot receive the new page messages. Use Chrome or Edge 145 or later, in the same profile as the signed-in Switchboard page. There is no extra pairing code: the extension checks the page's sign-in, origin and configuration. It requests GitHub and loopback host access, declarative header rules and cleanup alarms even when the setting is off, but installs no exception until an enabled, signed-in page asks. A missing extension leaves instructions and Retry; a changed setting offers Reload Switchboard.

The ordinary Browser tab tests public GitHub pages, where cross-site sign-in cookies may be blocked. Select **Open with sign-in support** to open the extension-hosted view, which contains the same Switchboard page and a sibling GitHub frame. In that view, use **Open outside** to sign into GitHub in the same profile, then **Reload** in the Browser toolbar. This keeps the top-level page on the extension's origin, so Chromium can apply its cookie exemptions. The host opens as a normal browser tab, not the installed app, and desktop notification prompts require the ordinary page. The experiment changes no login cookies. Current live results and remaining authentication limits are recorded in mechanics.md.

Only HTTPS github.com pages are supported. The toolbar selects a work item link, reloads it or opens it outside. Header exceptions remove GitHub's entire Content-Security-Policy as well as its framing header, only for GitHub frame documents in the verified tab. Other sites open outside. Turning the setting off in the hosted view returns to the ordinary page; reload an ordinary page after changing the setting. Firefox and phones without extension support are outside the proof of concept.
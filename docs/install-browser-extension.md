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
- **Extension tab says “127.0.0.1 refused to connect”:** update the hub, then reload that tab. If the refusal remains, hard-reload the ordinary Switchboard page with Ctrl+Shift+R and reload the extension tab. An older cached framing policy can cause this refusal (mechanics M142).
- **Firefox:** not offered. Release Firefox installs only a signed copy, and the signed build is made from the repository ([architecture.md § Browser extension](architecture.md#browser-extension)).

## Embedded browser tabs

Enable **Embedded browser tabs** (`web.iframeBrowser`, off by default during rollout) under Settings → General → Web page on the hub computer, then reload. Load the current `extensions/chrome/dist`, or download a fresh copy from the paired page after updating the hub. Use Chrome or Edge 145 or later in the same profile as the signed-in Switchboard page. No separate extension pairing is needed.

Select a link tab and **Open with sign-in support** to open the existing Switchboard page inside its extension host. It reuses that host for the hub and opens the selected work item. Ctrl+click a work item's link pill to open the linked site outside and sign in using the same profile, then close and reopen its link tab. The hosted view fills the tab content area without an extra toolbar or hint. Scroll the link strip with a trackpad or Shift+wheel; keyboard focus also reveals clipped tabs. Each link has a closable tab; visited frames keep their navigation, scroll position and forms while another tab shows. Closing a link or selecting another work item disposes its frame. Selecting a work item creates tabs for its ticket URL and every attached HTTP or HTTPS link. A normal link-pill click selects its work item and opens or focuses that tab. Ctrl+click (or Meta+click) opens externally without selecting: in the default browser on this computer, or an outside tab on a paired device.

The extension requests access to HTTP and HTTPS sites, declarative header rules and cleanup alarms. After updating, approve the browser's changed site-access request if prompted. Header exceptions remove a website's entire Content-Security-Policy and framing header only for the current tab list's hosts when opened by the extension or navigated within the same host in a verified, signed-in tab while the setting is enabled, preserving Switchboard's own CSP. Cookies are not copied or rewritten. The host opens as a normal browser tab; desktop notification prompts require the ordinary page. GitHub sign-in evidence and remaining browser limits are in mechanics M138. Nested cross-site frames and cross-site navigation started by a website keep their framing restrictions. Switchboard links open outside. Other sites can have additional sign-in requirements; Ctrl+click its link pill if a flow cannot finish embedded.

A missing extension offers Retry; reload after changing the setting. Turning it off in the host returns to the ordinary page. Firefox and phones without extension support use external links. The native Chrome pane and its pairing menu are retired; old `web.chromePane` values are ignored. Old helper build folders and `pane-helper.json` may be removed after the old hub exits, and an old pane window can be closed normally.

### App-style window on Windows

Chrome can launch the installed extension host in its own app-style window. Create a Windows shortcut to `chrome.exe` with these arguments, replacing the profile directory and encoded hub origin with those used by the signed-in browser:

```text
--profile-directory="Profile 1" --app="chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije/iframeHost.html?origin=http%3A%2F%2F127.0.0.1%3A47616"
```

The extension must already be installed in that profile. Use the origin from the working extension-hosted tab, including its port; paired devices use their encoded HTTPS origin. This launch retains the extension host and its website sign-in behavior, with Switchboard's icon and title above the page and no browser tab strip. It does not register an installed PWA. Each launch can create another window; taskbar pinning, grouping and full browser restart have not been verified (mechanics M144).

The app window still runs Switchboard's JavaScript and service worker. The shell cache does not contain work items or conversations. Fresh extension-host startup currently needs the hub to answer its origin and setting checks, even when the inner page's shell is cached; an offline reload can therefore stop at the host's sign-in note. This also affects the ordinary extension-hosted tab. Restore connectivity and reload.

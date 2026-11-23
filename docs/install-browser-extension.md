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

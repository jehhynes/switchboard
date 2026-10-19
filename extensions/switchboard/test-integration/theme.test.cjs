const assert = require('node:assert/strict');
const { request } = require('node:http');
const vscode = require('vscode');

const wait = async (read) => {
  const deadline = Date.now() + 15_000;
  while (!read()) {
    assert.ok(Date.now() < deadline, 'theme did not reach the dock stream');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

describe('dock theme', () => {
  it('reports the active theme on focus and theme changes', async () => {
    const api = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    await wait(() => api.hub());
    const hub = api.hub();
    let latest;
    let buffered = '';
    const stream = request({ host: '127.0.0.1', port: hub.port, path: '/dock/events', headers: { Authorization: `Bearer ${hub.token}` } }, response => {
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffered += chunk;
        let end;
        while ((end = buffered.indexOf('\n\n')) >= 0) {
          const event = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          if (event.startsWith('event: dock\n')) latest = JSON.parse(event.slice(event.indexOf('data: ') + 6));
        }
      });
    });
    stream.on('error', () => {});
    stream.end();
    const config = vscode.workspace.getConfiguration('workbench');
    const original = config.inspect('colorTheme').globalValue;
    try {
      await config.update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global);
      await wait(() => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light);
      await api.windowStateChanged(true);
      await wait(() => latest?.theme === 'light');
      // The real VS Code window is focused by the integration harness.
      assert.ok(vscode.window.state.focused, 'theme events require the test window to be focused');
      await config.update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Global);
      await wait(() => latest?.theme === 'dark');
      await config.update('colorTheme', 'Default High Contrast Light', vscode.ConfigurationTarget.Global);
      await wait(() => latest?.theme === 'light');
      await config.update('colorTheme', 'Default High Contrast', vscode.ConfigurationTarget.Global);
      await wait(() => latest?.theme === 'dark');
    } finally {
      await config.update('colorTheme', original, vscode.ConfigurationTarget.Global);
      stream.destroy();
    }
  });
});

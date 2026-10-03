const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { request } = require('node:http');
const { join } = require('node:path');
const vscode = require('vscode');

const hubJson = join(process.env.SWITCHBOARD_TEST_HOME, '.switchboard', 'hub.json');

function record() {
  try {
    return JSON.parse(readFileSync(hubJson, 'utf8'));
  } catch {
    return null;
  }
}

function call(port, path, token, method = 'GET') {
  return new Promise((resolve) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const outbound = request({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });

    outbound.on('error', () => resolve(null));
    outbound.end();
  });
}

async function until(what, why, within = 30_000) {
  const deadline = Date.now() + within;

  for (;;) {
    const answer = await what();

    if (answer) {
      return answer;
    }

    assert.ok(Date.now() < deadline, why);
    await new Promise((done) => setTimeout(done, 200));
  }
}

const api = () => vscode.extensions.getExtension('switchboard.switchboard').activate();

describe('the hub process', () => {
  it('is started by the extension in a separate process and connected', async () => {
    const extension = await api();
    const started = await until(() => record(), 'no hub.json was written');

    assert.notStrictEqual(started.pid, process.pid, 'the hub runs inside the extension host');

    const status = await call(started.port, '/status', started.token);

    assert.strictEqual(status.status, 200);
    assert.strictEqual(JSON.parse(status.body).hub, 'switchboard');

    const connected = await until(() => extension.hub(), 'the extension never connected to the hub');

    assert.strictEqual(connected.pid, started.pid);
  });

  it('refuses requests without the token', async () => {
    const started = await until(() => record(), 'no hub is running');

    assert.strictEqual((await call(started.port, '/status', null)).status, 401);
    assert.strictEqual((await call(started.port, '/status', 'wrong')).status, 401);
  });

  it('is started again when the running hub stops', async () => {
    const before = await until(() => record(), 'no hub is running');

    await call(before.port, '/shutdown', before.token, 'POST');

    const after = await until(
      () => {
        const now = record();

        return now && now.pid !== before.pid ? now : null;
      },
      'no new hub was started after the first stopped',
      60_000,
    );

    assert.strictEqual((await call(after.port, '/status', after.token)).status, 200);

    const extension = await api();

    await until(() => extension.hub()?.pid === after.pid, 'the extension did not reconnect to the new hub');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { VoiceClient } from '../src/client.js';
import { encode, LineReader, parseHubMessage, parseVoiceMessage, PROTOCOL } from '../src/protocol.js';
import type { HubMessage } from '../src/protocol.js';
import { parseVoiceRecord, voiceLockAddress, voiceRecordPath } from '../src/record.js';
import { VoiceServer } from '../src/server.js';

const servers: VoiceServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function start() {
  const received: HubMessage[] = [];
  const connected: boolean[] = [];
  let shutdowns = 0;
  const server = new VoiceServer({
    token: 'secret',
    build: 'b1',
    greeting: () => [{ type: 'active', gen: 4, sessionId: 's1', reason: 'focus' }],
    receive: (message) => received.push(message),
    shutdown: () => void shutdowns++,
    connected: (one) => connected.push(one),
    log: () => undefined,
  });

  servers.push(server);

  return { server, port: await server.listen(), received, connected, shutdowns: () => shutdowns };
}

const until = async (test: () => boolean): Promise<void> => {
  for (let index = 0; index < 200 && !test(); index++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('voice server and client', () => {
  it('welcomes a hub with the token, greets it, takes its messages, and lets a new hub replace it', async () => {
    const { server, port, received, connected, shutdowns } = await start();

    await expect(VoiceClient.connect({ port, token: 'wrong' })).rejects.toThrow('The token is wrong.');

    const client = await VoiceClient.connect({ port, token: 'secret' });
    const messages: unknown[] = [];

    expect(client.welcome).toEqual({ protocol: PROTOCOL, build: 'b1', pid: process.pid, features: [] });
    expect(client.compatible).toBe(true);
    client.onMessage((message) => messages.push(message));
    await until(() => messages.length === 1);
    expect(messages).toEqual([{ type: 'active', gen: 4, sessionId: 's1', reason: 'focus' }]);

    client.send({ type: 'stop' });
    client.send({ type: 'talk-here', sessionId: 's1' });
    await until(() => received.length === 2);
    expect(received).toEqual([{ type: 'stop' }, { type: 'talk-here', sessionId: 's1' }]);
    server.send({ type: 'audio', mic: 'off', engine: 'decibri', device: null, error: null });
    await until(() => messages.length === 2);

    const closed: Error[] = [];

    // The link and the hub both hear the end.
    client.onClose((error) => closed.push(error));
    client.onClose((error) => closed.push(error));

    const second = await VoiceClient.connect({ port, token: 'secret' });

    await until(() => closed.length === 2);
    expect(closed.map((error) => error.message)).toEqual(['The voice process closed the connection.', 'The voice process closed the connection.']);
    second.send({ type: 'shutdown' });
    await until(() => shutdowns() === 1);
    expect(connected).toEqual([true, true]);
    second.close();
    await until(() => connected.length === 3);
    expect(connected.at(-1)).toBe(false);
  });

  it('refuses a malformed or unknown message from the hub', async () => {
    const { port } = await start();
    const client = await VoiceClient.connect({ port, token: 'secret' });
    const closed: Error[] = [];

    client.onClose((error) => closed.push(error));
    (client as unknown as { send(message: unknown): void }).send({ type: 'dance' });
    await until(() => closed.length === 1);
    expect(closed).toHaveLength(1);
  });
});

describe('voice protocol', () => {
  it('reads each hub message and refuses invalid fields', () => {
    expect(parseHubMessage('{"type":"targets","targets":[{"sessionId":"s1","workItemId":3}],"focus":{"sessionId":"s1","via":"window"}}')).toEqual({
      type: 'targets',
      targets: [{ sessionId: 's1', workItemId: 3 }],
      focus: { sessionId: 's1', via: 'window' },
    });
    expect(parseHubMessage('{"type":"targets","targets":[],"focus":null}')).toEqual({ type: 'targets', targets: [], focus: null });
    expect(parseHubMessage('{"type":"speak","gen":2,"replyId":"r","sessionId":"s","text":"Hi.","tone":null,"turn":"m","voice":"cedar","style":"pair","personality":"Warm."}')).toEqual({
      type: 'speak',
      gen: 2,
      replyId: 'r',
      sessionId: 's',
      text: 'Hi.',
      tone: null,
      turn: 'm',
      voice: 'cedar',
      style: 'pair',
      personality: 'Warm.',
    });
    // A voice or style the voice process does not know is refused.
    expect(parseHubMessage('{"type":"speak","gen":2,"replyId":"r","sessionId":"s","text":"Hi.","tone":null,"turn":"m","voice":"robot","style":"pair","personality":null}')).toEqual({ error: 'Invalid speak message.' });
    expect(parseHubMessage('{"type":"speak","gen":2,"replyId":"r","sessionId":"s","text":"Hi.","tone":null,"turn":"m","voice":"cedar","style":"loud","personality":null}')).toEqual({ error: 'Invalid speak message.' });
    expect(parseHubMessage('{"type":"cancel","replyId":"r"}')).toEqual({ type: 'cancel', replyId: 'r' });
    expect(parseHubMessage('{"type":"earcon","kind":"needs-you"}')).toEqual({ type: 'earcon', kind: 'needs-you' });
    expect(parseHubMessage('{"type":"settings","settings":{"enabled":true}}')).toMatchObject({ type: 'settings' });
    expect(parseHubMessage('{"type":"speak","gen":-1,"replyId":"r","sessionId":"s","text":"Hi.","tone":null,"turn":null}')).toEqual({ error: 'Invalid speak message.' });
    expect(parseHubMessage('{"type":"targets","targets":[{"sessionId":""}],"focus":null}')).toEqual({ error: 'Invalid targets message.' });
    expect(parseHubMessage('{"type":"targets","targets":[],"focus":{"sessionId":"s","via":"terminal"}}')).toEqual({ error: 'Invalid targets message.' });
    expect(parseHubMessage('{"type":"earcon","kind":"other"}')).toEqual({ error: 'Invalid earcon message.' });
    expect(parseHubMessage('{"type":"hello"}')).toEqual({ error: 'Invalid hello message.' });
    expect(parseHubMessage('{"type":"talk-here"}')).toEqual({ error: 'Invalid talk-here message.' });
    expect(parseHubMessage('{"type":"settings","settings":1}')).toEqual({ error: 'Invalid settings message.' });
    expect(parseHubMessage('{"type":"cancel"}')).toEqual({ error: 'Invalid cancel message.' });
    expect(parseHubMessage('[1]')).toEqual({ error: 'The message is not an object.' });
    expect(parseHubMessage('{')).toEqual({ error: 'The message is not JSON.' });
    expect(parseVoiceMessage('{"type":"active","gen":1,"sessionId":null,"reason":"gone"}')).toEqual({ type: 'active', gen: 1, sessionId: null, reason: 'gone' });
    expect(parseVoiceMessage('{"x":1}')).toBeNull();
    expect(parseVoiceMessage('nope')).toBeNull();
    expect(encode({ type: 'stop' })).toBe('{"type":"stop"}\n');
  });

  it('splits lines across chunks and refuses one over the limit', () => {
    const reader = new LineReader(10);

    expect(reader.push(Buffer.from('ab'))).toEqual([]);
    expect(reader.push(Buffer.from('c\nde\n'))).toEqual(['abc', 'de']);
    expect(reader.push(Buffer.from('0123456789x'))).toEqual({ error: 'The message is too long.' });
    expect(new LineReader(3).push(Buffer.from('abcdef\n'))).toEqual({ error: 'The message is too long.' });
  });

  it("reads a complete record, names the lock per home, and refuses a partial record", () => {
    const record = { protocol: 1, build: 'b', port: 5000, token: 't', pid: 9, startedAt: 'now' };

    expect(parseVoiceRecord(JSON.stringify(record))).toEqual(record);
    expect(parseVoiceRecord(JSON.stringify({ ...record, port: 0 }))).toBeNull();
    expect(parseVoiceRecord('[]')).toBeNull();
    expect(parseVoiceRecord('{')).toBeNull();
    expect(voiceLockAddress('C:/Users/A/.switchboard', 'win32')).toMatch(/^\\\\\.\\pipe\\switchboard-voice-[0-9a-f]{16}$/);
    expect(voiceLockAddress('C:/Users/A/.switchboard', 'win32')).toBe(voiceLockAddress('c:/users/a/.switchboard', 'win32'));
    expect(voiceLockAddress('/home/a/.switchboard', 'linux')).toMatch(/[\\/]home[\\/]a[\\/]\.switchboard[\\/]voice\.sock$/);
    expect(voiceRecordPath('/h').replaceAll('\\', '/')).toBe('/h/voice.json');
  });
});

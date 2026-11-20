import { describe, expect, it } from 'vitest';
import { parseHubMessage } from '../src/protocol.js';
import { parseRemote } from '../src/repo.js';

describe('parseRemote', () => {
  it('reads owner and name from https, ssh and scp-style remotes, and nothing from a local path', () => {
    expect(parseRemote('https://github.com/Acme/Widgets.git')).toBe('acme/widgets');
    expect(parseRemote('ssh://git@github.com/acme/app/')).toBe('acme/app');
    expect(parseRemote('git@github.com:acme/app.git')).toBe('acme/app');
    expect(parseRemote('D:/git/app')).toBeNull();
    expect(parseRemote('https://example.com')).toBeNull();
  });
});

describe('voice protocol', () => {
  it('reads the dictation messages and a target\'s repository, and refuses malformed ones', () => {
    expect(parseHubMessage('{"type":"mic","on":true}')).toEqual({ type: 'mic', on: true });
    expect(parseHubMessage('{"type":"typing","on":false}')).toEqual({ type: 'typing', on: false });
    expect(parseHubMessage('{"type":"mic","on":"yes"}')).toEqual({ error: 'Invalid mic message.' });
    expect(parseHubMessage('{"type":"context","sessionId":"s1","lastReply":"Done."}')).toEqual({ type: 'context', sessionId: 's1', lastReply: 'Done.' });
    expect(parseHubMessage('{"type":"context","sessionId":"","lastReply":"Done."}')).toEqual({ error: 'Invalid context message.' });
    expect(parseHubMessage('{"type":"heard","heard":"a llama","meant":"Ollama"}')).toEqual({ type: 'heard', heard: 'a llama', meant: 'Ollama' });
    expect(parseHubMessage('{"type":"heard","heard":" ","meant":"Ollama"}')).toEqual({ error: 'Invalid heard message.' });
    expect(parseHubMessage('{"type":"targets","targets":[{"sessionId":"s1","workItemId":1,"repo":"acme/app"},{"sessionId":"s2","workItemId":2}],"focus":null}')).toEqual({
      type: 'targets',
      targets: [
        { sessionId: 's1', workItemId: 1, repo: 'acme/app' },
        { sessionId: 's2', workItemId: 2, repo: null },
      ],
      focus: null,
    });
    expect(parseHubMessage('{"type":"targets","targets":[{"sessionId":"s1","workItemId":1,"repo":5}],"focus":null}')).toEqual({ error: 'Invalid targets message.' });
  });

  it('reads a focus on a session terminal window as well as a window, and refuses another kind', () => {
    expect(parseHubMessage('{"type":"targets","targets":[{"sessionId":"s1","workItemId":1}],"focus":{"sessionId":"s1","via":"terminal"}}')).toEqual({
      type: 'targets',
      targets: [{ sessionId: 's1', workItemId: 1, repo: null }],
      focus: { sessionId: 's1', via: 'terminal' },
    });
    expect(parseHubMessage('{"type":"targets","targets":[],"focus":{"sessionId":"s1","via":"window"}}')).toMatchObject({ focus: { sessionId: 's1', via: 'window' } });
    expect(parseHubMessage('{"type":"targets","targets":[],"focus":{"sessionId":"s1","via":"tab"}}')).toEqual({ error: 'Invalid targets message.' });
  });
});

import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { deliveredTone, PERSONA_RESET, personaById, resolvePersona, sessionTone, toneSection, toneVersion } from '../src/persona.js';
import type { PersonaSettings } from '../src/persona.js';
import { DEFAULT_SETTINGS, parseSettings } from '../src/settings.js';
import type { Persona, Settings } from '../src/settings.js';
import { Harness, issue, settings } from './flowHarness.js';

const nova: Persona = { id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: 'Warm and direct, with dry humour.' };
const orion: Persona = { id: 'orion', name: 'Orion', voice: 'ash', style: 'deadpan', personality: 'Terse and precise.' };
const roster: PersonaSettings = { personas: [nova, orion], playbookPersonas: { 'dev:question': 'orion' } };

function voiceOf(text: unknown): Settings['voice'] | string[] {
  const parsed = parseSettings(JSON.stringify({ voice: text }));

  return 'errors' in parsed ? parsed.errors : parsed.settings.voice;
}

describe('voice.personas and voice.playbookPersonas (architecture.md § Personas)', () => {
  it('default to an empty roster', () => {
    expect(DEFAULT_SETTINGS.voice).toMatchObject({ personas: [], playbookPersonas: {} });
    expect(voiceOf({})).toMatchObject({ personas: [], playbookPersonas: {} });
  });

  it('read each persona, its voice and style defaulting to the section', () => {
    expect(
      voiceOf({ voice: 'sage', style: 'upbeat', personas: [{ id: 'nova', name: ' Nova ', personality: ' Warm. ' }, { id: 'orion', name: 'Orion', voice: 'ash', style: 'deadpan' }], playbookPersonas: { 'dev:question': 'orion' } }),
    ).toMatchObject({
      personas: [
        { id: 'nova', name: 'Nova', voice: 'sage', style: 'upbeat', personality: 'Warm.' },
        { id: 'orion', name: 'Orion', voice: 'ash', style: 'deadpan', personality: '' },
      ],
      playbookPersonas: { 'dev:question': 'orion' },
    });
  });

  it('refuse a malformed roster or an assignment to a persona not in it', () => {
    expect(voiceOf({ personas: {} })).toEqual(['voice.personas must be a list.']);
    expect(voiceOf({ personas: [{ id: 'Nova', name: 'Nova' }] })).toEqual(['voice.personas[0].id must be lowercase letters, digits and hyphens.']);
    expect(voiceOf({ personas: [{ id: 'nova', name: 'Nova' }, { id: 'nova', name: 'Other' }] })).toEqual(['voice.personas[1].id nova is used by another persona.']);
    expect(voiceOf({ personas: [{ id: 'nova', name: '' }] })).toEqual(['voice.personas[0].name must be 1 to 40 characters.']);
    expect(voiceOf({ personas: [{ id: 'nova', name: 'Nova', personality: 'x'.repeat(601) }] })).toEqual(['voice.personas[0].personality must be at most 600 characters.']);
    expect(voiceOf({ personas: [{ id: 'nova', name: 'Nova', voice: 'robot', tone: 'x' }] })).toEqual(['voice.personas[0].tone is not a setting.', 'voice.personas[0].voice must be one of marin, cedar, alloy, ash, ballad, coral, echo, sage, shimmer, verse.']);
    expect(voiceOf({ personas: ['nova'] })).toEqual(['voice.personas[0] must be an object.']);
    expect(voiceOf({ personas: [{ id: 'nova', name: 'Nova' }], playbookPersonas: { 'dev:question': 'orion' } })).toEqual(['voice.playbookPersonas.dev:question must name a persona in voice.personas.']);
    expect(voiceOf({ playbookPersonas: [] })).toEqual(['voice.playbookPersonas must be an object.']);
  });
});

describe('resolvePersona', () => {
  it('takes nothing from an empty roster', () => {
    expect(resolvePersona({ personas: [], playbookPersonas: {} }, 'dev:question', [])).toBeNull();
  });

  it("takes the playbook's persona, even one a live session has", () => {
    expect(resolvePersona(roster, 'dev:question', ['orion'])?.id).toBe('orion');
  });

  it('takes a free persona from the pool, then the least used', () => {
    expect(resolvePersona(roster, null, [])?.id).toBe('nova');
    expect(resolvePersona(roster, 'dev:develop', ['nova', null])?.id).toBe('orion');
    expect(resolvePersona(roster, null, ['nova', 'orion', 'nova'])?.id).toBe('orion');
    expect(resolvePersona(roster, null, ['nova', 'orion'])?.id).toBe('nova');
  });

  it('falls back to the pool when the assigned persona left the roster', () => {
    expect(resolvePersona({ personas: [nova], playbookPersonas: { 'dev:question': 'orion' } }, 'dev:question', [])?.id).toBe('nova');
    expect(personaById(roster, 'gone')).toBeNull();
  });
});

describe('the tone section', () => {
  it('names the persona and says it sets only the tone', () => {
    const section = toneSection(nova)!;

    expect(section).toContain('## Persona\nIn this session you are Nova. Warm and direct, with dry humour.');
    expect(section).toContain('It never changes how you do the work');
    expect(section).toContain('follow the last one');
  });

  it('is none for no persona or one with no personality', () => {
    expect(toneSection(null)).toBeNull();
    expect(toneSection({ ...nova, personality: '' })).toBeNull();
    expect(toneVersion(null)).toBeNull();
  });

  it('has a version that tells sections apart', () => {
    expect(toneVersion(toneSection(nova))).toMatch(/^[0-9a-f]{8}$/);
    expect(toneVersion(toneSection(nova))).toBe(toneVersion(toneSection(nova)));
    expect(toneVersion(toneSection(nova))).not.toBe(toneVersion(toneSection(orion)));
  });

  it('reaches a prompt only while voice.enabled is on', () => {
    expect(sessionTone({ enabled: true, ...roster }, { personaId: 'nova' })).toBe(toneSection(nova));
    expect(sessionTone({ enabled: false, ...roster }, { personaId: 'nova' })).toBeNull();
    expect(sessionTone({ enabled: true, ...roster }, { personaId: null })).toBeNull();
  });

  it('is replaced by a reset at a resume or compaction for a persona whose section is now none, since the launch may still carry one', () => {
    const blank = { personas: [nova, { ...orion, personality: '' }], playbookPersonas: {} };

    expect(deliveredTone({ enabled: true, ...blank }, { personaId: 'nova' })).toBe(toneSection(nova));
    expect(deliveredTone({ enabled: true, ...blank }, { personaId: 'orion' })).toBe(PERSONA_RESET);
    expect(deliveredTone({ enabled: false, ...blank }, { personaId: 'nova' })).toBe(PERSONA_RESET);
    expect(deliveredTone({ enabled: true, ...blank }, { personaId: 'gone' })).toBe(PERSONA_RESET);
    expect(deliveredTone({ enabled: true, ...blank }, { personaId: null })).toBeNull();
    expect(PERSONA_RESET).toContain('ignore any earlier Persona section');
  });
});

describe('personas in the flow (architecture.md § Personas)', () => {
  const withRoster = (enabled = true, personas = roster) => {
    const base = settings({ sessions: { codeMode: true, concurrency: 5 } });

    return { ...base, voice: { ...base.voice, enabled, ...personas } };
  };
  const start = (actions: FlowAction[]): Extract<FlowAction, { type: 'start-session' }> => {
    const found = actions.find((action) => action.type === 'start-session');

    if (found?.type !== 'start-session') {
      throw new Error('No start-session action.');
    }

    return found;
  };
  const adhoc = (h: Harness, prompt = 'Write hello.txt') => start(h.act({ type: 'adhoc', prompt, repoRoot: 'D:/scratch', start: true }));
  const question = (h: Harness, key: string) => {
    const [triage] = h.poll(issue(key));

    h.triaged(triage, 'dev:question');

    return start(h.act({ type: 'start', workItemId: h.store.findTicket('github', key)!.id }));
  };

  it('gives a session no persona and no tone section with an empty roster', () => {
    const h = new Harness({ settings: withRoster(true, { personas: [], playbookPersonas: {} }) });
    const action = adhoc(h);

    expect(action.tone).toBeUndefined();
    expect(h.store.session(action.sessionId)).toMatchObject({ personaId: null, personaVersion: null });
  });

  it("resolves a Code Mode session's persona at its start: the playbook's, else a free one from the pool", () => {
    const h = new Harness({ settings: withRoster() });
    const first = adhoc(h, 'First');
    const second = adhoc(h, 'Second');
    const asked = question(h, '7');

    expect(first.tone).toBe(toneSection(nova));
    expect(h.store.session(first.sessionId)).toMatchObject({ personaId: 'nova', personaVersion: toneVersion(toneSection(nova)) });
    expect(h.store.session(second.sessionId)?.personaId).toBe('orion');
    expect(h.store.session(asked.sessionId)?.personaId).toBe('orion');
    expect(asked.tone).toBe(toneSection(orion));
  });

  it('resolves a persona with voice off but gives the prompt no tone section', () => {
    const h = new Harness({ settings: withRoster(false) });
    const action = adhoc(h);

    expect(action.tone).toBeUndefined();
    expect(h.store.session(action.sessionId)).toMatchObject({ personaId: 'nova', personaVersion: null });
  });

  it('gives a held session without Code Mode a persona as a Code Mode session gets one', () => {
    const base = withRoster();
    const h = new Harness({ settings: { ...base, sessions: { ...base.sessions, codeMode: false } } });
    const action = adhoc(h);

    expect(action).toMatchObject({ codeMode: true, withoutCodeMode: true });
    expect(action.tone).toContain('## Persona');
    expect(h.store.session(action.sessionId)?.personaId).not.toBeNull();
  });

  it('records the tone section a resume or the contract hook delivers', () => {
    const h = new Harness({ settings: withRoster() });
    const action = adhoc(h);

    // A session pinned to another persona before pins were removed keeps it (store migration 2026-11-26).
    h.store.updateSession(action.sessionId, { personaId: 'orion' });
    h.act({ type: 'persona-delivered', sessionId: action.sessionId });
    expect(h.store.session(action.sessionId)?.personaVersion).toBe(toneVersion(toneSection(orion)));

    h.store.updateSession(action.sessionId, { personaId: 'nova' });
    h.store.updateSession(action.sessionId, { state: 'ended' });
    h.act({ type: 'held-resuming', sessionId: action.sessionId, launchId: 'launch-2' });
    expect(h.store.session(action.sessionId)).toMatchObject({ launchId: 'launch-2', personaVersion: toneVersion(toneSection(nova)) });
  });
});

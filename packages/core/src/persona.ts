import type { Persona, VoiceSettings } from './settings.js';

/** What a session's persona fields resolve from: the roster and the playbooks' personas. */
export type PersonaSettings = Pick<VoiceSettings, 'personas' | 'playbookPersonas'>;

/** The roster's persona with this ID, or null for none or one no longer in the roster. */
export function personaById(settings: PersonaSettings, id: string | null | undefined): Persona | null {
  return id == null ? null : (settings.personas.find((persona) => persona.id === id) ?? null);
}

/**
 * The persona a new session takes (architecture.md § Personas): its playbook's, else a persona of the roster no live session has, else the one
 * the fewest live sessions have, earlier in the roster first; null with an empty roster. `live` holds the persona IDs of the other live sessions,
 * one per session.
 */
export function resolvePersona(settings: PersonaSettings, playbook: string | null, live: ReadonlyArray<string | null | undefined>): Persona | null {
  const assigned = playbook === null ? null : personaById(settings, settings.playbookPersonas[playbook]);

  if (assigned !== null) {
    return assigned;
  }

  let best: Persona | null = null;
  let fewest = Infinity;

  for (const persona of settings.personas) {
    const uses = live.filter((id) => id === persona.id).length;

    if (uses < fewest) {
      best = persona;
      fewest = uses;
    }
  }

  return best;
}

/**
 * The tone section of a Code Mode session's prompt (architecture.md § Personas): who the session is and how it sounds, never how it works. Null
 * for no persona or one with no personality.
 */
export function toneSection(persona: Persona | null): string | null {
  if (persona === null || persona.personality === '') {
    return null;
  }

  return `## Persona
In this session you are ${persona.name}. ${persona.personality}

This sets only your tone: how your replies sound. It never changes how you do the work: what you decide, how you check it, what you report, or the length and format of your replies. If more than one Persona section reaches you, follow the last one.`;
}

/** A short hash of a tone section, stored as the session's `personaVersion` when the section reaches its prompt; null for no section. */
export function toneVersion(section: string | null): string | null {
  if (section === null) {
    return null;
  }

  // FNV-1a, 32 bits: enough to tell one section from the next, with no crypto import in a module the extension loads.
  let hash = 0x811c9dc5;

  for (let index = 0; index < section.length; index++) {
    hash ^= section.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}

/** Given in place of a tone section where an earlier one may still be in the prompt, so it stops applying. */
export const PERSONA_RESET = `## Persona
No persona applies in this session any more: ignore any earlier Persona section.`;

/**
 * The text a resume or the contract hook gives a session's prompt: its tone section, or, for a session that has a persona whose section is now
 * none (no personality, a persona gone from the roster, or voice off), `PERSONA_RESET`, since a compaction keeps the launch's earlier section.
 */
export function deliveredTone(voice: Pick<VoiceSettings, 'enabled'> & PersonaSettings, session: { personaId?: string | null }): string | null {
  return sessionTone(voice, session) ?? (session.personaId == null ? null : PERSONA_RESET);
}

/**
 * The tone section a session's prompt should carry now: its stored persona's while `voice.enabled` is on, else none, since personas are part of
 * voice.
 */
export function sessionTone(voice: Pick<VoiceSettings, 'enabled'> & PersonaSettings, session: { personaId?: string | null }): string | null {
  return voice.enabled ? toneSection(personaById(voice, session.personaId)) : null;
}

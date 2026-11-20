import type { ConversationMessage, Session } from '@switchboard/core';
import type { ConversationChange, InputOutcome, SessionInput, SlashCommand } from '@switchboard/conversation';

export type SendGuard = NonNullable<Parameters<SessionInput['send']>[2]>;
export type ResolveGuard = Parameters<SessionInput['resolve']>[4];
export type ConversationChanged = (sessionId: string, change: ConversationChange) => void;
export type DeliveryOutcome = InputOutcome | { delivery: 'uncertain'; error: string };

export interface NativeRequest {
  id: string;
  title: string;
  kind: 'question' | 'permission' | 'unsupported';
  questions: Array<{ id: string; question: string; options: string[]; secret?: boolean }>;
  decisions: string[];
}

/** Provider mechanics only. The service owns scope checks, storage delivery, streams, unread, artifacts and speech. */
export interface ConversationAdapter {
  supports(session: Session): boolean;
  poll(sessions: Session[]): Promise<void>;
  readEnded(session: Session): void;
  send(session: Session, message: ConversationMessage, text: string, done: (outcome: DeliveryOutcome) => void, guard: SendGuard): void;
  resolve(message: ConversationMessage, text: string, done: (outcome: DeliveryOutcome) => void, guard: ResolveGuard): void;
  commands(session: Session): SlashCommand[];
  cannotSend(session: Session): string | null;
  close(): void;
  requests?(session: Session): NativeRequest[];
  answer?(session: Session, id: string, answer: unknown): Promise<void>;
}

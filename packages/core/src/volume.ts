import type { Ticket, Immediacy, Severity } from './model.js';

export interface TicketClassification {
  ticketId: number;
  playbook: string;
  immediacy: Immediacy | null;
  severity: Severity | null;
  at: number;
}

export interface VolumeSource {
  source: string;
  startedAt: number;
  lastAt: number;
  interval: number;
  timezone: string;
}

export interface VolumeData {
  classifications?: TicketClassification[];
  sources: VolumeSource[];
  tickets: Ticket[];
  changes: { ticketId: number; at: number; fields: Record<string, [unknown, unknown]> }[];
  worked: { ticketId: number; at: number }[];
  gaps: { source: string; from: number; to: number }[];
}

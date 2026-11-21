/**
 * The views the hub sends the web page, checked against the fields the page reads (`@switchboard/protocol`, architecture.md § Conversation API):
 * a hub view that no longer carries one of them fails the hub's build, so the page's types cannot drift from what the hub sends.
 */

import type { ScreenPrompt } from '@switchboard/conversation';
import type * as Page from '@switchboard/protocol';
import type { NativeRequest } from './conversationAdapter.js';
import type { ArtifactView, ConversationEntry, MessageView, ReplyView, ScopeView, SessionView, StatusView } from './conversation.js';
import type { DockSourceGroup } from './dock.js';
import type { CATEGORIES, Entry, HistoryView, Section } from './history.js';
import type { PageAction, PageHeader, PageListGroup, PageRow } from './page.js';
import type { VoiceView } from './voice.js';

/** `Sent`, which must carry every field `Read` has, with types the page accepts. */
type Carries<Sent extends Read, Read> = Sent;

export type PageProtocolChecks = [
  Carries<SessionView, Page.SessionView>,
  Carries<NativeRequest, Page.NativeRequest>,
  Carries<ConversationEntry, Page.ConversationEntry>,
  Carries<ScopeView, Page.ScopeView>,
  Carries<MessageView, Page.MessageView>,
  Carries<ReplyView, Page.ReplyView>,
  Carries<StatusView, Page.StatusView>,
  Carries<ArtifactView, Page.ArtifactView>,
  Carries<VoiceView, Page.VoiceView>,
  Carries<PageRow, Page.PageRow>,
  Carries<PageAction, Page.PageAction>,
  Carries<PageListGroup, Page.PageGroup>,
  Carries<PageHeader, Page.PageHeader>,
  Carries<DockSourceGroup, Page.SourceGroup>,
  Carries<(typeof CATEGORIES)[number], Page.HistoryCategory>,
  Carries<HistoryView, Page.HistoryView>,
  Carries<Section, Page.HistorySection>,
  Carries<Entry, Page.HistoryEntry>,
  Carries<Entry['links'][number], Page.HistoryLink>,
  Carries<ScreenPrompt, Page.ScreenPrompt>,
];

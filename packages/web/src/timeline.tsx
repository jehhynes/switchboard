// The Conversation tab (architecture.md § Web page): our messages, the replies with their primary responses and question cards, artifact rows, the
// turn row, and the prompt or Codex request the session waits on.
import type { VNode } from 'preact';
import { fullTime, metaLine, spokenMark, stamped, toneMark, voiceMark } from '@switchboard/conversation/messageMeta';
import { hasUnspokenText, replyBody } from '@switchboard/conversation/replyBody';
import { answerSummary, plain, questionLedger, stripQuestionMarkup, withoutEndingQuestions } from '@switchboard/conversation/questions';
import type { LedgerItem, LedgerQuestion, QuestionLedger } from '@switchboard/conversation/questions';
import { isAnswerMessage, renderAnswersBubble, renderQuestionCard } from '@switchboard/conversation/questionCard';
import { artifactIcon, awaitingReply, inTurn, timeline } from './model.js';
import type { PageState } from './model.js';
import { copyButton, renderInline, renderMarkdown } from './markdown.js';
import { dayLabel, deliveryMark, replyRender, withoutQuestions } from './render.js';
import type { CardDraft, View } from './render.js';
import { trusted } from './trusted.js';
import { backgroundLabel } from '@switchboard/core/group';
import type { ArtifactView, MessageView, NativeRequest, ReplyView, ScreenPrompt } from '@switchboard/protocol';

/**
 * One of our messages: its bubble over its meta line (`metaLine`, shared with the Conversation view). A failed delivery always shows; with
 * message details on, a dictated message's mark too. A message with no meta line has its time as the bubble's tooltip.
 */
function Message({ item, stamped: shown, details, answered }: { item: MessageView; stamped: boolean; details: boolean; answered: LedgerQuestion[] }) {
  const meta = metaLine([voiceMark(item, details), deliveryMark(item)], item.at, shown);
  // An answer message shows as the Answers bubble; any other message that answered questions, as one typed "slug B", quotes them above it.
  const bubble = isAnswerMessage(item.text);

  return (
    <li class={`message${item.provisional ? ' provisional' : ''}`} data-id={item.id}>
      <div class="bubble" title={meta === '' ? fullTime(item.at) : undefined}>
        {bubble || answered.length === 0 ? null : <AnswerReference card={answered[0]!.card} lines={answered} />}
        {bubble ? (
          <div class="box answers">{trusted(renderAnswersBubble(item.text, answered))}</div>
        ) : (
          <div class={`box${/^\/[\w:.-]+(\s|$)/.test(item.text) ? ' command' : ''}`}>{item.text}</div>
        )}
        {trusted(meta)}
      </div>
    </li>
  );
}

/** Above a message that answered questions: a quoted line per question, which goes to its card. */
function AnswerReference({ card, lines: answered }: { card: string; lines: LedgerQuestion[] }) {
  const lines = answered.map((one) => ({ question: plain(one.question.text), answer: one.answer === null ? '' : answerSummary(one.question, one.answer.letters, one.answer.other, one.state === 'dismissed') }));

  return (
    <button type="button" class="answer-ref" data-action="goto-card" data-target-card={card} title="Show the questions">
      {lines.map((line) => (
        <span class="answer-ref-line">
          <span class="answer-ref-mark" aria-hidden="true">
            ↳
          </span>
          <span class="answer-ref-question">{line.question}</span>
          <span class="answer-ref-answer">→ {line.answer}</span>
        </span>
      ))}
    </button>
  );
}

function Reply({ item, earlier, view, stamped: shown, card, briefReplies }: { item: ReplyView; earlier: ReplyView | null; view: View; stamped: boolean; card: VNode | null; briefReplies: boolean }) {
  if (item.kind === 'note') {
    return (
      <li class="note" data-id={item.id}>
        {item.opening}
      </li>
    );
  }

  // Focused mode, as in the Conversation view, with Brief replies on: a reply shows its primary response first, spoken or not, and its details behind Show more. The
  // primary response keeps its place when the whole reply shows; after the operator spoke over it, the part not heard is dimmed.
  const passage = item.kind === 'reply' && item.speak !== null && item.speak.trim() !== '' ? item.speak : null;
  // Question ids and withdraw lines are for the view and the session, not the operator.
  const opening = stripQuestionMarkup(item.opening);
  // The questions that end a reply show in its card, so they alone give Show more nothing to show.
  const folded = passage !== null && hasUnspokenText(card === null ? opening : withoutEndingQuestions(opening), passage);
  // Show more opens a reply for good: an open reply has nothing to fold it again.
  const expanded = !folded || !briefReplies || view.open.has(`more:${item.id}`);
  // Only the text that ends the reply can end in the card's questions, which it leaves out; questions before a passage fold into one line.
  const markdownPart = (text: string, last: boolean): string => (card === null ? renderMarkdown(text) : withoutQuestions(text, last ? `reply:${item.id}` : `reply:${item.id}:before`, view.open, last));
  const said = item.spoken.state === 'interrupted' ? item.spoken.saidChars : null;
  const body = passage === null ? markdownPart(opening, true) : replyBody(opening, passage, said, !expanded, replyRender(markdownPart));
  const tone = toneMark(item.tone, view.details);
  // The copy button comes first on the line under the reply, then the tone and a speech failure with message details on, and the time at the right.
  const meta = metaLine([item.provisional ? '' : copyButton('copy-reply', 'Copy response'), tone, spokenMark(item.spoken.state, view.details)], item.at, shown);

  return (
    <li class={`reply ${item.kind}${item.unread ? ' unread' : ''}`} data-unread={item.unread ? item.id : undefined} data-id={item.id} data-speak={item.speak === null ? undefined : '1'} tabIndex={-1}>
      <span class="dot" title={item.unread ? 'Unread' : undefined}></span>
      <div class="body">
        {trusted(body)}
        {expanded ? null : (
          <button class="show-more" type="button" data-action="more" data-reply={item.id} aria-expanded="false">
            Show more
          </button>
        )}
        {earlier === null ? null : (
          <details class="fold" data-fold={`earlier:${item.id}`} open={view.open.has(`earlier:${item.id}`)}>
            <summary>Rewritten</summary>
            <div class="was">{trusted(renderMarkdown(earlier.opening))}</div>
          </details>
        )}
      </div>
      {trusted(meta)}
      {card}
    </li>
  );
}

function ArtifactRow({ artifact }: { artifact: ArtifactView }) {
  return (
    <li class="artifact">
      <button class="artifact-open" type="button" data-action="artifact" data-path={artifact.path} title={artifact.path}>
        <span class={`codicon codicon-${artifactIcon(artifact.type)}`} aria-hidden="true"></span>
        <span class="artifact-title">{artifact.title}</span>
        <span class="artifact-kind">{artifact.kind}</span>
      </button>
    </li>
  );
}

/** A radio's or a checkbox's mark, filled when checked. */
function Mark({ multi, checked }: { multi: boolean; checked: boolean }) {
  return multi ? (
    <span class={`question-mark checkbox${checked ? ' checked' : ''}`} aria-hidden="true">
      {checked ? <span class="codicon codicon-check"></span> : null}
    </span>
  ) : (
    <span class={`question-mark radio${checked ? ' checked' : ''}`} aria-hidden="true">
      {checked ? <span class="radio-dot"></span> : null}
    </span>
  );
}

let ledgerOf: { items: PageState['items']; since: number | null; dismissed: string; ledger: QuestionLedger } | null = null;

/** The question ledger of the page's conversation (PRD R103), worked out again only when its items or the hub's questions change. */
export function pageLedger(state: PageState): QuestionLedger {
  const since = state.questions?.since ?? null;
  const dismissed = (state.questions?.dismissed ?? []).map((one) => `${one.key}@${one.at}`).join(' ');

  if (ledgerOf === null || ledgerOf.items !== state.items || ledgerOf.since !== since || ledgerOf.dismissed !== dismissed) {
    // Until the hub says where the cutover is, every card follows the rules from before it, so no old card shows open.
    ledgerOf = { items: state.items, since, dismissed, ledger: questionLedger(state.items as unknown as LedgerItem[], { since: since ?? Number.POSITIVE_INFINITY, dismissed: state.questions?.dismissed ?? [] }) };
  }

  return ledgerOf.ledger;
}

/** The card with this key, drawn by the renderer the Conversation view shares; null for a reply that asks no questions. */
export function cardOf(key: string, ledger: QuestionLedger, view: View, state: PageState, canAnswer: boolean): VNode | null {
  const card = ledger.cards.get(key);

  if (card === undefined) {
    return null;
  }

  const ui = view.cards.get(key);
  const draft = ui?.local ?? state.questions?.drafts[key];
  const ended = state.session?.state === 'ended' || state.session?.conversation !== 'full';

  return <>{trusted(
    renderQuestionCard(card, draft, {
      canAnswer,
      note: ended && card.questions.some((one) => one.state === 'open') ? 'Session ended — open in terminal to continue.' : null,
      sending: ui?.sending === true,
      error: ui?.error ?? null,
      menuOpen: ui?.menuOpen === true,
      inline: renderInline,
    }),
  )}</>;
}

/** The local midnight starting the day of a time. */
function startOfDay(at: number): number {
  const date = new Date(at);

  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The Conversation tab: why the page cannot talk to the session, earlier messages, and the timeline with its spinner. */
export function renderTimeline(state: PageState, view: View, now: number = Date.now()): VNode {
  if (state.session === null) {
    return <p class="empty">No session yet. Messages appear here once the work item's session starts.</p>;
  }

  const entries = timeline(state.items, state.artifacts);
  const canAnswer = state.connected && state.session.conversation === 'full';
  const links = pageLedger(state);
  // After the newest item, so replies written mid-turn show above it.
  const shownPrompt = view.prompt !== null && view.prompt.sessionId === state.session.id ? view.prompt : null;
  const spinner = turnRow(state.session, inTurn(state.session) || awaitingReply(state.items, state.session), shownPrompt?.prompt != null) ?? backgroundRow(state.session);
  let lastDay: number | null = null;
  const rows = entries.flatMap((entry) => {
    if (entry.type === 'artifact') {
      return [<ArtifactRow key={`artifact:${entry.artifact.path}`} artifact={entry.artifact} />];
    }

    // The first item shown, and each turn that starts on a later day than the turns before it, has a divider. The order is the transcript's, not
    // the items' times, so an item dated before the ones above it, such as one still queued from days ago, starts no divider back in time.
    const day = startOfDay(entry.item.at);
    const divider =
      (lastDay === null || (entry.type === 'message' && day > lastDay)) ? (
        <li class="day" role="separator" key={`day:${day}`}>
          {dayLabel(entry.item.at, now)}
        </li>
      ) : null;

    lastDay = divider !== null ? day : lastDay;

    // The first item after a day's divider shows its time; with message details on, every item does.
    const timed = entry.type === 'message' || entry.item.kind !== 'note';
    const shown = stamped(timed, view.details, divider !== null);
    const row =
      entry.type === 'message' ? (
        <Message key={entry.item.id} item={entry.item} stamped={shown} details={view.details} answered={links.answers.get(entry.item.id) ?? []} />
      ) : (
        <Reply key={entry.item.id} item={entry.item} earlier={entry.earlier} view={view} stamped={shown} card={entry.item.kind === 'reply' ? cardOf(`reply:${entry.item.id}`, links, view, state, canAnswer) : null} briefReplies={view.briefReplies ?? state.briefReplies} />
      );

    return divider === null ? [row] : [divider, row];
  });
  const requests = state.session.requests ?? [];

  return (
    <>
      {/* An ended session's reason shows above the composer instead. */}
      {state.session.reason === null || state.session.state === 'ended' ? null : <p class="notice">{state.session.reason}</p>}
      {state.more ? (
        <button class="earlier-items" type="button" data-action="earlier">
          Show earlier messages
        </button>
      ) : null}
      {rows.length === 0 && spinner === null ? (
        <p class="empty">No messages yet. They appear here when you or the session write one.</p>
      ) : (
        <ol class="timeline" aria-label="Conversation">
          {rows}
          {spinner}
        </ol>
      )}
      {requests.length > 0
        ? requests.map((request) => renderRequest(request, view.requestValues))
        : shownPrompt?.prompt != null && state.session.state === 'waiting'
          ? renderPrompt(shownPrompt.prompt, state.session.waitingFor, shownPrompt.sending)
          : null}
    </>
  );
}

/**
 * The row at the end of the timeline while the session is in a turn: "Starting…" or "Thinking…" with the spinner while it works on a reply;
 * while it waits on the operator in the terminal, "Waiting for your answer", "Waiting for permission" or "Waiting in the terminal" with a still
 * icon in the warning colour, since the page has no terminal to open. A Codex request the page answers draws its own card instead.
 */
export function turnRow(session: PageState['session'], awaiting: boolean, prompted = false): VNode | null {
  if (session?.state === 'waiting' && session.waitingFor !== null && (session.requests ?? []).length === 0) {
    const label = session.waitingFor === 'question' ? 'Waiting for your answer' : session.waitingFor === 'permission' ? 'Waiting for permission' : 'Waiting in the terminal';
    const icon = session.waitingFor === 'permission' ? 'shield' : session.waitingFor === 'question' ? 'question' : 'terminal';
    const who = session.provider === 'codex' ? 'Codex' : 'Claude';

    return (
      <li class="working waiting" role="status" key="turn">
        <span class={`codicon codicon-${icon}`} aria-hidden="true"></span>
        <span class="working-label">{label}</span>
        <span class="working-detail">
          {who} asks in its terminal; {prompted ? 'answer it below.' : 'answer it there.'}
        </span>
      </li>
    );
  }

  // A Codex request draws its own card, which may come before the session's waiting state.
  if (!awaiting || session === null || (session.requests ?? []).length > 0) {
    return null;
  }

  return (
    <li class="working" key="turn">
      <span class={`codicon codicon-loading${session.state === 'waiting' ? '' : ' codicon-modifier-spin'}`} aria-hidden="true"></span>
      <span>{session.state === 'starting' ? 'Starting' : 'Thinking'}…</span>
    </li>
  );
}

/**
 * The row at the end of the timeline while the session's turn has ended and its background agents or shell commands run, such as "3 agents
 * running", with the spinner, until they finish. A turn row, as for a message sent meanwhile, comes first.
 */
export function backgroundRow(session: PageState['session']): VNode | null {
  const background = session?.background ?? null;

  if (background === null) {
    return null;
  }

  return (
    <li class="working background" role="status" key="turn">
      <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
      <span class="working-label">{backgroundLabel(background)}</span>
    </li>
  );
}

/**
 * A permission prompt or question form a Claude session waits on in its terminal, as its screen shows it (architecture.md § Web page): the
 * prompt's lines, a button per numbered option, which presses its digit, Next (→) on a question form, and Cancel (Esc). Typed answers stay in the
 * terminal.
 */
export function renderPrompt(prompt: ScreenPrompt, waitingFor: string | null, sending: boolean): VNode {
  const title = waitingFor === 'permission' ? 'Claude asks for permission' : 'Claude asks you';

  return (
    <div class="request question-card prompt-card" data-key="prompt" key="prompt" role="group" aria-label={title}>
      <div class="request-title">
        <span class={`codicon codicon-${waitingFor === 'permission' ? 'shield' : 'question'}`} aria-hidden="true"></span> {title}
      </div>
      <pre class="prompt-screen">{prompt.lines.join('\n')}</pre>
      <div class="prompt-options">
        {prompt.options.map((option) => (
          <button type="button" class={`prompt-option${option.selected ? ' current' : ''}`} data-action="prompt-key" data-prompt-key={option.key} disabled={sending}>
            <span class="question-letter">{option.key}</span> {option.label}
          </button>
        ))}
      </div>
      <div class="question-footer">
        {prompt.next ? (
          <button type="button" class="prompt-option secondary" data-action="prompt-key" data-prompt-key="next" disabled={sending}>
            Next →
          </button>
        ) : null}
        <button type="button" class="prompt-option secondary" data-action="prompt-key" data-prompt-key="escape" disabled={sending}>
          Cancel (Esc)
        </button>
        <span class="prompt-note">To type an answer, use the terminal.</span>
      </div>
    </div>
  );
}

const DECISIONS: Record<string, string> = { accept: 'Allow once', acceptForSession: 'Allow for session', decline: 'Decline', cancel: 'Cancel' };

/**
 * A Codex session's pending request: a permission with its decisions as buttons, or questions with their options and a field for a typed
 * answer, a secret one hidden; one the page cannot answer says to answer it in the terminal.
 */
export function renderRequest(request: NativeRequest, values: ReadonlyMap<string, string>): VNode {
  const head = (
    <div class="request-title">
      <span class={`codicon codicon-${request.kind === 'permission' ? 'shield' : 'question'}`} aria-hidden="true"></span> {request.title}
    </div>
  );
  const key = `request-${request.id}`;

  if (request.kind === 'unsupported') {
    return (
      <div class="request" data-key={key} key={key}>
        {head}
        <p class="empty">Answer it in the terminal.</p>
      </div>
    );
  }

  if (request.kind === 'permission') {
    return (
      <div class="request" data-key={key} key={key}>
        {head}
        <div class="request-actions">
          {request.decisions.map((decision) => (
            <button type="button" class="request-button" data-action="request-decision" data-request={request.id} data-decision={decision}>
              {DECISIONS[decision] ?? decision}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div class="request question-card" data-key={key} key={key}>
      {head}
      {request.questions.map((question) => {
        const field = `${request.id}:${question.id}`;
        const value = values.get(field) ?? '';

        return (
          <div class="question-block" data-key={field} key={field}>
            <div class="question-text">{question.question}</div>
            <div class="question-options">
              {question.options.map((option) => (
                <button type="button" class="question-option" role="radio" aria-checked={value === option} data-action="request-option" data-field={field} data-value={option}>
                  <Mark multi={false} checked={value === option} />
                  <span class="question-option-text">{option}</span>
                </button>
              ))}
              <input class="question-other request-field" type={(question.secret === true ? 'password' : 'text') as 'text'} data-field={field} placeholder={question.options.length === 0 ? 'Answer…' : 'Other…'} value={question.options.includes(value) ? '' : value} />
            </div>
          </div>
        );
      })}
      <div class="question-footer">
        <button type="button" class="question-submit" data-action="request-answer" data-request={request.id}>
          Submit
        </button>
      </div>
    </div>
  );
}

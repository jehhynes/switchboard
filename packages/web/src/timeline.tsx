// The Conversation tab (architecture.md § Web page): our messages, the replies with their spoken bubbles and question cards, artifact rows, the
// turn row, and the prompt or Codex request the session waits on.
import type { VNode } from 'preact';
import { fullTime, metaLine, stamped, toneMark, voiceMark } from '@switchboard/conversation/messageMeta';
import { hasUnspokenText, spokenBody } from '@switchboard/conversation/spokenBubble';
import { answers, answersIn, cardOutcome, complete, parseQuestions } from '@switchboard/conversation/questions';
import type { Question, QuestionChoice } from '@switchboard/conversation/questions';
import { artifactIcon, awaitingReply, timeline } from './model.js';
import type { PageState } from './model.js';
import { copyButton, renderInline, renderMarkdown } from './markdown.js';
import { dayLabel, deliveryMark, spokenMark, spokenRender, withoutQuestions } from './render.js';
import type { CardDraft, View } from './render.js';
import { trusted } from './trusted.js';
import type { ArtifactView, MessageView, NativeRequest, ReplyView, ScreenPrompt } from './types.js';

/**
 * One of our messages: its bubble over its meta line (`metaLine`, shared with the Conversation view). A failed delivery always shows; with
 * message details on, a dictated message's mark too. A message with no meta line has its time as the bubble's tooltip.
 */
function Message({ item, stamped: shown, details }: { item: MessageView; stamped: boolean; details: boolean }) {
  const meta = metaLine([voiceMark(item, details), deliveryMark(item)], item.at, shown);

  return (
    <li class={`message${item.provisional ? ' provisional' : ''}`} data-id={item.id}>
      <div class="bubble" title={meta === '' ? fullTime(item.at) : undefined}>
        <div class={`box${/^\/[\w:.-]+(\s|$)/.test(item.text) ? ' command' : ''}`}>{item.text}</div>
        {trusted(meta)}
      </div>
    </li>
  );
}

function Reply({ item, earlier, view, stamped: shown, card, expandReplies }: { item: ReplyView; earlier: ReplyView | null; view: View; stamped: boolean; card: VNode | null; expandReplies: boolean }) {
  if (item.kind === 'note') {
    return (
      <li class="note" data-id={item.id}>
        {item.opening}
      </li>
    );
  }

  // Focused mode, as in the Conversation view: a reply with a [speak] passage shows the passage first and the whole reply behind Show more. The
  // passage is a bubble on the left, in its place when the whole reply shows; after the operator spoke over it, the part not heard is dimmed.
  const passage = item.kind === 'reply' && item.speak !== null && item.speak.trim() !== '' ? item.speak : null;
  const folded = passage !== null && hasUnspokenText(item.opening, passage);
  const expanded = !folded || expandReplies !== view.open.has(`more:${item.id}`);
  // Only the text that ends the reply can end in the card's questions, which it leaves out; questions before a passage fold into one line.
  const markdownPart = (text: string, last: boolean): string => (card === null ? renderMarkdown(text) : withoutQuestions(text, last ? `reply:${item.id}` : `reply:${item.id}:before`, view.open, last));
  const said = item.spoken.state === 'interrupted' ? item.spoken.saidChars : null;
  const body = passage === null ? markdownPart(item.opening, true) : spokenBody(item.opening, passage, said, !expanded, spokenRender(markdownPart));
  const tone = toneMark(item.tone, view.details);
  // The copy button comes first on the line under the reply, then the tone with message details on and a speech failure, and the time at the right.
  const meta = metaLine([item.provisional ? '' : copyButton('copy-reply', 'Copy response'), tone, spokenMark(item)], item.at, shown);

  return (
    <li class={`reply ${item.kind}${item.unread ? ' unread' : ''}`} data-unread={item.unread ? item.id : undefined} data-id={item.id} data-speak={item.speak === null ? undefined : '1'}>
      <span class="dot" title={item.unread ? 'Unread' : undefined}></span>
      <div class="body">
        {trusted(body)}
        {!folded ? null : (
          <button class="show-more" type="button" data-action="more" data-reply={item.id} aria-expanded={expanded}>
            {expanded ? 'Show less' : 'Show more'}
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

/** A question card: each question with its options as radio or checkbox rows, an Other field, and Submit; greyed with its picks once answered. */
export function questionCard(key: string, questions: readonly Question[], draft: CardDraft | undefined, answer: string | null, canAnswer: boolean): VNode {
  // A later message answers the card only when it answers its questions; one that ignores them sets it aside, Skipped, with no picks.
  const outcome = cardOutcome(answer, questions);
  const answered = outcome !== null;
  const choices = outcome === 'answered' ? answersIn(answer!, questions) : answered ? new Map<number, QuestionChoice>() : (draft?.choices ?? new Map<number, QuestionChoice>());
  const locked = answered || !canAnswer || draft?.sending === true || draft?.sent != null;

  return (
    <div class={`question-card${answered ? ` ${outcome}` : ''}`} data-card-key={key}>
      {questions.map((question, index) => {
        const choice = choices.get(index);

        return (
          <div class="question-block">
            <div class="question-text">
              {question.number === null ? null : `${question.number}. `}
              {trusted(renderInline(question.text))}
            </div>
            <div class="question-options">
              {question.options.map((option) => {
                const checked = choice?.letters.includes(option.letter) ?? false;

                return (
                  <button type="button" class={`question-option${answered && !checked ? ' dimmed' : ''}`} role={question.multi ? 'checkbox' : 'radio'} aria-checked={checked} data-action="pick" data-card={key} data-question={String(index)} data-letter={option.letter} disabled={locked}>
                    <Mark multi={question.multi} checked={checked} />
                    <span class="question-option-text">
                      <span class="question-letter">{option.letter}</span> {trusted(renderInline(option.text))}
                    </span>
                  </button>
                );
              })}
              {answered || !canAnswer ? (
                choice?.other ? <div class="question-answer-other">Other: {choice.other}</div> : null
              ) : (
                <input class="question-other" type="text" data-card={key} data-question={String(index)} placeholder="Other…" value={choice?.other ?? ''} disabled={locked} />
              )}
            </div>
          </div>
        );
      })}
      <div class="question-footer">
        {answered ? (
          <span class="question-state">{outcome === 'answered' ? 'Answered' : 'Skipped: your next message did not answer these questions'}</span>
        ) : !canAnswer ? null : (
          <>
            {draft?.error ? <span class="question-error">{draft.error}</span> : null}
            {draft?.sent != null ? <span class="question-state">Sending…</span> : null}
            <button type="button" class="question-submit" data-action="answer" data-card={key} disabled={locked || !complete(questions, choices)}>
              Submit
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** The card of a reply's or a status's questions, answered by the first message after it; null without questions. */
export function cardOf(key: string, markdown: string, answer: string | null, view: View, canAnswer: boolean): VNode | null {
  const questions = parseQuestions(markdown);

  return questions.length === 0 ? null : questionCard(key, questions, view.cards.get(key), answer, canAnswer);
}

/** The text of the first message after a reply, which answers its card. */
function answerAfter(state: PageState, replyId: string): string | null {
  const from = state.items.findIndex((item) => item.id === replyId);
  const later = from === -1 ? undefined : state.items.slice(from + 1).find((item) => item.type === 'message' && answers(item));

  return later?.type === 'message' ? later.text : null;
}

/** The Conversation tab: why the page cannot talk to the session, earlier messages, and the timeline with its spinner. */
export function renderTimeline(state: PageState, view: View, now: number = Date.now()): VNode {
  if (state.session === null) {
    return <p class="empty">No session yet. Messages appear here once the work item's session starts.</p>;
  }

  const entries = timeline(state.items, state.artifacts);
  const canAnswer = state.connected && state.session.conversation === 'full';
  // After the newest item, so replies written mid-turn show above it.
  const shownPrompt = view.prompt !== null && view.prompt.sessionId === state.session.id ? view.prompt : null;
  const spinner = turnRow(state.session, awaitingReply(state.items, state.session), shownPrompt?.prompt != null);
  let lastDay: string | null = null;
  const rows = entries.flatMap((entry) => {
    if (entry.type === 'artifact') {
      return [<ArtifactRow key={`artifact:${entry.artifact.path}`} artifact={entry.artifact} />];
    }

    // The first item shown, and each turn that starts on another day than the turn before it, has a divider.
    const day = new Date(entry.item.at).toDateString();
    const divider =
      day !== lastDay && (lastDay === null || entry.type === 'message') ? (
        <li class="day" role="separator" key={`day:${day}`}>
          {dayLabel(entry.item.at, now)}
        </li>
      ) : null;

    lastDay = entry.type === 'message' || lastDay === null ? day : lastDay;

    // The first item after a day's divider shows its time; with message details on, every item does.
    const timed = entry.type === 'message' || entry.item.kind !== 'note';
    const shown = stamped(timed, view.details, divider !== null);
    const row =
      entry.type === 'message' ? (
        <Message key={entry.item.id} item={entry.item} stamped={shown} details={view.details} />
      ) : (
        <Reply key={entry.item.id} item={entry.item} earlier={entry.earlier} view={view} stamped={shown} card={entry.item.kind === 'reply' ? cardOf(`reply:${entry.item.id}`, entry.item.opening, answerAfter(state, entry.item.id), view, canAnswer) : null} expandReplies={state.expandReplies} />
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

  if (!awaiting || session === null) {
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

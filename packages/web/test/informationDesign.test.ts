import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY, sessionEnd, timeline } from '../src/model.js';
import { cardNote, renderPrompt } from '../src/timeline.js';
import { renderEndedNote } from '../src/composer.js';
import { html } from './html.js';
import type { PageState } from '../src/model.js';
import type { ArtifactView, MessageView, SessionView } from '@switchboard/protocol';

const css = readFileSync(join(import.meta.dirname, '../src/page.css'), 'utf8');
const cardCss = readFileSync(join(import.meta.dirname, '../../conversation/src/questionCard.css'), 'utf8');
/** The declarations of the stylesheet's first rule whose selector list is exactly `selector`. */
const rule = (sheet: string, selector: string): string => {
  const start = sheet.indexOf(`\n${selector} {`);

  return start === -1 ? '' : sheet.slice(sheet.indexOf('{', start) + 1, sheet.indexOf('}', start));
};
const message = (id: string, at: number): MessageView => ({ type: 'message', id, sessionId: 's', workItemId: 1, at, ord: at, provisional: false, withdrawn: false, origin: 'typed', text: id, delivery: 'sent', error: null });
const artifact = (path: string, updatedAt: number): ArtifactView => ({ path, owner: 'chat', kind: 'page', title: path, ext: 'md', type: 'markdown', updatedAt });
const session = (patch: Partial<SessionView> = {}): SessionView => ({ id: 's', title: 'Task session s', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, ...patch });
/** A page showing work item 1, whose current session started at 300 after earlier sessions e2 (200) and e1 (100), shown as `shown`. */
const showing = (shown: string | null, current: { sessionStartedAt?: number } = { sessionStartedAt: 300 }): PageState => ({
  ...EMPTY,
  connected: true,
  session: session(),
  scope: {
    kind: 'page',
    key: 'k',
    folder: 'D:/w',
    title: 'Fix it',
    scopeGen: 1,
    workItemId: 1,
    cwd: 'D:/w',
    sessionId: shown ?? 's',
    ...(shown === null ? {} : { earlier: true }),
    conversations: [
      {
        workItemId: 1,
        title: 'Fix it',
        primary: true,
        sessionId: 's',
        state: 'idle',
        conversation: 'full',
        unread: 0,
        ...current,
        sessions: [
          { sessionId: 'e2', title: 'Task session e2', state: 'ended', startedAt: 200 },
          { sessionId: 'e1', title: 'Setup session', state: 'ended', startedAt: 100 },
        ],
      },
    ],
  },
});

describe('a session that takes no answers', () => {
  it('CardNote_EarlierSession_SaysItIsReadOnly', () => {
    expect(cardNote({ ...showing('e1'), session: session({ state: 'ended', conversation: 'read-only' }) })).toBe('Earlier session, read-only.');
  });

  it('CardNote_EndedSessionThePageResumes_PointsToResume', () => {
    expect(cardNote({ ...showing(null), session: session({ state: 'ended', conversation: 'read-only', reason: 'The session has ended. Resume it to send a message.' }) })).toBe('Resume the session to answer.');
  });

  it('CardNote_EndedCodexThreadThatTakesAnswers_SaysNothing', () => {
    expect(cardNote({ ...showing(null), session: session({ state: 'ended', conversation: 'full' }) })).toBeNull();
    expect(cardNote({ ...showing(null), session: session() })).toBeNull();
  });

  it('CardNote_SessionThePageCannotTalkTo_SaysItsReasonAndNoTerminal', () => {
    const reason = 'This session runs in your own Claude window; talk to it there.';

    expect(cardNote({ ...showing(null), session: session({ state: 'ended', conversation: 'none', reason }) })).toBe(reason);
    expect(cardNote({ ...showing(null), session: session({ conversation: 'read-only', reason: 'Switchboard cannot track this session while Install hooks is off.' }) })).toBe('Switchboard cannot track this session while Install hooks is off.');
    expect(cardNote({ ...showing(null), session: session({ state: 'ended', conversation: 'none' }) })).toBe('The session has ended.');
  });
});

describe("an earlier session's artifacts", () => {
  it('SessionEnd_EarlierSession_EndsWhereTheNextSessionStarted', () => {
    expect(sessionEnd(showing('e1'))).toBe(200);
    expect(sessionEnd(showing('e2'))).toBe(300);
  });

  it('SessionEnd_CurrentSessionOrNoStart_HasNoEnd', () => {
    expect(sessionEnd(showing(null))).toBe(Infinity);
    expect(sessionEnd(showing('e2', {}))).toBe(Infinity);
    expect(sessionEnd(showing('gone'))).toBe(Infinity);
  });

  it('Timeline_ArtifactLastWrittenInALaterSession_ShowsOnlyThere', () => {
    const items = [message('m1', 110), message('m2', 150)];
    const artifacts = [artifact('chat/setup.md', 180), artifact('chat/review.md', 320), artifact('chat/edge.md', 200)];
    const paths = (until: number) => timeline(items, artifacts, until).flatMap((entry) => (entry.type === 'artifact' ? [entry.artifact.path] : []));

    // Written after the earlier session's last message but before the next session started: still the earlier session's.
    expect(paths(200)).toEqual(['chat/setup.md']);
    expect(paths(Infinity)).toEqual(['chat/setup.md', 'chat/edge.md', 'chat/review.md']);
  });
});

describe('the marks and buttons that compete', () => {
  it('GroupCount_Drawn_UsesANeutralChipNotTheUnreadColour', () => {
    const rule = /^\.group-count \{[^}]*\}/m.exec(css)![0];

    expect(rule).toContain('background: color-mix(in srgb, var(--vscode-foreground) 20%, transparent); color: var(--vscode-foreground);');
    expect(rule).not.toContain('badge');
    expect(rule).not.toContain('focusBorder');
    expect(rule).not.toContain('activityBarBadge');
  });

  it('GroupCount_BlockedOnYou_UsesTheWarningColour', () => {
    const rules = css.match(/^[^\n{]*\.group-count[^\n{]*\{[^}]*\}/gm)!;

    expect(rules.filter((rule) => rule.includes('editorWarning'))).toEqual(['.group[data-group="blocked"] .group-count { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }']);
  });

  it('GroupCount_ReadyForReview_UsesTheAccentBadgeWhenNotZero', () => {
    const rules = css.match(/^[^\n{]*\.group-count[^\n{]*\{[^}]*\}/gm)!;

    expect(rules.filter((rule) => rule.includes('badge'))).toEqual(['.group[data-group="review"] .group-count:not(.zero) { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }']);
  });

  it('ReplyDot_Unread_StaysTheMutedBullet', () => {
    expect(css).toContain('.reply .dot {');
    expect(css).not.toMatch(/\.reply\.unread \.dot/);
  });

  it('SessionNoteButton_Drawn_IsSecondarySoTheHeaderControlIsTheOnePrimary', () => {
    const rule = /^\.session-resume \{[^}]*\}/m.exec(css)![0];

    expect(rule).toContain('background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);');
    expect(css).toMatch(/^\.header > button\.row-main \{[^}]*background: var\(--vscode-button-background\)/m);
  });
});

describe('the conversation status row and question card', () => {
  it('EndedNote_SessionThatTakesMessages_SaysSendOrResume', () => {
    const note = document.createElement('div');

    note.innerHTML = html(renderEndedNote(session({ state: 'ended', conversation: 'full' }), false));
    expect(note.querySelector('.session-note-text')!.textContent).toBe('The session has ended. Send a message or press Resume to continue it.');
    expect(note.querySelector('[data-action="resume"]')!.textContent).toBe('Resume');
  });

  it('EndedNote_ReadOnlySession_SaysResumeToSend', () => {
    const note = document.createElement('div');

    note.innerHTML = html(renderEndedNote(session({ state: 'ended', conversation: 'read-only', reason: 'The session has ended. Resume it to send a message.' }), false));
    expect(note.querySelector('.session-note-text')!.textContent).toBe('The session has ended. Resume it to send a message.');
    expect(note.querySelector('[data-action="resume"]')).not.toBeNull();
  });

  it('PromptCard_WithOptions_SaysAnswerHereOrInTheTerminal', () => {
    const card = document.createElement('div');

    card.innerHTML = html(renderPrompt({ id: 'p1', lines: [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'], options: [{ key: '1', label: 'Yes', selected: true }, { key: '2', label: 'No', selected: false }], next: false }, 'permission', false));
    expect(card.querySelectorAll('.prompt-option:not(.secondary)')).toHaveLength(2);
    expect(card.querySelector('.prompt-note')!.textContent).toBe('Answer here or in the terminal.');
  });

  it('PromptCard_NoOptions_SaysAnswerInTheTerminal', () => {
    const card = document.createElement('div');

    card.innerHTML = html(renderPrompt({ id: 'p2', lines: [' Type your answer:'], options: [], next: false }, 'question', false));
    expect(card.querySelectorAll('.prompt-option:not(.secondary)')).toHaveLength(0);
    expect(card.querySelector('.prompt-note')!.textContent).toBe('Answer it in the terminal.');
  });

  it('QuestionsChip_Stylesheet_FloatsCentred8PxOverTheComposerInTheGlass', () => {
    const chip = rule(css, '.question-waiting');

    expect(chip).toMatch(/position: absolute; z-index: 2; bottom: 100%; margin-bottom: 8px; left: 50%; transform: translateX\(-50%\)/);
    expect(rule(css, '#composer')).toMatch(/position: relative/);
    expect(rule(css, '.glass, .question-waiting')).toMatch(/backdrop-filter: blur\(8px\)/);
  });

  it('QuestionCard_Stylesheet_TopicIsNoLinkAndDisabledButtonsLoseTheAccentBorder', () => {
    expect(rule(cardCss, '.qc-topic')).toMatch(/color: var\(--vscode-descriptionForeground\)/);
    expect(rule(cardCss, '.qc-topic')).not.toMatch(/textLink/);
    expect(rule(cardCss, '.qc-primary:disabled, .qc-secondary:disabled')).toMatch(/border-color: transparent/);
  });
});

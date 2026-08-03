// A working app with nothing behind it, teaching itself as it goes.
//
// Before a server address is set there is nothing to show, and until now the
// app said so and stopped there. That is the whole of what an EVEN Hub
// reviewer sees — they have no herdr server and are not going to install one
// — so the app they were asked to judge was a paragraph of setup instructions.
//
// This is the same app with canned data behind it: the real session list, the
// real conversation, the real pickers, driven by the real controller and the
// real gestures. Nothing here draws anything of its own.
//
// What the data SAYS is a tutorial. A demo full of plausible work looks like a
// screenshot: a reviewer sees a workspace called `api-refactor` and learns
// nothing about what a workspace is, or which gesture opens it. So every
// string here names the thing it is sitting in - the workspaces say what a
// workspace row does, the transcript explains the transcript, the picker
// explains the picker. The panel is small and the ring has four gestures;
// nothing else on screen can carry that explanation.
//
// The words themselves live in `i18n.ts`, in both languages, and the language
// is the phone's own (a saved choice first, then `navigator.languages`). This
// is the one screen a wearer meets before anything is set up, so there is
// nowhere to go and change a setting first - and a tutorial in a language the
// reader does not have is not a tutorial.
//
// It does not pretend to be connected. Every screen carries DEMO, and the
// actions that would reach an agent say what they would have done instead.
// A demo that could be mistaken for the real thing would fail the same
// first-run rule this exists to satisfy.

import { t } from './i18n.ts'
import type { ConversationMessage, Session } from './types.ts'

/**
 * The list, as a lesson in reading the list.
 *
 * Each row's name is the gesture or the mark that row demonstrates: the one
 * that is waiting says a tap opens it, the one that is working carries the
 * context bar, the one with panes shows how panes are indented under their
 * workspace.
 *
 * Each carries an `agentSessionId` because a transcript is addressed to an
 * agent session rather than to a workspace. Without one the conversation
 * screen resolves to no target and opens empty - which is the screen the whole
 * demo leads to.
 */
export function demoSessions(): Session[] {
  return [
    {
      id: 'demo-open',
      agentSessionId: 'demo-open-thread',
      name: t('demo.open.name'),
      state: 'idle',
      // The state that makes the row worth opening: it is holding a question.
      indicatorState: 'waiting_input',
      agent: 'claude',
      ccRecap: t('demo.open.recap'),
    },
    {
      id: 'demo-working',
      agentSessionId: 'demo-working-thread',
      name: t('demo.working.name'),
      state: 'working',
      indicatorState: 'processing',
      agent: 'claude',
      ccRecap: t('demo.working.recap'),
    },
    {
      id: 'demo-panes',
      agentSessionId: 'demo-panes-thread',
      name: t('demo.panes.name'),
      state: 'idle',
      indicatorState: 'completed',
      agent: 'codex',
      panes: [
        { paneId: '%1', label: t('demo.panes.pane1'), agent: 'codex', indicatorState: 'completed' },
        { paneId: '%2', label: t('demo.panes.pane2'), agent: 'claude', indicatorState: 'processing' },
      ],
    },
    {
      id: 'demo-back',
      agentSessionId: 'demo-back-thread',
      name: t('demo.back.name'),
      state: 'idle',
      indicatorState: 'completed',
      agent: 'claude',
      ccRecap: t('demo.back.recap'),
    },
  ]
}

/**
 * The transcript, explaining the transcript.
 *
 * Short enough that the whole lesson is on the first page. A conversation
 * opens at its newest message, so anything that does not fit is behind the
 * swipe it is trying to explain - and four messages plus the recap is what
 * eight lines hold.
 *
 * It ends on a question, because that is what makes the next gesture worth
 * making: the tap that follows opens the picker, and the picker is the screen
 * with the most to teach.
 */
export function demoConversation(): ConversationMessage[] {
  return [
    { role: 'user', content: t('demo.conv.ask') },
    { role: 'assistant', content: t('demo.conv.paging') },
    {
      role: 'assistant',
      content: t('demo.conv.tool'),
      toolUse: [{ name: 'Read', input: { file_path: 'db/schema.sql' } }],
    },
    { role: 'assistant', content: t('demo.conv.answer') },
  ]
}

/**
 * The picker, explaining the picker.
 *
 * A multi-select rather than a single pick, because it is the screen with the
 * most to demonstrate - a cursor, a toggle, a count, and a row that sends -
 * and because each option can say what checking it does.
 */
export function demoChoices(): string[] {
  return [`[ ] ${t('demo.choice1')}`, `[ ] ${t('demo.choice2')}`, `[ ] ${t('demo.choice3')}`]
}

/**
 * What the recognizer hears.
 *
 * There is no server in a demo, and transcription is the server's job (Groq,
 * via `/api/glasses/stt`), so the microphone is not opened at all: a real
 * recording would have nowhere to go and the screen would arrive at "(nothing
 * was recognized)" every time - the gesture that matters most, demonstrated as
 * a failure.
 *
 * It describes the screen it appears on, like everything else here.
 */
export function demoTranscript(): string {
  return t('demo.transcript')
}

/** The answer, as the wearer's own turn. Spoken or picked - the transcript
 *  cannot tell the difference and neither should this. */
export function demoAnswer(text: string): ConversationMessage {
  return { role: 'user', content: text }
}

/**
 * What the agent does with it.
 *
 * Quoting the answer back is not decoration: it is the only thing on screen
 * that shows the words made it out of the panel and into the conversation,
 * which is the whole of what a wearer is checking when they answer from the
 * glasses. The rest of the line says where it would have gone, since here it
 * went nowhere.
 */
export function demoAgentReply(text: string): ConversationMessage {
  return { role: 'assistant', content: t('demo.reply', { text }) }
}

/**
 * The recap line, after an answer.
 *
 * It leads the conversation screen, and the demo's opening one says the
 * workspace is waiting - which stops being true the moment it is answered. A
 * tutorial that contradicts the screen under it teaches the wrong thing.
 */
export function demoRecap(state: 'processing' | 'completed'): string {
  return state === 'processing' ? t('demo.recap.processing') : t('demo.recap.completed')
}

/** How long the agent appears to think about it. Long enough that the reply is
 *  visibly an answer to what was just sent rather than something that was
 *  already there. */
export const DEMO_REPLY_MS = 1400

/** How long the transcription takes. The real one is a round trip to Groq. */
export const DEMO_TRANSCRIBE_MS = 700

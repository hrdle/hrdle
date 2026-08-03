// A working app with nothing behind it.
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
// It does not pretend to be connected. Every screen carries DEMO, and the
// actions that would reach an agent say what they would have done instead.
// A demo that could be mistaken for the real thing would fail the same
// first-run rule this exists to satisfy.

import type { ConversationMessage, Session } from './types.ts'

/**
 * Workspaces, in the state they would be in mid-afternoon: one waiting on an
 * answer, one working, one with panes, one quiet.
 *
 * Each carries an `agentSessionId` because a transcript is addressed to an
 * agent session rather than to a workspace. Without one the conversation
 * screen resolves to no target and opens empty - which is the screen the whole
 * demo leads to.
 */
export function demoSessions(): Session[] {
  return [
    {
      id: 'demo-api',
      agentSessionId: 'demo-api-thread',
      name: 'api-refactor',
      state: 'idle',
      indicatorState: 'waiting_input',
      agent: 'claude',
      ccRecap: 'Migrated the session store and asked which database to keep.',
    },
    {
      id: 'demo-glasses',
      agentSessionId: 'demo-glasses-thread',
      name: 'glasses-app',
      state: 'working',
      indicatorState: 'processing',
      agent: 'claude',
      ccRecap: 'Rebuilding the panel geometry.',
    },
    {
      id: 'demo-infra',
      agentSessionId: 'demo-infra-thread',
      name: 'infra',
      state: 'idle',
      indicatorState: 'completed',
      agent: 'codex',
      panes: [
        { paneId: '%1', label: 'deploy', agent: 'codex', indicatorState: 'completed' },
        { paneId: '%2', label: 'logs', agent: 'claude', indicatorState: 'processing' },
      ],
    },
    {
      id: 'demo-docs',
      agentSessionId: 'demo-docs-thread',
      name: 'docs-site',
      state: 'idle',
      indicatorState: 'completed',
      agent: 'claude',
    },
  ]
}

/** Enough conversation to page through, with a tool call so the formatting
 *  that a real transcript exercises is exercised here too. */
export function demoConversation(): ConversationMessage[] {
  return [
    { role: 'user', content: 'Move the session store to Postgres and keep the tests green.' },
    {
      role: 'assistant',
      content:
        'Reading the current schema first, so the migration is against what is there rather than what I remember.',
      toolUse: [{ name: 'Read', input: { file_path: 'db/schema.sql' } }],
    },
    {
      role: 'assistant',
      content:
        'The store is three tables and one of them is only ever read. Moving all three keeps the code honest, and the read-only one costs nothing to bring along.',
    },
    {
      role: 'assistant',
      content:
        'Suite is green: 412 tests, none skipped. The old SQLite path is behind a flag, so a rollback needs no code change.',
      toolUse: [{ name: 'Bash', input: { command: 'bun test', description: 'Run the suite' } }],
    },
    {
      role: 'assistant',
      content: 'Which database should the new service use?',
    },
  ]
}

/** A multi-select, because that is the screen with the most to demonstrate:
 *  a cursor, a toggle, a count, and a row that sends. */
export function demoChoices(): string[] {
  return ['[ ] Postgres', '[ ] SQLite', '[ ] Whatever the others use']
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
 * It answers the question the transcript ends on, because a reply that does not
 * fit what was asked reads as a canned string rather than as speech.
 */
export const DEMO_TRANSCRIPT = 'Postgres, and keep the old path behind a flag.'

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
 * glasses.
 */
export function demoAgentReply(text: string): ConversationMessage {
  return {
    role: 'assistant',
    content: `Taking that as the answer - ${text}\n\nWriting the connection change now. The old path stays behind a flag, so a rollback needs no code change.`,
    toolUse: [{ name: 'Edit', input: { file_path: 'backend/src/db/client.ts' } }],
  }
}

/** How long the agent appears to think about it. Long enough that the reply is
 *  visibly an answer to what was just sent rather than something that was
 *  already there. */
export const DEMO_REPLY_MS = 1400

/** How long the transcription takes. The real one is a round trip to Groq. */
export const DEMO_TRANSCRIBE_MS = 700

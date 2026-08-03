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

/** Workspaces, in the state they would be in mid-afternoon: one waiting on an
 *  answer, one working, one with panes, one quiet. */
export function demoSessions(): Session[] {
  return [
    {
      id: 'demo-api',
      name: 'api-refactor',
      state: 'idle',
      indicatorState: 'waiting_input',
      agent: 'claude',
      ccRecap: 'Migrated the session store and asked which database to keep.',
    },
    {
      id: 'demo-glasses',
      name: 'glasses-app',
      state: 'working',
      indicatorState: 'processing',
      agent: 'claude',
      ccRecap: 'Rebuilding the panel geometry.',
    },
    {
      id: 'demo-infra',
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

/** What a send says instead of sending. Shown where the reply would have gone,
 *  so the gesture completes and nothing is claimed that did not happen. */
export const DEMO_SENT = 'Demo: this would go to the agent.'

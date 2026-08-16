/**
 * What an agent is doing right now, in a few words.
 *
 * "Working" on its own tells someone watching from a phone only that the pane
 * has not stopped. The transcript already says more than that - the newest
 * tool call names the file being edited, the command being run, the thing
 * being searched for - and that is the difference between a spinner and a
 * report.
 *
 * The tail of the transcript, not a watcher: this is read on the sessions
 * push, and only for a pane that is actually working, so it is a few hundred
 * lines of one file per busy session.
 */

import { basename } from 'node:path';
import { locateSessionFile } from '../utils/locate-session-file';
import { readLastLines } from '../utils/read-last-lines';

/** Enough to pass over a run of tool results and reach the call. */
const TAIL_LINES = 200;
/** A command line is a sentence on a phone; a file name is not. */
const MAX_TARGET = 48;

export interface AgentActivity {
  /** The tool's own name, as the transcript records it. */
  tool: string;
  /** What it is being done to, when the call names one thing. */
  target?: string;
}

interface Entry {
  message?: {
    content?: Array<{
      type?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
}

function clamp(value: string): string {
  const one = value.replace(/\s+/g, ' ').trim();
  return one.length > MAX_TARGET ? `${one.slice(0, MAX_TARGET - 1)}…` : one;
}

/**
 * The one thing a call is about.
 *
 * A path is shown by its file name: the directory is the session's own working
 * directory nine times in ten, and on a phone it is the part that gets cut.
 */
function targetOf(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const path = input.file_path ?? input.notebook_path;
  if (typeof path === 'string' && path) return clamp(basename(path));
  const command = input.command;
  if (typeof command === 'string' && command) return clamp(command);
  const pattern = input.pattern ?? input.query;
  if (typeof pattern === 'string' && pattern) return clamp(pattern);
  const url = input.url;
  if (typeof url === 'string' && url) return clamp(url);
  const description = input.description;
  if (typeof description === 'string' && description) return clamp(description);
  return undefined;
}

/**
 * The newest tool call in a Claude session's transcript.
 *
 * Undefined when the transcript cannot be found or holds no call in its tail -
 * a caller shows "working" then, which is what it showed before this existed.
 */
export async function claudeActivity(
  sessionId: string,
  projectsDir?: string,
): Promise<AgentActivity | undefined> {
  const path = await locateSessionFile(sessionId, projectsDir);
  if (!path) return undefined;
  const text = await readLastLines(path, TAIL_LINES);
  if (!text) return undefined;

  const lines = text.split('\n');
  // Backwards: the newest call is the one it is on.
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]?.trim();
    if (!trimmed) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(trimmed) as Entry;
    } catch {
      // A tail slice can open mid-record.
      continue;
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      if (part?.type !== 'tool_use' || typeof part.name !== 'string') continue;
      return { tool: part.name, target: targetOf(part.input) };
    }
  }
  return undefined;
}

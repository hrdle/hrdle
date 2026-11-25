import { getOrCreateHerdrControlSession, type HerdrControlSession } from './herdr-control';

/**
 * Run `fn` against the session's control session with REST client
 * accounting: addClient/removeClient bracket the call so a control session
 * created solely for a one-shot REST request (hrdle peek/send, peer calls)
 * starts its grace timer afterwards and gets cleaned up instead of leaking
 * its per-pane controller subprocesses forever.
 */
export async function withControlSession<T>(
  sessionId: string,
  fn: (cs: HerdrControlSession) => Promise<T>,
): Promise<T> {
  const cs = await getOrCreateHerdrControlSession(sessionId);
  cs.addClient();
  try {
    return await fn(cs);
  } finally {
    cs.removeClient();
  }
}

/**
 * Deliver text to the session's active pane over the raw control stream.
 * Unlike herdr's pane.send_input RPC (which strips ESC/newlines from text),
 * raw bytes preserve multi-line payloads; `bracketed` wraps the text in
 * bracketed-paste markers so agent TUIs (Claude/Codex) treat embedded
 * newlines as literal lines and the trailing \r as submit.
 */
export async function sendTextToSession(
  sessionId: string,
  text: string,
  opts?: { bracketed?: boolean; paneId?: string },
): Promise<string> {
  return withControlSession(sessionId, async (cs) => {
    // Same as raw pane input: an addressed pane may be sitting in another tab,
    // and a reply that cannot land is worse than one that moves the view.
    if (opts?.paneId) await cs.ensurePaneReachable(opts.paneId);
    const panes = await cs.listPanes();
    // An explicit paneId (e.g. a relay item's replyTo pane) wins: in a
    // multi-pane workspace the blocked pane is not necessarily the active one.
    const target = opts?.paneId
      ? panes.find((p) => p.paneId === opts.paneId)
      : panes.find((p) => p.isActive) || panes[0];
    if (!target) throw new Error(opts?.paneId ? 'Pane not found' : 'No pane found');
    const payload = opts?.bracketed ? `\x1b[200~${text}\x1b[201~` : text;
    await cs.sendInput(target.paneId, Buffer.from(payload, 'utf-8'));
    // Deliver the submit \r as its own write, slightly later: agent TUIs
    // can swallow a \r that arrives in the same chunk as the bracketed-paste
    // terminator (treated as part of the paste), leaving the prompt sitting
    // unsubmitted in the input box.
    await new Promise((r) => setTimeout(r, 80));
    await cs.sendInput(target.paneId, Buffer.from('\r', 'utf-8'));
    return target.paneId;
  });
}

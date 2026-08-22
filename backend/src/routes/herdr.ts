import { Hono } from 'hono';
import { herdrUpdateInProgress, lastHerdrApplyError } from '../services/herdr-update';
import { herdrUpdateService, invalidateDashboardCache } from './dashboard';
import { broadcastToMuxClients } from './terminal-mux';

export const herdr = new Hono();

/**
 * Apply a pending herdr update: stop the supervised server, `herdr update`,
 * start again (brew-managed installs instead `brew upgrade herdr` first, then
 * bounce — `herdr update` refuses them with exit 1). Driven only by an
 * explicit dashboard click: the restart re-creates every pane PTY.
 *
 * **The work outlives the request.** A brew upgrade downloading a bottle runs
 * past both the browser's fetch timeout and Bun's `idleTimeout`, and the abort
 * that followed was reported as `signal is aborted without reason` over an
 * update that was still running. The outcome is read back from
 * `GET /apply-status`.
 */
herdr.post('/apply-update', (c) => {
  // Every connected client is about to have its panes pulled out from under it,
  // and only this host knows it is coming.
  const running = herdrUpdateService.apply((phase) =>
    broadcastToMuxClients({ type: 'herdr-restart', phase }),
  );
  running
    .then((result) => {
      if (!result.ok) {
        // The whole transcript, once: the dashboard shows a single line, and
        // which servers herdr listed as blocking it is only in here.
        console.error(`[herdr-update] ${result.error}\n${result.output.trim()}`);
        return;
      }
      // The dashboard re-polls right after this returns, and its payload cache
      // would otherwise still carry the warning the apply just resolved.
      invalidateDashboardCache();
    })
    .catch((err) => console.error(`[herdr-update] ${err}`));
  return c.json({ started: true }, 202);
});

/** Whether the apply is still going, and why it failed once it is not. */
herdr.get('/apply-status', (c) =>
  c.json({ applying: herdrUpdateInProgress(), error: lastHerdrApplyError() ?? null }),
);

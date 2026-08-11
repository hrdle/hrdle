import { Hono } from 'hono';
import { broadcastToMuxClients } from './terminal-mux';
import { herdrUpdateService, invalidateDashboardCache } from './dashboard';

export const herdr = new Hono();

/**
 * Apply a pending herdr update: stop the supervised server, `herdr update`,
 * start it again — in that order, because `herdr update` refuses to replace the
 * binary while a server is answering.
 *
 * Deliberately POST-only and driven by an explicit dashboard click.
 * Restarting herdr re-creates every pane PTY — agent conversations come back
 * via `resume_agents_on_restore`, but running commands do not — so hrdle never
 * triggers this on its own, and never from the `hrdle update --auto` timer.
 */
herdr.post('/apply-update', async (c) => {
  // Every connected client is about to have its panes pulled out from under it,
  // and only this host knows it is coming.
  const result = await herdrUpdateService.apply((phase) =>
    broadcastToMuxClients({ type: 'herdr-restart', phase }),
  );
  if (!result.ok) {
    return c.json({ error: result.error ?? 'herdr update failed', output: result.output }, 500);
  }
  // The dashboard re-polls right after this returns, and its payload cache
  // would otherwise still carry the warning the apply just resolved.
  invalidateDashboardCache();
  return c.json({
    success: true,
    output: result.output,
    installed: result.installed,
    fromVersion: result.fromVersion,
    toVersion: result.toVersion,
  });
});

import { Hono } from 'hono';
import { broadcastToMuxClients } from './terminal-mux';
import { herdrUpdateService, invalidateDashboardCache } from './dashboard';

export const herdr = new Hono();

/**
 * Apply a pending herdr update: stop the supervised server, `herdr update`,
 * start again (brew-managed installs instead `brew upgrade herdr` first, then
 * bounce — `herdr update` refuses them with exit 1). Driven only by an
 * explicit dashboard click: the restart re-creates every pane PTY.
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

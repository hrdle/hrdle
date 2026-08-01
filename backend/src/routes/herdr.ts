import { Hono } from 'hono';
import { herdrUpdateService, invalidateDashboardCache } from './dashboard';

export const herdr = new Hono();

/**
 * Apply a pending herdr update: `herdr update` + a supervised server restart.
 *
 * Deliberately POST-only and driven by an explicit dashboard click (#393).
 * Restarting herdr re-creates every pane PTY — agent conversations come back
 * via `resume_agents_on_restore`, but running commands do not — so cchub never
 * triggers this on its own, and never from the `cchub update --auto` timer.
 */
herdr.post('/apply-update', async (c) => {
  const result = await herdrUpdateService.apply();
  if (!result.ok) {
    return c.json({ error: result.error ?? 'herdr update failed', output: result.output }, 500);
  }
  // The dashboard re-polls right after this returns, and its payload cache
  // would otherwise still carry the skew warning the apply just resolved.
  invalidateDashboardCache();
  return c.json({ success: true, output: result.output });
});

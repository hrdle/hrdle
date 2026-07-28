import { Hono } from 'hono';
import { appendFile } from 'node:fs/promises';
import { TMP_PATHS } from '../../../shared/identity';

const LOG_FILE = TMP_PATHS.browserLogFile;

const logs = new Hono();

logs.post('/', async (c) => {
  const body = await c.req.json();
  const { level, message, timestamp, stack } = body;

  const logLine = `[${level.toUpperCase()}] ${timestamp}\n  ${message}${stack ? `\n  ${stack}` : ''}\n`;

  // Write to file
  await appendFile(LOG_FILE, logLine);

  // Also print to console
  console.log(`[BROWSER ${level.toUpperCase()}] ${message.slice(0, 100)}`);

  return c.json({ ok: true });
});

logs.get('/', async (c) => {
  try {
    const content = await Bun.file(LOG_FILE).text();
    return c.text(content);
  } catch {
    return c.text('No logs yet');
  }
});

logs.delete('/', async (c) => {
  await Bun.write(LOG_FILE, '');
  return c.json({ ok: true });
});

export { logs };

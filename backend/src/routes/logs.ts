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

  // Also print to console.
  //
  // Not truncated. It was cut at 100 characters, which is just past the length
  // of the glasses' heartbeat line — so the moment that line grew a field, the
  // console started showing `dev=connect` where the file said
  // `dev=connected,off-head batt=79%`. A whole afternoon of diagnosis was done
  // against `journalctl`, and two wrong conclusions came out of it: that the
  // SDK's declared type disagreed with the device, and that half the device
  // fields were unpopulated. Both were the cut.
  //
  // A log line that silently means something different depending on where it is
  // read is worse than a long one. The file has always had the whole thing;
  // now they agree.
  console.log(`[BROWSER ${level.toUpperCase()}] ${message}`);

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

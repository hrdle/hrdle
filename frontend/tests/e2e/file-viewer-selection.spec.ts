import { test, expect, type APIRequestContext } from '@playwright/test';
import { IDENTITY } from '../../../shared/identity';

// Regression test: switching files in the FileViewer must
//   (a) keep the file-list scroll position
//   (b) visually highlight the currently selected file
// Bug repro before fix: clicking a file toggled the shared isLoading flag
// in useFileViewer, which unmounted the file tree (replaced with a "Loading..."
// placeholder) and reset scroll to the top on next mount.

const FRONTEND_URL = `https://localhost:${IDENTITY.frontendDevPort}`;
const BACKEND_URL = `https://localhost:${IDENTITY.devPort}`;

test.use({
  ignoreHTTPSErrors: true,
  baseURL: FRONTEND_URL,
});

async function pickFirstClaudeSession(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${BACKEND_URL}/api/sessions`);
  const data = await res.json();
  const target = data.sessions.find(
    (s: { agent?: string; state?: string }) =>
      s.agent === 'claude' && (s.state === 'idle' || s.state === 'working'),
  );
  if (!target) throw new Error('no claude session — start `claude` in a tmux session');
  return target.id as string;
}

test('FileBrowser keeps scroll and shows selection when switching files (desktop split)', async ({ page, request, viewport }) => {
  // Desktop split layout keeps FileBrowser visible while a file is open in
  // the right pane, so scrollTop is directly observable. On mobile the
  // FileBrowser is hidden via display:none while a file is open (browsers
  // report scrollTop=0 in that state); the round-trip test below covers it.
  test.skip(!viewport || viewport.width < 768, 'desktop split layout only');

  const sessionId = await pickFirstClaudeSession(request);

  await page.addInitScript(([id]) => {
    localStorage.setItem('cchub-open-sessions', JSON.stringify([id]));
    localStorage.setItem('cchub-last-session-id', id);
    localStorage.setItem('cchub-onboarding-completed', 'true');
    localStorage.setItem('cchub-onboarding-sessionlist-completed', 'true');
  }, [sessionId]);

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Open the file viewer (FilesIcon button — used in the mobile + desktop bars).
  // The path bar at the bottom of the FileBrowser shows the current path; once
  // it appears we know the directory listing has finished.
  await page.locator('[aria-label="Switch to Files"], [title*="Files"], button:has-text("Files")').first().click({ timeout: 15000 });

  const fileTree = page.locator('.flex-1.overflow-y-auto').first();
  await fileTree.waitFor({ timeout: 15000 });

  // Wait until the tree actually has clickable file rows.
  const fileRows = page.locator('div.cursor-pointer:not(:has(.text-yellow-400))');
  await expect(fileRows.first()).toBeVisible({ timeout: 15000 });
  const rowCount = await fileRows.count();
  if (rowCount < 2) test.skip(true, `need ≥2 files in tree, found ${rowCount}`);

  // Scroll the list down so we can detect a reset.
  const scrollContainer = await fileTree.elementHandle();
  if (!scrollContainer) throw new Error('scroll container not found');
  await page.evaluate((el) => { (el as HTMLElement).scrollTop = 200; }, scrollContainer);
  const scrollBefore = await page.evaluate((el) => (el as HTMLElement).scrollTop, scrollContainer);

  // Click first file. Selection highlight should appear, scroll should stay.
  await fileRows.first().click();
  await expect(page.locator('div.cursor-pointer.bg-blue-500\\/15')).toHaveCount(1, { timeout: 5000 });

  const scrollAfter = await page.evaluate((el) => (el as HTMLElement).scrollTop, scrollContainer);
  expect(scrollAfter, `scroll reset after click (before=${scrollBefore} after=${scrollAfter})`).toBeGreaterThan(0);

  // Switch to a different file; selection should move with it.
  await fileRows.nth(1).click();
  await page.waitForTimeout(500);
  const selected = page.locator('div.cursor-pointer.bg-blue-500\\/15');
  await expect(selected).toHaveCount(1);
  const scrollFinal = await page.evaluate((el) => (el as HTMLElement).scrollTop, scrollContainer);
  expect(scrollFinal, `scroll reset after second click`).toBeGreaterThan(0);
});

test('FileBrowser scroll survives switching to file view and back (mobile flow)', async ({ page, request }) => {
  // On the mobile flow viewMode toggles between 'browser' and 'file', which
  // used to unmount the FileBrowser. The fix keeps it mounted via display
  // toggling so scrollTop survives the round trip.
  const sessionId = await pickFirstClaudeSession(request);

  await page.addInitScript(([id]) => {
    localStorage.setItem('cchub-open-sessions', JSON.stringify([id]));
    localStorage.setItem('cchub-last-session-id', id);
    localStorage.setItem('cchub-onboarding-completed', 'true');
    localStorage.setItem('cchub-onboarding-sessionlist-completed', 'true');
  }, [sessionId]);

  await page.setViewportSize({ width: 393, height: 851 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.locator('[aria-label="Switch to Files"], [title*="Files"], button:has-text("Files")').first().click({ timeout: 15000 });

  const fileTree = page.locator('.flex-1.overflow-y-auto').first();
  await fileTree.waitFor({ timeout: 15000 });
  const fileRows = page.locator('div.cursor-pointer:not(:has(.text-yellow-400))');
  await expect(fileRows.first()).toBeVisible({ timeout: 15000 });

  const scrollContainer = await fileTree.elementHandle();
  if (!scrollContainer) throw new Error('scroll container not found');
  await page.evaluate((el) => { (el as HTMLElement).scrollTop = 150; }, scrollContainer);
  const scrollBefore = await page.evaluate((el) => (el as HTMLElement).scrollTop, scrollContainer);
  if (scrollBefore === 0) test.skip(true, 'not enough rows to scroll');

  // Click a file (transitions to viewMode='file' on mobile).
  await fileRows.first().click();
  await page.waitForTimeout(800);

  // Navigate back to file list (browser back).
  await page.goBack();
  await page.waitForTimeout(500);

  const scrollAfter = await page.evaluate((el) => (el as HTMLElement).scrollTop, scrollContainer);
  expect(scrollAfter, `scroll lost across viewMode round trip (before=${scrollBefore} after=${scrollAfter})`).toBe(scrollBefore);
});

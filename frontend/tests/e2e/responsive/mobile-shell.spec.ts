import { expect, test } from '@playwright/test';
import { bootApp } from './fixtures';

/**
 * What the phone's shell does, written down before it is rebuilt.
 *
 * `App.tsx` renders mobile from a component tree of its own while tablet and
 * desktop share `DesktopLayout`, and #7 merges the two. The merge is the kind
 * that looks finished long before it is: the trees agree on what the controls
 * *are* (that is `SESSION_ACTIONS` now) and disagree on where everything sits -
 * the bar is at the bottom here and at the top there, a session list is a page
 * here and a modal there, the dashboard is a screen here and a panel there.
 *
 * None of that was asserted anywhere. These are characterisation tests: they
 * pass today, and their job is to keep passing while the tree underneath them
 * is replaced. A red one during the merge is the phone losing something.
 */
test.describe('mobile shell', () => {
  test.skip(
    () => test.info().project.name !== 'responsive-mobile',
    'describes the phone layout only',
  );

  test('the session bar is pinned to the bottom edge, full width', async ({
    page,
  }) => {
    await bootApp(page);

    const bar = page
      .getByTestId('action-reload')
      .locator('xpath=ancestor::div[contains(@class,"fixed")]')
      .first();
    const box = await bar.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) throw new Error('no bar on screen');

    // Flush to the bottom: the phone's controls sit under the thumb, which is
    // the whole reason this layout differs from the tablet's top bar.
    expect(Math.round(box.y + box.height)).toBe(viewport.height);
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(viewport.width);
  });

  test('the terminal fills everything above the bar', async ({ page }) => {
    await bootApp(page);

    const terminal = page.locator('[data-onboarding="terminal"]');
    const terminalBox = await terminal.boundingBox();
    const viewport = page.viewportSize();
    if (!terminalBox || !viewport) throw new Error('no terminal on screen');

    // Starts at the top and reaches the bar. A merged layout that leaves a
    // header strip here costs rows on the smallest screen there is.
    expect(Math.round(terminalBox.y)).toBe(0);
    expect(terminalBox.height).toBeGreaterThan(viewport.height * 0.8);
  });

  test('the session list is a screen, not a modal over the terminal', async ({
    page,
  }) => {
    await bootApp(page);
    await page.locator('[data-onboarding="session-list"]').click();

    // Its tabs are what identify the list itself rather than a session name
    // that happens to be on screen either way.
    const list = page.getByRole('button', { name: 'ワークスペース' });
    await expect(list).toBeVisible();

    // The list's own container rather than one tab's label width. Addressed by
    // its width class because that class is the thing under test: `max-w-lg`
    // fills a phone and constrains a desktop, and a merged layout that swapped
    // it for the desktop's modal would fail here rather than on someone's phone.
    const box = await list
      .locator('xpath=ancestor::div[contains(@class,"max-w-lg")][1]')
      .boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) throw new Error('no session list on screen');
    expect(box.width).toBeGreaterThan(viewport.width * 0.9);
  });

  test('the dashboard is a screen too', async ({ page }) => {
    await bootApp(page);
    await page.getByTestId('action-dashboard').click();

    // The desktop opens this as a side panel beside the terminal; the phone
    // gives it the screen, because half of 393px is not a dashboard.
    await expect(
      page.getByRole('heading', { name: '使用量リミット' }),
    ).toBeVisible();
  });
});

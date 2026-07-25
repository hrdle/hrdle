import { expect, test } from '@playwright/test';
import { bootApp } from './fixtures';

// Runs once per viewport project (desktop / tablet / mobile). Mobile renders a
// different component tree from desktop and tablet, so "it booted at one width"
// has never implied the others work.

/** Which layout tree each viewport project is expected to land on. */
const EXPECTED_LAYOUT: Record<string, string> = {
  'responsive-desktop': 'desktop',
  'responsive-tablet': 'tablet',
  'responsive-mobile': 'mobile',
};

test.describe('layout parity', () => {
  test('boots and renders the app shell', async ({ page }) => {
    await bootApp(page);

    // Something beyond the fallback markup must be on screen.
    await expect(page.locator('#root')).not.toBeEmpty();
    // index.html reveals this only when React fails to mount within 4s.
    await expect(page.locator('#fallback')).toBeHidden();
  });

  test('renders the layout tree this viewport is meant to use', async ({
    page,
  }) => {
    await bootApp(page);

    const expected = EXPECTED_LAYOUT[test.info().project.name];
    // Without this the matrix can quietly test one layout three times — the
    // device heuristic keys off screen size and touch, not just viewport width.
    await expect(page.locator(`[data-layout="${expected}"]`)).toBeVisible();
  });

  test('does not scroll horizontally', async ({ page }) => {
    await bootApp(page);

    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });

    // 1px of slack for sub-pixel rounding at fractional device scale factors.
    expect(
      overflow.scrollWidth,
      `page scrolls horizontally: ${overflow.scrollWidth}px of content in a ${overflow.clientWidth}px viewport`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
});

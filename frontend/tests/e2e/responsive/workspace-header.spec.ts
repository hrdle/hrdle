import { expect, type Locator, type Page, test } from '@playwright/test';
import { bootApp } from './fixtures';

/**
 * The workspace list's header: what holds on every tab on one line, the list's
 * own view switch and search on another - and the two lines joined into one
 * wherever the header is wide enough to carry both.
 */

// The desktop's toolbar in remote-control mode (its default) has no pane
// header to carry the session-list button, only its own "sessions" button.
async function clickListOpener(page: Page): Promise<void> {
  await page
    .locator('[data-onboarding="session-list"]')
    .or(page.getByRole('button', { name: 'セッション', exact: true }))
    .first()
    .click();
}

async function openList(page: Page): Promise<void> {
  await bootApp(page);
  await clickListOpener(page);
  await expect(
    page.getByRole('button', { name: 'ワークスペース', exact: true }),
  ).toBeVisible();
}

async function middle(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('not on screen');
  return box.y + box.height / 2;
}

test.describe('workspace list header', () => {
  test('the view switch sits under the tabs on a phone and beside them elsewhere', async ({
    page,
  }) => {
    await openList(page);
    const tabs = page.getByRole('button', { name: 'ワークスペース', exact: true });
    const viewSwitch = page.getByRole('button', { name: 'リスト', exact: true });
    const create = page.locator('[data-onboarding="new-session"]');

    const tabsY = await middle(tabs);
    // Creating a session means the same on every tab, so it stays on the
    // tabs' line at every width.
    expect(Math.abs((await middle(create)) - tabsY)).toBeLessThan(4);

    const below = (await middle(viewSwitch)) - tabsY;
    if (test.info().project.name === 'responsive-mobile') {
      expect(below).toBeGreaterThan(20);
      // Narrow: search is a button that opens a field, not a field.
      await expect(page.getByPlaceholder('ワークスペース...')).toBeHidden();
    } else {
      expect(Math.abs(below)).toBeLessThan(4);
      await expect(page.getByPlaceholder('ワークスペース...')).toBeVisible();
    }
  });

  test('the history tab carries no workspace search or view switch', async ({
    page,
  }) => {
    await openList(page);
    await page.getByRole('button', { name: '履歴', exact: true }).click();

    // A workspace search here filtered a list that is not on screen.
    await expect(page.getByPlaceholder('ワークスペース...')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'リスト', exact: true }),
    ).toHaveCount(0);
  });

  test('choosing a view is remembered', async ({ page }) => {
    await openList(page);
    await page.getByRole('button', { name: 'ボード', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'ボード', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await page.locator('#root > *').first().waitFor({ state: 'attached' });
    await clickListOpener(page);
    await expect(
      page.getByRole('button', { name: 'ボード', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});

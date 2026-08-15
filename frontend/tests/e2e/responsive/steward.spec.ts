import { expect, test } from '@playwright/test';
import { bootApp } from './fixtures';

/**
 * The steward mode on a phone.
 *
 * The gate is the first thing checked: it is a server setting, and the whole
 * point of gating on the server rather than in the client is that a build
 * carrying this code shows nothing at all until a server says otherwise.
 *
 * Mobile only for now — the entry point lives in the session list's header,
 * which is a screen of its own on a phone.
 */

const THREAD = [
  {
    id: 'n1',
    at: 1_760_000_000_000,
    role: 'steward',
    kind: 'notify',
    text: 'レビューが7件返っています',
    detail: 'うち1件は設計が変わる規模です。',
  },
  {
    id: 'q1',
    at: 1_760_000_001_000,
    role: 'steward',
    kind: 'ask',
    text: '巻き戻しますか',
    ask: { id: 'q1', mode: 'single', choices: ['巻き戻す', 'このまま進む'] },
  },
];

test.describe('steward mode', () => {
  // The entry point lives in the session list header, which is a screen of its
  // own only on a phone.
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-mobile', 'mobile only');
  });

  test('is absent when the server has no steward', async ({ page }) => {
    await bootApp(page, { steward: { enabled: false } });
    await page.locator('[data-onboarding="session-list"]').click();

    // The list is what carries the entry point, so its absence has to be
    // distinguished from the list simply not being open.
    await expect(page.getByRole('button', { name: 'ワークスペース' })).toBeVisible();
    await expect(page.getByTitle('スチュワード')).toHaveCount(0);
  });

  test('opens the thread from the session list', async ({ page }) => {
    await bootApp(page, { steward: { enabled: true, thread: THREAD } });

    await page.locator('[data-onboarding="session-list"]').click();
    await page.getByTitle('スチュワード').click();

    await expect(page.getByText('レビューが7件返っています')).toBeVisible();
    // The half the glasses could not carry.
    await expect(page.getByText('うち1件は設計が変わる規模です。')).toBeVisible();
  });

  test('a question offers its choices, and a way to walk away', async ({ page }) => {
    await bootApp(page, { steward: { enabled: true, thread: THREAD } });
    await page.locator('[data-onboarding="session-list"]').click();
    await page.getByTitle('スチュワード').click();

    await expect(page.getByRole('button', { name: '巻き戻す' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'このまま進む' })).toBeVisible();
    // Without this the steward waits forever on a question nobody wanted.
    await expect(page.getByRole('button', { name: 'あとで' })).toBeVisible();
  });

  test('answering posts the choice against the question', async ({ page }) => {
    await bootApp(page, { steward: { enabled: true, thread: THREAD } });
    await page.locator('[data-onboarding="session-list"]').click();
    await page.getByTitle('スチュワード').click();

    const posted = page.waitForRequest(
      (req) => req.url().includes('/api/steward/thread/reply') && req.method() === 'POST',
    );
    await page.getByRole('button', { name: '巻き戻す' }).click();

    const body = JSON.parse((await posted).postData() ?? '{}');
    expect(body).toEqual({ askId: 'q1', answer: { kind: 'choice', indices: [0] } });
  });

  test('has a composer, unlike the read-only chat view', async ({ page }) => {
    await bootApp(page, { steward: { enabled: true, thread: THREAD } });
    await page.locator('[data-onboarding="session-list"]').click();
    await page.getByTitle('スチュワード').click();

    const composer = page.getByPlaceholder('スチュワードに話しかける');
    await expect(composer).toBeVisible();

    const posted = page.waitForRequest(
      (req) => req.url().includes('/api/steward/thread/reply') && req.method() === 'POST',
    );
    await composer.fill('止まっているものを教えて');
    await page.getByRole('button', { name: 'Send' }).click();

    const body = JSON.parse((await posted).postData() ?? '{}');
    expect(body).toEqual({ text: '止まっているものを教えて' });
  });
});

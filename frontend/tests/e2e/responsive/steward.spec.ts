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

const TRANSCRIPT = {
  messages: [
    { id: 'm1', role: 'user', content: 'レビューして' },
    { id: 'm2', role: 'assistant', content: '7件の指摘があります' },
  ],
};

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
  {
    id: 'n2',
    at: 1_760_000_002_000,
    role: 'steward',
    kind: 'notify',
    text: '設計変更の指摘です',
    source: { agentSessionId: 'sess-1', messageIds: ['m2'] },
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
    // The half the glasses could not carry, behind a tap: open, the card is the
    // glance plus everything the glance was meant to spare them.
    await expect(page.getByText('うち1件は設計が変わる規模です。')).toHaveCount(0);
    await page.getByRole('button', { name: '詳細', exact: true }).click();
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

test.describe('tracing a summary back', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-mobile', 'mobile only');
  });

  // A summary is only worth trusting if the thing it summarises can be reached.
  test('opens the real transcript from the turn that cites it', async ({ page }) => {
    await bootApp(page, { steward: { enabled: true, thread: THREAD } });
    // After bootApp: a later route wins in Playwright, and bootApp's `**/api/**`
    // would otherwise answer this one with `{}`.
    await page.route('**/api/sessions/history/sess-1/conversation*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TRANSCRIPT) }),
    );
    await page.locator('[data-onboarding="session-list"]').click();
    await page.getByTitle('スチュワード').click();

    await page.getByRole('button', { name: '元の会話を見る' }).click();

    await expect(page.getByText('7件の指摘があります')).toBeVisible();
  });

  test('a turn with no source offers nothing to open', async ({ page }) => {
    await bootApp(page, { steward: { enabled: true, thread: [THREAD[0]] } });
    await page.locator('[data-onboarding="session-list"]').click();
    await page.getByTitle('スチュワード').click();

    await expect(page.getByRole('button', { name: '元の会話を見る' })).toHaveCount(0);
  });
});

/**
 * A tablet reaches the list through the session modal rather than a screen of
 * its own, so the entry point has to be wired there too - it was missed the
 * first time, and nothing failed.
 */
test.describe('steward mode on a tablet', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-tablet', 'tablet only');
  });

  test('the entry point is in the session modal', async ({ page }) => {
    await bootApp(page, { steward: { enabled: true, thread: THREAD } });
    await page.locator('[data-onboarding="session-list"]').click();

    await page.getByTitle('スチュワード').click();
    await expect(page.getByText('レビューが7件返っています')).toBeVisible();
  });

  test('a detail is behind a tap here too', async ({ page }) => {
    await bootApp(page, { steward: { enabled: true, thread: THREAD } });
    await page.locator('[data-onboarding="session-list"]').click();
    await page.getByTitle('スチュワード').click();

    await expect(page.getByText('うち1件は設計が変わる規模です。')).toHaveCount(0);
    await page.getByRole('button', { name: '詳細', exact: true }).click();
    await expect(page.getByText('うち1件は設計が変わる規模です。')).toBeVisible();
  });

  test('is absent when the server has no steward', async ({ page }) => {
    await bootApp(page, { steward: { enabled: false } });
    await page.locator('[data-onboarding="session-list"]').click();

    await expect(page.getByRole('button', { name: 'ワークスペース' })).toBeVisible();
    await expect(page.getByTitle('スチュワード')).toHaveCount(0);
  });
});

/**
 * With the view on, a session opens onto what the steward wrote and the
 * terminal is a level down. The composer is the point of the rearrangement:
 * the pane's own input bar sat under the summary and reached the agent, so
 * what someone typed there went somewhere they could not see.
 */
const TURNS = [
  { id: 't1', at: 1_760_000_000_000, role: 'agent', text: 'テストを直しています' },
];

test.describe('a session in steward mode', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-mobile', 'mobile only');
  });

  const boot = (page: import('@playwright/test').Page) =>
    bootApp(page, {
      withAgentPane: true,
      steward: { enabled: true, view: true, turns: TURNS },
    });

  test('opens onto the steward, with a composer that is the steward', async ({ page }) => {
    await boot(page);

    await expect(page.getByText('テストを直しています')).toBeVisible();

    const composer = page.getByPlaceholder('スチュワードに話しかける');
    await expect(composer).toBeVisible();

    const posted = page.waitForRequest(
      (req) => req.url().includes('/api/steward/thread/reply') && req.method() === 'POST',
    );
    await composer.fill('あとどのくらい');
    await page.getByRole('button', { name: 'Send' }).click();

    // The session it was written from travels with it, or the steward answers
    // about whichever session it happened to be looking at.
    expect(JSON.parse((await posted).postData() ?? '{}')).toEqual({
      text: 'あとどのくらい',
      sessionId: 'demo',
    });
  });

  test('the terminal is in the menu, not beside the summary', async ({ page }) => {
    await boot(page);

    await expect(page.getByTestId('action-chat')).toHaveCount(0);
    await page.getByTestId('pane-more').click();
    await page.getByTestId('pane-more-terminal').click();

    await expect(page.getByText('テストを直しています')).toHaveCount(0);
    // The steward's composer goes with it: this pane is the agent's again.
    await expect(page.getByPlaceholder('スチュワードに話しかける')).toHaveCount(0);
  });

  test('the list can speak to the steward without opening the thread first', async ({ page }) => {
    await bootApp(page, { steward: { enabled: true, view: true } });
    await page.locator('[data-onboarding="session-list"]').click();

    const composer = page.getByPlaceholder('スチュワードに話しかける');
    await expect(composer).toBeVisible();

    const posted = page.waitForRequest(
      (req) => req.url().includes('/api/steward/thread/reply') && req.method() === 'POST',
    );
    await composer.fill('止まっているものを教えて');
    await page.getByRole('button', { name: 'Send' }).click();
    expect(JSON.parse((await posted).postData() ?? '{}')).toEqual({ text: '止まっているものを教えて' });

    // Sending opens the thread: that is where the answer lands.
    await expect(page.getByText('スチュワード', { exact: true })).toBeVisible();
  });
});

/**
 * The steward view reaches into two screens that already existed, so the case
 * that matters most is the one where it is off: a build carrying all of this
 * must render the list and the transcript exactly as it did before.
 */
test.describe('with the steward off, nothing changes', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-mobile', 'mobile only');
  });

  test('the list shows its own rows, and asks the steward nothing', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/steward')) asked.push(new URL(r.url()).pathname);
    });

    await bootApp(page, { steward: { enabled: false } });
    await page.locator('[data-onboarding="session-list"]').click();

    await expect(page.getByRole('button', { name: 'ワークスペース' })).toBeVisible();
    await expect(page.getByText('demo')).toBeVisible();
    await expect(page.getByTitle('スチュワード')).toHaveCount(0);

    // /enabled is the one call allowed: it is how the client learns to show
    // nothing. Anything else means the off path is doing work.
    expect([...new Set(asked)]).toEqual(['/api/steward/enabled']);
  });

  test('the toggle is not in the dashboard', async ({ page }) => {
    await bootApp(page, { steward: { enabled: false } });
    await page.locator('[data-onboarding="session-list"]').click();
    // Two controls carry this title on a phone. The terminal's is behind the
    // list; the list's own is the one that can be reached.
    await page.getByTitle('ダッシュボード').last().click();

    await expect(page.getByRole('button', { name: 'スチュワード表示' })).toHaveCount(0);
  });

  test('a session still opens onto its terminal, with its own input bar', async ({ page }) => {
    await bootApp(page, { withAgentPane: true, steward: { enabled: false } });

    await expect(page.getByPlaceholder('スチュワードに話しかける')).toHaveCount(0);
    // The chat toggle is where it was; nothing moved into a menu.
    await expect(page.getByTestId('action-chat')).toBeVisible();
    await expect(page.getByTestId('pane-more')).toHaveCount(0);
  });

  test('the list has no composer', async ({ page }) => {
    await bootApp(page, { steward: { enabled: false } });
    await page.locator('[data-onboarding="session-list"]').click();

    await expect(page.getByPlaceholder('スチュワードに話しかける')).toHaveCount(0);
  });

  // Enabled on the server but not switched on here: still the old rendering.
  test('enabled but not switched on leaves the list alone', async ({ page }) => {
    await bootApp(page, {
      steward: {
        enabled: true,
        lines: [{ sessionId: 'demo', text: 'この行は出てはいけない', at: 1 }],
      },
    });
    await page.locator('[data-onboarding="session-list"]').click();

    await expect(page.getByText('この行は出てはいけない')).toHaveCount(0);
    // The entry point is still there - the thread does not depend on the view.
    await expect(page.getByTitle('スチュワード')).toBeVisible();
  });
});

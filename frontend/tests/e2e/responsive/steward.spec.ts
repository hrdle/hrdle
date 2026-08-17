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

  // The thread is the conversation about the whole set. What is about one
  // session is on that session's row and in its chat, and a third copy here
  // turned this screen into a feed of everything at once.
  test('shows the overview conversation, and a question still waiting', async ({ page }) => {
    await bootApp(page, {
      steward: {
        enabled: true,
        thread: [
          { id: 's1', at: 1, role: 'steward', kind: 'notify', text: 'w5Qのテストが落ちています', sessionId: 'w5Q' },
          { id: 'o1', at: 2, role: 'steward', kind: 'notify', text: '3件が止まっています' },
          {
            id: 's2',
            at: 3,
            role: 'steward',
            kind: 'ask',
            text: '巻き戻しますか',
            sessionId: 'w5Q',
            ask: { id: 's2', mode: 'single', choices: ['はい', 'いいえ'] },
          },
          {
            id: 's3',
            at: 4,
            role: 'steward',
            kind: 'ask',
            text: '答え済みの質問',
            sessionId: 'w5Q',
            ask: { id: 's3', mode: 'single', choices: ['はい'], answer: { kind: 'choice', indices: [0] } },
          },
        ],
      },
    });
    await page.locator('[data-onboarding="session-list"]').click();
    await page.getByTitle('スチュワード').click();

    await expect(page.getByText('3件が止まっています')).toBeVisible();
    // Waiting on an answer, so it is here wherever it came from.
    await expect(page.getByText('巻き戻しますか')).toBeVisible();
    await expect(page.getByText('w5Qのテストが落ちています')).toHaveCount(0);
    await expect(page.getByText('答え済みの質問')).toHaveCount(0);
  });

  // Two devices open at once: the phone's message has to appear on the tablet
  // without the tablet doing anything. Nothing subscribed to the server's
  // `steward-*` broadcast until now, so it never did.
  test('follows what another device says, with nothing done here', async ({ page }) => {
    await page.routeWebSocket(/\/ws\/mux/, (server) => {
      server.onMessage((raw) => {
        const msg = JSON.parse(String(raw)) as { type?: string };
        if (msg.type !== 'subscribe-steward') return;
        server.send(JSON.stringify({ type: 'steward-snapshot', thread: THREAD, lines: [] }));
        server.send(
          JSON.stringify({
            type: 'steward-thread',
            item: {
              id: 'elsewhere',
              at: 1_760_000_009_000,
              role: 'user',
              kind: 'reply',
              text: 'タブレットから言いました',
            },
          }),
        );
      });
    });

    await bootApp(page, { steward: { enabled: true, thread: THREAD } });
    await page.locator('[data-onboarding="session-list"]').click();
    await page.getByTitle('スチュワード').click();

    await expect(page.getByText('タブレットから言いました')).toBeVisible();
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

  // The floating keyboard types into the pane. With the steward's chat up the
  // tablet had two places to type and the visible one was not the one
  // listening - the same rule the phone applies with `lockInputHidden`.
  test('the floating keyboard is not up while the steward chat is', async ({ page }) => {
    await bootApp(page, { withAgentPane: true, steward: { enabled: true, view: true, turns: TURNS } });

    // A tablet opens onto the summary too; only the phone moves the terminal
    // into a menu.
    await expect(page.getByPlaceholder('スチュワードに話しかける')).toBeVisible();
    await expect(page.getByTestId('floating-keyboard')).toHaveCount(0);
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
  {
    id: 't1',
    at: 1_760_000_000_000,
    role: 'agent',
    text: 'テストを直しています',
    // A source with no message id: the turn says which conversation it came
    // from and not where in it, which is the ordinary case.
    source: { agentSessionId: 'sess-1' },
  },
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

  // A still indicator a screen away cannot be told from a screen that has
  // stopped updating, which is what someone waiting actually suspects.
  test('says it is working, with the seconds counting, beside the composer', async ({ page }) => {
    await boot(page);

    await page.getByPlaceholder('スチュワードに話しかける').fill('あとどのくらい');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText(/処理中…（経過 \d+ 秒）/)).toBeVisible();
  });

  // A question the person never sees is one the steward waits on forever, and
  // the thread is not where they are when they are reading a session.
  test('a question about this session is answerable above the composer', async ({ page }) => {
    await bootApp(page, {
      withAgentPane: true,
      steward: {
        enabled: true,
        view: true,
        turns: TURNS,
        asks: [
          {
            id: 'q9',
            at: 1,
            role: 'steward',
            kind: 'ask',
            text: '巻き戻しますか',
            sessionId: 'demo',
            ask: { id: 'q9', mode: 'single', choices: ['巻き戻す', 'このまま進む'] },
          },
        ],
      },
    });

    await expect(page.getByText('巻き戻しますか')).toBeVisible();

    const posted = page.waitForRequest(
      (req) => req.url().includes('/api/steward/thread/reply') && req.method() === 'POST',
    );
    await page.getByRole('button', { name: '巻き戻す' }).click();
    expect(JSON.parse((await posted).postData() ?? '{}')).toEqual({
      askId: 'q9',
      answer: { kind: 'choice', indices: [0] },
      sessionId: 'demo',
    });
  });

  // The list says which session is working; reading one there was nothing to
  // tell a working pane from a finished one.
  test('says whether this session is working, beside the composer', async ({ page }) => {
    await bootApp(page, {
      withAgentPane: true,
      indicatorState: 'processing',
      steward: { enabled: true, view: true, turns: TURNS },
    });

    await expect(page.getByText('このセッションは作業中です')).toBeVisible();
  });

  // Chrome reads a plain text field as a form and puts its password / card /
  // address strip above the keyboard, and a font under 16px makes iOS zoom the
  // page on focus. The pane's own input bar has carried both of these for as
  // long as it has existed.
  test('the composer is typed into the way the pane is', async ({ page }) => {
    await boot(page);
    const composer = page.getByPlaceholder('スチュワードに話しかける');

    expect(await composer.evaluate((el) => el.tagName)).toBe('TEXTAREA');
    expect(
      await composer.evaluate((el) => ({
        autocomplete: el.getAttribute('autocomplete'),
        size: getComputedStyle(el).fontSize,
      })),
    ).toEqual({ autocomplete: 'off', size: '16px' });

    // Enter sends, so the send button is not the only way out on a phone.
    const posted = page.waitForRequest(
      (req) => req.url().includes('/api/steward/thread/reply') && req.method() === 'POST',
    );
    await composer.fill('あとどのくらい');
    await composer.press('Enter');
    expect(JSON.parse((await posted).postData() ?? '{}')).toEqual({
      text: 'あとどのくらい',
      sessionId: 'demo',
    });
  });

  // A URL that is only text has to be selected and copied by hand, which on a
  // touch keyboard nobody does.
  test('a URL in a message is a link', async ({ page }) => {
    await bootApp(page, {
      withAgentPane: true,
      steward: {
        enabled: true,
        view: true,
        turns: [
          {
            id: 'u1',
            at: 1,
            role: 'agent',
            text: 'リリースしました: https://github.com/hrdle/hrdle/releases/tag/v0.3.157 を見てください',
          },
        ],
      },
    });

    const link = page.getByRole('link', {
      name: 'https://github.com/hrdle/hrdle/releases/tag/v0.3.157',
    });
    await expect(link).toBeVisible();
    expect(await link.getAttribute('target')).toBe('_blank');
    expect(await link.getAttribute('rel')).toContain('noopener');
    // The prose either side stays prose.
    await expect(page.getByText('を見てください')).toBeVisible();
  });

  // "Working" on its own reads the same as a screen that has stopped updating.
  test('says what it is doing, not just that it is', async ({ page }) => {
    await bootApp(page, {
      withAgentPane: true,
      indicatorState: 'processing',
      activity: { tool: 'Edit', target: 'StewardView.tsx' },
      steward: { enabled: true, view: true, turns: TURNS },
    });

    await expect(page.getByText('Edit')).toBeVisible();
    await expect(page.getByText('StewardView.tsx')).toBeVisible();
    // The bare line is what is shown when the transcript says nothing.
    await expect(page.getByText('このセッションは作業中です')).toHaveCount(0);
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

  // "The link to the original is not connected": it was, but it opened at the
  // top of a 3400-message transcript - a /clear from days ago.
  test('the original opens at its newest end when the turn names no message', async ({ page }) => {
    await boot(page);
    await page.route('**/api/sessions/history/sess-1/conversation*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [
            { id: 'm1', role: 'user', content: 'Command: /clear' },
            ...Array.from({ length: 60 }, (_, i) => ({
              id: `f${i}`,
              role: 'assistant',
              content: `filler ${i}`,
            })),
            { id: 'last', role: 'assistant', content: 'いちばん新しい発言' },
          ],
        }),
      }),
    );

    await page.getByRole('button', { name: '元の会話を見る' }).first().click();
    await expect(page.getByText('いちばん新しい発言')).toBeVisible();
  });

  test('an image can be attached to what is said', async ({ page }) => {
    await boot(page);
    await page.route('**/api/upload/image', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ path: '/tmp/shot.png', filename: 'shot.png' }),
      }),
    );

    await expect(page.getByRole('button', { name: '画像を添付' })).toBeVisible();
    await page.locator('input[type=file]').setInputFiles({
      name: 'shot.png',
      mimeType: 'image/png',
      buffer: Buffer.from('89504e47', 'hex'),
    });

    // A thumbnail, not the path pasted into the line being typed.
    await expect(page.getByRole('img', { name: '/tmp/shot.png' })).toBeVisible();
    await expect(page.getByPlaceholder('スチュワードに話しかける')).toHaveValue('');

    const posted = page.waitForRequest(
      (req) => req.url().includes('/api/steward/thread/reply') && req.method() === 'POST',
    );
    await page.getByPlaceholder('スチュワードに話しかける').fill('これを見て');
    await page.getByRole('button', { name: 'Send' }).click();

    // A field, not a path in the sentence: a screen can draw the picture from
    // it and the steward can still hand the path to an agent.
    expect(JSON.parse((await posted).postData() ?? '{}')).toEqual({
      text: 'これを見て',
      images: ['/tmp/shot.png'],
      sessionId: 'demo',
    });
  });

  // A path pasted into the sentence has no break opportunity, so the text ran
  // straight out of the bubble and read as a message with no bubble at all.
  test('a long path in the text stays inside its bubble', async ({ page }) => {
    const path = '/tmp/shots/1786883216806-049e24d2b9d09412.jpg';
    await bootApp(page, {
      withAgentPane: true,
      steward: {
        enabled: true,
        view: true,
        turns: [
          { id: 'p1', at: 1, role: 'user', text: `レイアウト壊れました？\n${path}` },
        ],
      },
    });

    const bubble = page.getByText(path);
    await expect(bubble).toBeVisible();
    const overflow = await bubble.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const parent = (el.parentElement as HTMLElement).getBoundingClientRect();
      return box.right - parent.right;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('an image attached to a turn is drawn, not written out as a path', async ({ page }) => {
    await bootApp(page, {
      withAgentPane: true,
      steward: {
        enabled: true,
        view: true,
        turns: [
          { id: 'p2', at: 1, role: 'user', text: 'ここも画像出て欲しい', images: ['/tmp/shots/a.jpg'] },
        ],
      },
    });
    await page.route('**/api/files/images/a.jpg', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/jpeg',
        body: Buffer.from('ffd8ffdb', 'hex'),
      }),
    );

    await expect(page.getByRole('img', { name: 'a.jpg' })).toBeVisible();
    await expect(page.getByText('/tmp/shots/a.jpg')).toHaveCount(0);
  });

  // Rendering nothing while it arrives read as a message sent without its
  // pictures: on a phone over LTE the two are seconds apart.
  test('a picture on its way leaves a space, not a gap', async ({ page }) => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await bootApp(page, {
      withAgentPane: true,
      steward: {
        enabled: true,
        view: true,
        turns: [{ id: 'p3', at: 1, role: 'user', text: '見てください', images: ['/tmp/shots/b.jpg'] }],
      },
    });
    await page.route('**/api/files/images/b.jpg', async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from('ffd8ffdb', 'hex') });
    });

    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
    release?.();
    await expect(page.getByRole('img', { name: 'b.jpg' })).toBeVisible();
  });

  test('an attached image can be taken off again', async ({ page }) => {
    await boot(page);
    await page.route('**/api/upload/image', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ path: '/tmp/shot.png', filename: 'shot.png' }),
      }),
    );
    await page.locator('input[type=file]').setInputFiles({
      name: 'shot.png',
      mimeType: 'image/png',
      buffer: Buffer.from('89504e47', 'hex'),
    });

    await page.getByRole('button', { name: '画像を外す' }).click();
    await expect(page.getByRole('img', { name: '/tmp/shot.png' })).toHaveCount(0);
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

    // Sending opens the thread: that is where the answer lands. And it says it
    // is working - landing on your own sentence with no sign of life is what
    // made this screen read as broken.
    await expect(page.getByText('スチュワード', { exact: true })).toBeVisible();
    await expect(page.getByText(/処理中…/)).toBeVisible();
  });

  // A question from a session is the one thing the thread still carries from
  // one, so it has to say which.
  test('a waiting question says which session it is about', async ({ page }) => {
    await bootApp(page, {
      steward: {
        enabled: true,
        view: true,
        thread: [
          {
            id: 'a1',
            at: 1,
            role: 'steward',
            kind: 'ask',
            text: '巻き戻しますか',
            sessionId: 'w5Q',
            ask: { id: 'a1', mode: 'single', choices: ['はい'] },
          },
        ],
      },
    });
    await page.locator('[data-onboarding="session-list"]').click();
    await page.getByTitle('スチュワード').click();

    await expect(page.getByText('w5Q', { exact: true })).toHaveCount(1);
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

/**
 * A workspace running two agents.
 *
 * The steward writes one history per workspace, and the phone draws a tab per
 * pane - so with the summary up, tapping a tab changed nothing on the screen
 * and read as the chat being stuck. The tabs stay: picking a pane is what they
 * are for, and the terminal is one tap away. What was missing is anything that
 * answers the tap, so the state line follows the pane and the history says
 * what it covers.
 */
test.describe('two agents in one workspace', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-mobile', 'mobile only');
  });

  const boot = (page: import('@playwright/test').Page) =>
    bootApp(page, {
      withSecondAgentPane: true,
      steward: { enabled: true, view: true, turns: TURNS },
    });

  // Removing them was the first attempt at this and the wrong one: a pane is a
  // thing someone has to be able to pick, summary or no summary.
  test('the pane tabs are still there with the summary up', async ({ page }) => {
    await boot(page);
    await expect(page.getByPlaceholder('スチュワードに話しかける')).toBeVisible();
    await expect(page.getByRole('button', { name: 'claude', exact: true })).toHaveCount(2);
  });

  test('the summary says what it covers', async ({ page }) => {
    await boot(page);
    await expect(page.getByText('ワークスペース全体')).toBeVisible();
  });

  test('one agent needs no such note', async ({ page }) => {
    await bootApp(page, {
      withAgentPane: true,
      steward: { enabled: true, view: true, turns: TURNS },
    });
    await expect(page.getByText('ワークスペース全体')).toHaveCount(0);
  });

  // The history is the workspace's, so this line is the whole of what picking
  // a pane changes - and with nothing changing at all, the tap read as broken.
  test("the state line is the picked pane's, not the workspace's", async ({ page }) => {
    await bootApp(page, {
      withSecondAgentPane: true,
      // Picked, and doing something the workspace-level field does not report.
      secondPaneActivity: { tool: 'Bash', target: 'bun test services/' },
      steward: { enabled: true, view: true, turns: TURNS },
    });

    await expect(page.getByText('bun test services/')).toBeVisible();
  });
});

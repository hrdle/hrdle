import { expect, test } from '@playwright/test';
import {
  type LayoutVariant,
  actionTestId,
  actionsFor,
} from '../../../src/actions/sessionActions';
import { bootApp } from './fixtures';

/**
 * The guard the single definition exists for.
 *
 * Layout parity checked that each viewport rendered *a* tree; it could not see
 * that a control the desktop had never reached the phone, because nothing said
 * which controls a layout was supposed to have. `SESSION_ACTIONS` now does, and
 * this reads it: adding an action to the table and forgetting one of the three
 * bars fails here rather than months later, when someone reaches for it on a
 * phone and finds nothing.
 *
 * It asserts the definition is honoured, not that every action is everywhere -
 * `availableOn` records real differences between a phone and a desktop, and
 * widening one is a product decision rather than a parity bug.
 */
const VARIANT: Record<string, LayoutVariant> = {
  'responsive-desktop': 'desktop',
  'responsive-tablet': 'tablet',
  'responsive-mobile': 'mobile',
};

test.describe('session action parity', () => {
  test('every action this layout declares is on screen', async ({ page }) => {
    await bootApp(page);

    const variant = VARIANT[test.info().project.name];
    // A session with no agent hides chat and the Claude app link; the stub boots
    // one of those, so those two are checked by their absence below instead.
    const expected = actionsFor(variant).filter(
      (a) => !['chat', 'claude-app'].includes(a.id),
    );
    expect(expected.length).toBeGreaterThan(0);

    for (const action of expected) {
      await expect(
        page.getByTestId(actionTestId(action.id)),
        `${variant} is missing the "${action.id}" control`,
      ).toBeVisible();
    }
  });

  test('and nothing another layout owns', async ({ page }) => {
    await bootApp(page);

    const variant = VARIANT[test.info().project.name];
    const mine = new Set(actionsFor(variant).map((a) => a.id));
    const theirs = (['mobile', 'tablet', 'desktop'] as const)
      .flatMap((v) => actionsFor(v))
      .filter((a) => !mine.has(a.id));

    for (const action of theirs) {
      await expect(
        page.getByTestId(actionTestId(action.id)),
        `${variant} renders "${action.id}", which its definition does not name`,
      ).toHaveCount(0);
    }
  });
});

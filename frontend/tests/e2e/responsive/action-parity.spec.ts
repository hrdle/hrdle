import { expect, test } from '@playwright/test';
import {
  SESSION_ACTIONS,
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
 * `surface` records real differences between a phone and a desktop, and
 * widening one is a product decision rather than a parity bug.
 *
 * Both surfaces are checked. A layout draws a control either in its session bar
 * or on the pane header, never in both, so "somewhere on this layout" is the
 * question worth asking - a control that moved between the two by accident is
 * as broken as one that vanished.
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
    // These need something of the session before they appear at all: an agent to
    // chat with or open in the Claude app, and a second pane to zoom or close.
    // The stub boots neither, so they are checked by their absence below.
    const CONDITIONAL = ['chat', 'claude-app', 'zoom', 'close-pane'];
    const expected = [
      ...actionsFor(variant, 'bar'),
      ...actionsFor(variant, 'pane'),
    ].filter((a) => !CONDITIONAL.includes(a.id));
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
    const theirs = SESSION_ACTIONS.filter((a) => a.surface[variant] === null);

    for (const action of theirs) {
      await expect(
        page.getByTestId(actionTestId(action.id)),
        `${variant} renders "${action.id}", which its definition does not name`,
      ).toHaveCount(0);
    }
  });
});

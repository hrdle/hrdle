import { expect, test } from '@playwright/test';
import { bootApp } from './fixtures';

/**
 * Guards the class of bug that shipped in the update prompt: a control that
 * looks fine on a desktop viewport but is too small to hit on a phone.
 *
 * The bar is deliberately below the 44px platform guideline — the app scales
 * its own spacing off a 14px root font, so 44px would flag most of the existing
 * chrome. This catches "obviously untappable", not "not ideal".
 */
const MIN_TOUCH_PX = 32;

/**
 * Controls that were already under the bar when this check landed. They are
 * recorded rather than silently tolerated: the point of this spec is to stop
 * *new* ones, and fixing these three means reflowing session bars that need
 * their own visual pass at every width.
 *
 * Tracked in #514. Delete entries as they are fixed; never add one.
 */
const KNOWN_TOO_SMALL = [
  // mobile: session switcher in the bottom bar
  'div.h-full.w-full > div.fixed.bottom-0 > div.flex.items-center > button.flex.flex-1',
  // tablet: session selector in the header
  'div.flex-1.flex > div.shrink-0.select-none > div.flex.items-center > button.flex.items-center',
  // tablet: chat/terminal toggle in the pane header
  'div.h-full.flex > div.flex.items-center > div.flex.items-center > button.p-2.rounded',
];

test.describe('touch targets', () => {
  test.skip(
    () => !test.info().project.use.hasTouch,
    'only meaningful on touch viewports',
  );

  test('interactive controls are big enough to tap', async ({ page }) => {
    await bootApp(page);

    const tooSmall = await page.evaluate((min) => {
      const controls = document.querySelectorAll<HTMLElement>(
        'button, a[href], [role="button"]',
      );
      const violations: Array<{
        label: string;
        w: number;
        h: number;
        path: string;
      }> = [];

      for (const el of controls) {
        const rect = el.getBoundingClientRect();
        // Skip anything not actually on screen — hidden menus, offscreen
        // drawers, and zero-size wrappers are not tap targets.
        if (rect.width === 0 || rect.height === 0) continue;
        if (getComputedStyle(el).visibility === 'hidden') continue;
        if (rect.bottom < 0 || rect.top > innerHeight) continue;
        if (rect.right < 0 || rect.left > innerWidth) continue;

        if (rect.height < min) {
          // A DOM path makes the failure actionable — the label alone is often
          // dynamic data that appears nowhere in the source.
          const path: string[] = [];
          for (let node: HTMLElement | null = el, i = 0; node && i < 4; i++) {
            const cls = node.className
              ?.toString()
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .join('.');
            path.unshift(node.tagName.toLowerCase() + (cls ? `.${cls}` : ''));
            node = node.parentElement;
          }
          violations.push({
            label:
              el.getAttribute('aria-label') ||
              el.getAttribute('title') ||
              el.textContent?.trim().slice(0, 30) ||
              el.tagName.toLowerCase(),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            path: path.join(' > '),
          });
        }
      }
      return violations;
    }, MIN_TOUCH_PX);

    const regressions = tooSmall.filter(
      (v) => !KNOWN_TOO_SMALL.includes(v.path),
    );

    expect(
      regressions,
      `controls under ${MIN_TOUCH_PX}px tall:\n${regressions
        .map((v) => `  - "${v.label}" ${v.w}x${v.h}  @ ${v.path}`)
        .join('\n')}`,
    ).toEqual([]);
  });
});

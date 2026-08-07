/**
 * Captured from a live OpenCode 1.18.13 pane on 2026-08-06, escape sequences
 * and all: the permission prompt it draws before touching a path outside the
 * project. Kept verbatim rather than hand-written, because the whole point of
 * the reader is that these two rows are the same shape as text and differ only
 * in how they are painted - a fixture typed from memory would lose the very
 * thing under test.
 */

/** `   Allow once   Allow always   Reject`, with `Allow once` highlighted. */
export const OPENCODE_PERMISSION_ROW =
  '\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;10;10;10m  \x1b[0m\x1b[38;2;245;167;66m\x1b[48;2;20;20;20m┃\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  \x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;245;167;66m \x1b[0m\x1b[38;2;10;10;10m\x1b[48;2;245;167;66mAllow once\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;245;167;66m \x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mAllow always\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m   \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mReject\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m            \x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;10;10;10m  \x1b[0m'

/** `  ctrl+f fullscreen  \u21c6 select  enter confirm` - the key hints directly
 *  under it, which look like a menu and are not one. */
export const OPENCODE_FOOTER_ROW =
  '\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;10;10;10m  \x1b[0m\x1b[38;2;245;167;66m\x1b[48;2;20;20;20m┃\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  \x1b[0m\x1b[38;2;238;238;238m\x1b[48;2;30;30;30mctrl+f \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mfullscreen\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  \x1b[0m\x1b[38;2;238;238;238m\x1b[48;2;30;30;30m⇆ \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mselect\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  \x1b[0m\x1b[38;2;238;238;238m\x1b[48;2;30;30;30menter \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mconfirm\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m     \x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;10;10;10m  \x1b[0m'

/**
 * The same prompt on a wider pane (121 columns, OpenCode 1.18.14), where the
 * options and the key hints share ONE line instead of taking two.
 *
 * Which shape appears is decided by the pane's width, not by the version - so
 * a reader that only ever saw the narrow capture above would work on a phone
 * and fail on a desktop-sized pane. Captured by the work-1 session and checked
 * against this module before it was believed.
 */
export const OPENCODE_PERMISSION_ROW_WIDE =
  '\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;10;10;10m  \x1b[0m\x1b[38;2;245;167;66m\x1b[48;2;20;20;20m┃\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  \x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;245;167;66m \x1b[0m\x1b[38;2;10;10;10m\x1b[48;2;245;167;66mAllow once\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;245;167;66m \x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mAllow always\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m   \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mReject\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m                                 \x1b[0m\x1b[38;2;238;238;238m\x1b[48;2;30;30;30mctrl+f \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mfullscreen\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  \x1b[0m\x1b[38;2;238;238;238m\x1b[48;2;30;30;30m⇆ \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mselect\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  \x1b[0m\x1b[38;2;238;238;238m\x1b[48;2;30;30;30menter \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mconfirm\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m   \x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;10;10;10m  \x1b[0m\r'

/**
 * Claude Code's AskUserQuestion tab bar, captured verbatim from a live pane on
 * 2026-08-07: `\u2190  \u2612 \u8907\u6570\u9078\u629e  \u2714 Submit  \u2192`.
 *
 * Not an OpenCode capture, and here because it is the shape that broke the
 * reader in a wearer's hands. The arrows carry no letters or digits so they are
 * dropped as furniture, and of the two items left only the active tab is
 * painted differently - which is exactly the rule this module recognises a menu
 * by. It opened a two-option picker reading "複数選択 / Submit" on a question
 * that was working perfectly well.
 */
export const CLAUDE_QUESTION_TAB_BAR =
  '←  ☒ 複数選択 \x1b[0m\x1b[38;2;0;0;0m\x1b[48;2;177;185;249m ✔ Submit \x1b[0m\x1b[38;2;153;153;153m →\x1b[0m'

/**
 * Kimi's AskUserQuestion tab bar, in both the states it draws, captured from a
 * live kimi-k3 pane on 2026-08-08.
 *
 * The same trap as `CLAUDE_QUESTION_TAB_BAR` and it got through, because kimi
 * wraps its tick instead of leading with one. A wearer was offered
 * `intro.lead / Submit` as the answer to a question about lead sentences
 * (recorded in the picker at 05:41), where tapping switches tabs while looking
 * like an answer.
 *
 * Two states because the tick is not always there, and only the first can be
 * recognised by its shape: in the second the row is a highlighted item and a
 * plain one, which is exactly what a real menu is. What survives in both is the
 * word `Submit` - an action the bar carries, not an answer to anything.
 */

/** `(✓) intro.lead   Submit`, with `Submit` highlighted. */
export const KIMI_QUESTION_TAB_BAR_TICKED =
  '  \x1b[0m\x1b[38;2;78;200;126m(✓) intro.lead\x1b[0m  \x1b[0m\x1b[1m\x1b[38;2;224;224;224m\x1b[48;2;79;168;255m Submit \x1b[0m\r'

/** The same bar with the tab itself active and no tick drawn at all. */
export const KIMI_QUESTION_TAB_BAR_PLAIN =
  '  \x1b[0m\x1b[1m\x1b[38;2;224;224;224m\x1b[48;2;79;168;255m intro.lead \x1b[0m  \x1b[0m\x1b[38;2;136;136;136m Submit \x1b[0m\r'

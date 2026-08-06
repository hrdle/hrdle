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

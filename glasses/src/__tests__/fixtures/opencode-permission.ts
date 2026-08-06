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

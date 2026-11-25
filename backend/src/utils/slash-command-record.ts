/**
 * The slash command a transcript record stands for, as the person typed it.
 *
 * Claude Code writes a command as tags rather than as the text that was
 * submitted - `<command-name>/compact</command-name>` beside a
 * `<command-message>` and a `<command-args>` - and in either order, depending
 * on whether it is a built-in or a skill. Reading it back as `/name args` is
 * what the person will recognise as their own turn.
 */
export function slashCommandText(content: string): string | null {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(content)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(content)?.[1]?.trim() ?? '';
  const command = name.startsWith('/') ? name : `/${name}`;
  return args ? `${command} ${args}` : command;
}

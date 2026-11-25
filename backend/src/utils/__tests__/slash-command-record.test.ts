import { describe, expect, it } from 'bun:test';
import { slashCommandText } from '../slash-command-record';

describe('slashCommandText', () => {
  it('reads a built-in command', () => {
    expect(
      slashCommandText(
        '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>',
      ),
    ).toBe('/compact');
  });

  it('reads a skill, whose message comes first', () => {
    expect(
      slashCommandText('<command-message>hello</command-message>\n<command-name>/hello</command-name>'),
    ).toBe('/hello');
  });

  it('keeps the arguments, including markup characters', () => {
    expect(
      slashCommandText(
        '<command-message>release</command-message>\n<command-name>/release</command-name>\n<command-args>patch <now></command-args>',
      ),
    ).toBe('/release patch <now>');
  });

  it('adds the slash when the name lacks one', () => {
    expect(slashCommandText('<command-name>model</command-name>')).toBe('/model');
  });

  it('is null for anything else', () => {
    expect(slashCommandText('fix the bug')).toBeNull();
    expect(slashCommandText('<local-command-stdout>done</local-command-stdout>')).toBeNull();
  });
});

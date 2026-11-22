import { describe, expect, test } from 'bun:test';
import {
  AGENT_PROVIDER_IDS,
  AGENT_PROVIDERS,
  CreateSessionSchema,
  agentResumeCommand,
  agentSupportsConversationMetadata,
  detectAgentProviderFromArgs,
  threadAgentOf,
} from '../../../shared/types';
import { homedir } from 'node:os';
import { expandHome, findDuplicateAgentWorkingDirSession, shellQuote } from '../../src/routes/sessions';

describe('Agent provider registry', () => {
  test('derives provider IDs from the registry', () => {
    expect(AGENT_PROVIDER_IDS).toContain('claude');
    expect(AGENT_PROVIDER_IDS).toContain('codex');
    expect([...AGENT_PROVIDER_IDS].join(',')).toBe(Object.keys(AGENT_PROVIDERS).join(','));
  });

  test('defaults create-session agent to Claude', () => {
    const parsed = CreateSessionSchema.parse({ name: 'example' });

    expect(parsed.agent).toBe('claude');
  });

  test('accepts Codex as a create-session agent', () => {
    const parsed = CreateSessionSchema.parse({ name: 'example', agent: 'codex' });

    expect(parsed.agent).toBe('codex');
  });

  test('accepts Grok as a create-session agent', () => {
    const parsed = CreateSessionSchema.parse({ name: 'example', agent: 'grok' });

    expect(parsed.agent).toBe('grok');
  });

  test('accepts Kimi as a create-session agent', () => {
    const parsed = CreateSessionSchema.parse({ name: 'example', agent: 'kimi' });

    expect(parsed.agent).toBe('kimi');
  });

  test('rejects unsupported create-session agents', () => {
    const parsed = CreateSessionSchema.safeParse({ name: 'example', agent: 'gemini' });

    expect(parsed.success).toBe(false);
  });

  test('detects supported providers from process args', () => {
    expect(detectAgentProviderFromArgs('claude')).toBe('claude');
    expect(detectAgentProviderFromArgs('/usr/local/bin/claude --resume')).toBe('claude');
    expect(detectAgentProviderFromArgs('/home/user/.local/share/claude/versions/2.1.123/claude')).toBe('claude');
    expect(detectAgentProviderFromArgs('codex')).toBe('codex');
    expect(detectAgentProviderFromArgs('/home/user/.bun/install/global/node_modules/@openai/codex/bin/codex.js')).toBe('codex');
    expect(detectAgentProviderFromArgs('grok')).toBe('grok');
    expect(detectAgentProviderFromArgs('/home/user/.grok/bin/grok -p prompt')).toBe('grok');
    expect(detectAgentProviderFromArgs('kimi')).toBe('kimi');
    expect(detectAgentProviderFromArgs('/home/user/.kimi-code/bin/kimi --session session_abc')).toBe('kimi');
  });

  test('does not detect provider names inside unrelated paths', () => {
    expect(detectAgentProviderFromArgs('/tmp/.claude/shell-snapshots/claude-foo-cwd')).toBeUndefined();
    expect(detectAgentProviderFromArgs('/tmp/codex-project/run.sh')).toBeUndefined();
    expect(detectAgentProviderFromArgs('vim /home/user/.grok/config.toml')).toBeUndefined();
  });

  test('threadAgentOf identifies thread-based agents only', () => {
    expect(threadAgentOf('codex')).toBe('codex');
    expect(threadAgentOf('grok')).toBe('grok');
    expect(threadAgentOf('kimi')).toBe('kimi');
    expect(threadAgentOf('claude')).toBeUndefined();
    expect(threadAgentOf('bash')).toBeUndefined();
    expect(threadAgentOf(undefined)).toBeUndefined();
  });

  test('exposes provider capabilities', () => {
    expect(agentSupportsConversationMetadata('claude')).toBe(true);
    expect(agentSupportsConversationMetadata('codex')).toBe(false);
    expect(agentSupportsConversationMetadata('unknown')).toBe(false);
  });

  test('quotes paths for shell commands', () => {
    expect(shellQuote('/tmp/plain path')).toBe("'/tmp/plain path'");
    expect(shellQuote("/tmp/it's-here")).toBe("'/tmp/it'\\''s-here'");
  });

  test('expands ~ to the home directory before quoting', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/foo')).toBe(`${homedir()}/foo`);
    expect(expandHome('/abs/path')).toBe('/abs/path');
    expect(expandHome('~user/foo')).toBe('~user/foo');
  });

  test('detects duplicate working directories only for the same agent', () => {
    const sessions = [
      { name: 'claude-repo', agent: 'claude', currentCommand: 'claude', currentPath: '/repo' },
      { name: 'codex-other', agent: 'codex', currentCommand: 'codex', currentPath: '/other' },
    ];

    expect(findDuplicateAgentWorkingDirSession(sessions, 'claude', '/repo')?.name).toBe('claude-repo');
    expect(findDuplicateAgentWorkingDirSession(sessions, 'codex', '/repo')).toBeUndefined();
  });

  test('uses currentCommand for duplicate detection when agent is missing', () => {
    const sessions = [
      { name: 'legacy-codex', currentCommand: 'codex', currentPath: '/repo' },
    ];

    expect(findDuplicateAgentWorkingDirSession(sessions, 'codex', '/repo')?.name).toBe('legacy-codex');
  });

  test('builds resume commands per agent', () => {
    expect(agentResumeCommand('claude')).toBe('claude -r');
    // session id is single-quoted (typed into an interactive shell) — #234
    expect(agentResumeCommand('claude', 'abc-123')).toBe("claude -r 'abc-123'");
    expect(agentResumeCommand('codex')).toBe('codex resume');
    expect(agentResumeCommand('codex', 'thread-xyz')).toBe("codex resume 'thread-xyz'");
    expect(agentResumeCommand('grok')).toBe('grok --resume');
    expect(agentResumeCommand('grok', 'session-abc')).toBe("grok --resume 'session-abc'");
    expect(agentResumeCommand('kimi')).toBe('kimi --session');
    expect(agentResumeCommand('kimi', 'session-abc')).toBe("kimi --session 'session-abc'");
  });
});

import { homedir } from 'node:os';

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return `${homedir()}${value.slice(1)}`;
  return value;
}

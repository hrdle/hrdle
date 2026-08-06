import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createInterface } from 'node:readline';
import type { SessionMetrics } from '../../../shared/types';
import { claudeProjectDirName } from '../utils/claude-project-path';
import { locateSessionFile } from '../utils/locate-session-file';
import { getMaxInputTokens } from './anthropic-models';

const CONTEXT_MAX_DEFAULT = 200_000;

function pathToProjectDir(workingDir: string): string {
  return path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(workingDir));
}

interface ProcessTable {
  tree: Map<number, number[]>;   // ppid -> [child pids]
  rss: Map<number, number>;      // pid -> RSS bytes
}

let psCache: { timestamp: number; table: ProcessTable } | null = null;
const PS_CACHE_TTL_MS = 1000;

async function getProcessTable(): Promise<ProcessTable> {
  if (psCache && Date.now() - psCache.timestamp < PS_CACHE_TTL_MS) {
    return psCache.table;
  }
  // `ps -A -o pid=,ppid=,rss=` works identically on Linux and macOS.
  // `=` suppresses the header; RSS is in kilobytes on both platforms.
  const proc = Bun.spawn(['ps', '-A', '-o', 'pid=,ppid=,rss='], { stdout: 'pipe', stderr: 'pipe' });
  const text = await new Response(proc.stdout).text();
  await proc.exited;

  const rss = new Map<number, number>();
  const tree = new Map<number, number[]>();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!m?.[1] || !m[2] || !m[3]) continue;
    const pid = Number.parseInt(m[1], 10);
    const ppid = Number.parseInt(m[2], 10);
    const rssKb = Number.parseInt(m[3], 10);
    rss.set(pid, rssKb * 1024);
    const children = tree.get(ppid);
    if (children) children.push(pid);
    else tree.set(ppid, [pid]);
  }
  const table: ProcessTable = { tree, rss };
  psCache = { timestamp: Date.now(), table };
  return table;
}

async function getProcessTreeRSS(pid: number): Promise<number> {
  const { tree, rss } = await getProcessTable();
  const queue: number[] = [pid];
  const visited = new Set<number>();
  let totalBytes = 0;
  while (queue.length > 0) {
    const p = queue.shift();
    if (p === undefined || visited.has(p)) continue;
    visited.add(p);
    totalBytes += rss.get(p) ?? 0;
    const children = tree.get(p);
    if (children) for (const c of children) if (!visited.has(c)) queue.push(c);
  }
  return totalBytes;
}

interface JsonlCacheEntry {
  mtimeMs: number;
  size: number;
  totalInputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalOutputTokens: number;
  contextTokens: number;
  latestModel?: string;
}

const jsonlCache = new Map<string, JsonlCacheEntry>();

async function readJsonlUsage(filePath: string): Promise<{
  totalInputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalOutputTokens: number;
  contextTokens: number;
  latestModel?: string;
} | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    const cached = jsonlCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached;
    }

    let totalInputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;
    let totalOutputTokens = 0;
    let contextTokens = 0;
    let latestModel: string | undefined;

    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of rl) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        const usage = obj?.message?.usage;
        if (usage && typeof usage === 'object') {
          const inTok = Number(usage.input_tokens) || 0;
          const createTok = Number(usage.cache_creation_input_tokens) || 0;
          const readTok = Number(usage.cache_read_input_tokens) || 0;
          const outTok = Number(usage.output_tokens) || 0;
          totalInputTokens += inTok;
          totalCacheCreationTokens += createTok;
          totalCacheReadTokens += readTok;
          totalOutputTokens += outTok;
          // Last assistant message's effective context = in + cache_creation + cache_read
          contextTokens = inTok + createTok + readTok;
          const model = obj?.message?.model;
          if (typeof model === 'string' && model && model !== '<synthetic>') {
            latestModel = model;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    const entry: JsonlCacheEntry = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      totalInputTokens,
      totalCacheCreationTokens,
      totalCacheReadTokens,
      totalOutputTokens,
      contextTokens,
      latestModel,
    };
    jsonlCache.set(filePath, entry);
    return entry;
  } catch {
    return null;
  }
}

export interface MetricsInput {
  ccSessionId?: string;
  workingDir?: string;
  pids?: (number | undefined)[];
}

export async function computeSessionMetrics(input: MetricsInput): Promise<SessionMetrics | undefined> {
  const { ccSessionId, workingDir, pids } = input;
  const metrics: SessionMetrics = {};

  if (ccSessionId && workingDir) {
    const projectDir = pathToProjectDir(workingDir);
    const byPath = path.join(projectDir, `${ccSessionId}.jsonl`);
    // The cwd names a project directory that may never have been written to —
    // rename a working directory under a running agent and it stops matching.
    // The id is unique, so a scan of every project settles it.
    const filePath = fs.existsSync(byPath)
      ? byPath
      : ((await locateSessionFile(ccSessionId)) ?? byPath);
    const usage = await readJsonlUsage(filePath);
    if (usage) {
      const max = await getMaxInputTokens(usage.latestModel ?? undefined);
      const contextMaxTokens = max > 0 ? max : CONTEXT_MAX_DEFAULT;
      metrics.contextTokens = usage.contextTokens;
      metrics.contextMaxTokens = contextMaxTokens;
      metrics.contextPercent = contextMaxTokens > 0
        ? Math.min(100, Math.round((usage.contextTokens / contextMaxTokens) * 1000) / 10)
        : undefined;
      metrics.totalInputTokens = usage.totalInputTokens;
      metrics.totalCacheCreationTokens = usage.totalCacheCreationTokens;
      metrics.totalCacheReadTokens = usage.totalCacheReadTokens;
      metrics.totalOutputTokens = usage.totalOutputTokens;
      // Effective usage = input + cache_creation + output (cache_read is billed at 10%, treated as noise)
      metrics.totalTokens = usage.totalInputTokens + usage.totalCacheCreationTokens + usage.totalOutputTokens;
      metrics.model = usage.latestModel;
    }
  }

  if (pids && pids.length > 0) {
    const validPids = pids.filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
    if (validPids.length > 0) {
      let total = 0;
      for (const pid of validPids) {
        total += await getProcessTreeRSS(pid);
      }
      metrics.memoryRssBytes = total;
    }
  }

  if (Object.keys(metrics).length === 0) return undefined;
  return metrics;
}

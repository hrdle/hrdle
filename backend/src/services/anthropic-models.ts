import { VERSION } from '../cli';
import { userAgent } from '../../../shared/identity';
import { getClaudeAccessToken } from '../utils/claude-credentials';

interface ModelInfo {
  id: string;
  max_input_tokens: number;
}

interface ModelsListResponse {
  data: ModelInfo[];
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FALLBACK_MAX_TOKENS = 200_000;

let cache: { timestamp: number; map: Map<string, number> } | null = null;
let inflight: Promise<Map<string, number>> | null = null;

async function fetchModels(): Promise<Map<string, number>> {
  const token = await getClaudeAccessToken();
  if (!token) return new Map();
  try {
    const response = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': userAgent(VERSION),
      },
    });
    if (!response.ok) return new Map();
    const data = (await response.json()) as ModelsListResponse;
    const map = new Map<string, number>();
    for (const m of data.data ?? []) {
      if (m.id && typeof m.max_input_tokens === 'number') {
        map.set(m.id, m.max_input_tokens);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

async function getModelMap(): Promise<Map<string, number>> {
  const now = Date.now();
  if (cache && now - cache.timestamp < CACHE_TTL_MS && cache.map.size > 0) {
    return cache.map;
  }
  if (!inflight) {
    inflight = fetchModels()
      .then((map) => {
        if (map.size > 0) cache = { timestamp: now, map };
        return map;
      })
      .finally(() => {
        inflight = null;
      });
  }
  // Every caller of a failed refresh gets the last catalog, not only the one
  // that started the refresh. The callers that joined it were handed the
  // empty result instead, and with the session list computing every session
  // at once, one refresh gave the same model two windows.
  const map = await inflight;
  return cache?.map ?? map;
}

/**
 * Windows resolved once, by model id, kept for the life of the process.
 *
 * A model can be in one listing and not the next - a new one the catalog
 * carries intermittently - and every listing with anything in it replaces the
 * cache. With the flat fallback answering the misses, a session's window
 * halved and its bar jumped to 100% between one refresh and the next, then
 * back. A window once read is not forgotten for a listing that left it out.
 */
const known = new Map<string, number>();

export async function getMaxInputTokens(modelId: string | undefined): Promise<number> {
  if (!modelId) return FALLBACK_MAX_TOKENS;
  const map = await getModelMap();
  const fresh = map.get(modelId);
  if (fresh) {
    known.set(modelId, fresh);
    return fresh;
  }
  return known.get(modelId) ?? FALLBACK_MAX_TOKENS;
}

/** Tests only: forget the catalog so the next call fetches again. */
export function forgetModelCatalogForTest(): void {
  cache = null;
  inflight = null;
}

/** Tests only: keep the catalog but make it due for a refresh. */
export function ageModelCatalogForTest(): void {
  if (cache) cache = { ...cache, timestamp: 0 };
}

/** Tests only: forget the windows already resolved. */
export function forgetKnownWindowsForTest(): void {
  known.clear();
}

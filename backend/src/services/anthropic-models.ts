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
  if (inflight) return inflight;
  inflight = fetchModels();
  try {
    const map = await inflight;
    if (map.size > 0) {
      cache = { timestamp: now, map };
    }
    return cache?.map ?? map;
  } finally {
    inflight = null;
  }
}

export async function getMaxInputTokens(modelId: string | undefined): Promise<number> {
  if (!modelId) return FALLBACK_MAX_TOKENS;
  const map = await getModelMap();
  return map.get(modelId) ?? FALLBACK_MAX_TOKENS;
}

/**
 * Where a transcription is sent. **This module is the only answer.**
 *
 * The sender (`routes/glasses.ts`) and the usage tally
 * (`services/stt-usage.ts`) must never resolve the destination
 * separately: the failure mode is a dashboard that keeps naming Groq and its
 * prices while speech actually goes to a server in the next room. Both read
 * `sttTargets()`, so they cannot disagree.
 *
 * The request is the OpenAI transcription shape, so any endpoint speaking it
 * can stand in for Groq - a local Whisper, whisper.cpp's server, a commercial
 * OpenAI-compatible service. Pointed at a machine of one's own, audio never
 * leaves the tailnet.
 *
 * Which of the two transcribers speech goes to first is `sttProvider` in the
 * glasses settings. Unset, it derives from what exists - the custom endpoint
 * when one is configured, Groq otherwise - so an untouched install behaves
 * exactly as before this module existed. The fallback (`sttFallback`, default
 * on) is **the other one**, in either direction: a custom endpoint that stops
 * answering falls back to Groq, and someone keeping Groq first still gets
 * speech that survives a Groq outage if a custom server is standing there.
 */

import { loadGlassesSettings } from './glasses-settings';
import { type SttRequest, resolveSttRequest } from './stt-request';

export interface SttTarget {
  url: string;
  model: string;
  /** Whether the target requires an API key. A keyless target must not turn
   *  a missing key into a 503. */
  needsKey: boolean;
  /**
   * Which stored key authenticates this target.
   *
   * A key belongs to one destination. Sending one key to whatever URL is
   * configured hands the Groq key to a host somebody typed - and to a plain
   * `http://` one, in cleartext - with no way to decline.
   */
  keySource: 'groq' | 'endpoint';
  /** Whether requests here spend billed quota. Cost accounting keys on this. */
  billed: boolean;
  /** Short name for logs and the dashboard's narrow column. */
  label: string;
}

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';

const GROQ: SttTarget = {
  url: GROQ_URL,
  model: GROQ_MODEL,
  needsKey: true,
  keySource: 'groq',
  billed: true,
  label: 'Groq',
};

/** The built-in billed target, at a given model. Exported for the usage
 *  summary's test-facing default. */
export function groqTarget(model: string = GROQ_MODEL): SttTarget {
  return { ...GROQ, model };
}

/** Display name for a target. An IP stays as it is; a hostname keeps only its
 *  first label - a Tailscale FQDN does not fit the dashboard column. */
function hostOf(url: string): string {
  try {
    const { hostname } = new URL(url);
    return /^[\d.]+$/.test(hostname) ? hostname : hostname.split('.')[0];
  } catch {
    return url;
  }
}

/**
 * The configured custom endpoint, if any, with where the answer came from.
 *
 * `source` feeds the settings screen's status line: without it, a screen has
 * no way to say whether "Groq" means "chosen" or "nothing else configured".
 */
export interface SttEndpointResolution {
  url?: string;
  model?: string;
  source: 'setting' | 'none';
}

export async function resolveSttEndpoint(): Promise<SttEndpointResolution> {
  const stored = await loadGlassesSettings();
  if (stored.sttEndpointUrl) {
    return { url: stored.sttEndpointUrl, model: stored.sttEndpointModel, source: 'setting' };
  }
  return { source: 'none' };
}

/**
 * Primary and fallback, decided once. **Every runtime path goes through
 * here** - delivery via `resolveSttDelivery`, the dashboard via
 * `getUsageSummary` - which is what makes "where does speech go" a question
 * with one answer.
 *
 * A provider choice pointing at nothing resolves to Groq rather than failing
 * every utterance: a wearer who selected "custom server" before typing a URL
 * has expressed an intent, not configured a target.
 */
export async function sttTargets(defaultModel: string = GROQ_MODEL): Promise<{
  primary: SttTarget;
  fallback: SttTarget | null;
  source: SttEndpointResolution['source'];
  provider: 'groq' | 'custom';
  providerSource: 'setting' | 'default';
  /** The stored intent, apart from whether a fallback target exists to use. */
  fallbackOn: boolean;
}> {
  const endpoint = await resolveSttEndpoint();
  const stored = await loadGlassesSettings();

  const custom: SttTarget | null = endpoint.url
    ? {
        url: endpoint.url,
        // The model rides with its URL: a custom server names its own models,
        // and pairing Groq's names with someone else's URL 400s every
        // utterance.
        model: endpoint.model || defaultModel,
        // Not *required*: a local Whisper runs keyless, and a missing key must
        // not 503. A commercial compatible endpoint that does want one is
        // given `sttEndpointKey`, never Groq's.
        needsKey: false,
        keySource: 'endpoint',
        billed: false,
        label: hostOf(endpoint.url),
      }
    : null;
  const groq: SttTarget = { ...GROQ, model: defaultModel };

  const fallbackOn = stored.sttFallback !== 'off';
  const provider =
    (stored.sttProvider ?? (custom ? 'custom' : 'groq')) === 'custom' && custom
      ? 'custom'
      : 'groq';

  return {
    primary: provider === 'custom' && custom ? custom : groq,
    fallback:
      provider === 'custom' ? (fallbackOn ? groq : null) : fallbackOn && custom ? custom : null,
    source: endpoint.source,
    provider,
    // `setting` only when the stored choice is the one in force. Choosing
    // `custom` before typing a URL resolves to Groq, and reporting that as
    // chosen tells the screen "Groq, by you" about a decision nobody made.
    providerSource: stored.sttProvider === provider ? 'setting' : 'default',
    fallbackOn,
  };
}

/**
 * How long a primary known to be down is skipped before it is tried again.
 *
 * A machine that is up but refusing connections answers instantly; a machine
 * that is asleep or unplugged answers never, and every request would wait out
 * the full connect timeout before falling back. One minute balances "come
 * back soon after the machine wakes" against "do not spend every utterance
 * waiting on a machine that is off".
 */
const PRIMARY_RETRY_MS = 60_000;

let primaryDownSince = 0;
/**
 * Which primary the down-window is about. Global state alone would send a
 * freshly selected provider through the OLD one's penalty box for up to a
 * minute: the wearer switches providers and the switch looks ineffective.
 * The window travels with the URL that earned it.
 */
let primaryDownUrl: string | null = null;
let lastFallbackAt: string | undefined;

/**
 * Whether the down-window is still open. Answered by comparing clocks rather
 * than by expiring state on read: `/stt-preview` calls into this too, and a
 * read-only query must never change what the next transcription does.
 */
function withinRetryWindow(): boolean {
  return primaryDownSince > 0 && Date.now() - primaryDownSince < PRIMARY_RETRY_MS;
}

/** The primary did not answer. An open window is not extended - the first
 *  failure's clock is the honest one - but a *different* primary starts its
 *  own window: the old URL's penalty must not transfer. */
export function notePrimaryDown(url: string): void {
  if (!withinRetryWindow() || primaryDownUrl !== url) {
    primaryDownSince = Date.now();
    primaryDownUrl = url;
  }
}

/** The primary answered. The watch is over. */
export function notePrimaryUp(): void {
  primaryDownSince = 0;
  primaryDownUrl = null;
}

/** A transcription went through the fallback. */
export function noteFallbackUsed(): void {
  lastFallbackAt = new Date().toISOString();
}

/** Whether to start at the fallback instead of retrying a primary known to be
 *  down. Only for the *same* primary the window was earned by. */
export function shouldSkipPrimary(primaryUrl: string): boolean {
  return withinRetryWindow() && primaryDownUrl === primaryUrl;
}

/** Dashboard state: whether the primary is being skipped, and when the
 *  fallback last carried a transcription. */
export function sttHealth(primaryUrl?: string): { primaryDown: boolean; lastFallbackAt?: string } {
  const down = withinRetryWindow() && (primaryUrl === undefined || primaryDownUrl === primaryUrl);
  return { primaryDown: down, lastFallbackAt };
}

/** Test hook: clear the in-process health state. */
export function resetSttHealth(): void {
  primaryDownSince = 0;
  primaryDownUrl = null;
  lastFallbackAt = undefined;
}

/** The targets one transcription will try, in order. The first is the one
 *  being sent to right now. */
export interface SttAttempt {
  target: SttTarget;
  isPrimary: boolean;
}

/**
 * What `/stt-preview` reports: the resolved request, with the delivery's own
 * facts layered on.
 *
 * `model` is replaced with **the model actually being sent** - it differs
 * from the settings' chosen model only when a custom endpoint names its own,
 * and then `modelSource` says `endpoint`.
 */
export interface SttDeliveryPreview extends Omit<SttRequest, 'model' | 'modelSource'> {
  /** Wider than the Groq model union: a custom endpoint names its own. */
  model: string;
  modelSource: SttRequest['modelSource'] | 'endpoint';
  /** Short name of the target being sent to right now. */
  destination: string;
  /** Where a failed request escapes to; null when nowhere. */
  fallback: string | null;
}

export interface SttDelivery {
  attempts: SttAttempt[];
  preview: SttDeliveryPreview;
}

/**
 * Decide *what* is sent and *where* in one call. **Delivery and preview both
 * read this**, extending the guarantee `resolveSttRequest()` already makes -
 * "what the preview reports is what the transcription sends" - across the
 * destination. Split into two resolvers with a precedence rule each, that
 * guarantee quietly breaks the first time only one of them learns something.
 *
 * While the fallback is standing in, the preview answers **the fallback**:
 * its contract is "what is being sent right now", not "what the settings
 * would prefer".
 */
export async function resolveSttDelivery(options: {
  sessionId?: string;
  lang?: string;
  /** Which stored keys exist, by the target they authenticate. The keys
   *  themselves stay out of here - they are write-only. */
  keys: { groq: boolean; endpoint: boolean };
}): Promise<SttDelivery> {
  const request = await resolveSttRequest({ sessionId: options.sessionId, lang: options.lang });

  const targets = await sttTargets(request.model);
  // A target that needs a key it does not have cannot be tried. Applied to the
  // primary as well as the fallback: with Groq chosen, no Groq key and a
  // keyless endpoint configured, refusing the request answers 503 while a
  // working transcriber stands there unused.
  const usable = (t: SttTarget | null): t is SttTarget =>
    t !== null && (!t.needsKey || options.keys[t.keySource]);
  const primary = usable(targets.primary) ? targets.primary : null;
  const fallback = usable(targets.fallback) ? targets.fallback : null;
  const attempts: SttAttempt[] = [];
  // While the primary is known to be down, start at the fallback - a sleeping
  // machine answers never, and waiting out the timeout on every utterance is
  // what the down-window exists to avoid.
  if (primary && !(fallback && shouldSkipPrimary(primary.url))) {
    attempts.push({ target: primary, isPrimary: true });
  }
  if (fallback) attempts.push({ target: fallback, isPrimary: false });

  const sending = attempts[0]?.target ?? targets.primary;
  return {
    attempts,
    preview: {
      ...request,
      model: sending.model,
      modelSource: sending.model === request.model ? request.modelSource : 'endpoint',
      destination: sending.label,
      fallback: attempts[1]?.target.label ?? null,
    },
  };
}

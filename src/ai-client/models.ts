/**
 * Model identity: the pins, and the runtime probe that keeps them honest (#184).
 *
 * The same failure has shipped twice — #111 (`gpt-4-vision-preview`,
 * `claude-3-opus-20240229`) and #183 (the whole `claude-3-*` family). Both were
 * hardcoded defaults that were correct when written and silently expired on the
 * vendor's schedule, surfacing as a generic "all providers failed" because the
 * resulting 404 was indistinguishable from a provider outage.
 *
 * Two things fix that, and both live here so there is exactly one place to look:
 *
 * 1. {@link DEFAULT_MODELS} is the single home for every built-in pin. They used
 *    to be duplicated across `config.ts`, `smart-client.ts`, `vision.ts` and
 *    `visual/ai-classifier.ts` with three different sets of values.
 * 2. {@link resolveModel} asks the provider what it actually serves before
 *    trusting a constant, and turns "that model does not exist" into a named
 *    error instead of a silent fallback to another vendor.
 */

import { createHash } from 'crypto';
import { fetchWithTimeout } from './retry';

export type ModelProvider = 'openai' | 'anthropic' | 'ollama';

/** Text clients translate instructions; vision clients classify screenshots. */
export type ModelKind = 'text' | 'vision';

/** Credentials the probe needs to reach a provider's model list. */
export interface ModelProbeCredentials {
  apiKey?: string;
  endpoint?: string;
}

/**
 * Built-in model pins, by capability and provider.
 *
 * Text and vision differ on purpose: the text defaults are the cheap
 * instruction-translation models, the vision defaults are the ones that can
 * actually see. `llama2` has no vision at all, which is why it is not the
 * Ollama vision entry.
 *
 * These are a *starting point*, not the source of truth — {@link resolveModel}
 * replaces a pin the provider no longer serves. Keep them current anyway: they
 * are what an offline or unkeyed run falls back to.
 */
export const DEFAULT_MODELS: Record<ModelKind, Record<ModelProvider, string>> = {
  text: {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-haiku-4-5',
    ollama: 'llama2',
  },
  vision: {
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-5',
    ollama: 'llava',
  },
};

/**
 * A requested model that the provider does not serve.
 *
 * Distinct from a generic `Error` so `SmartAIVisionClient` can refuse to swallow
 * it: a typo'd or retired model is the user's problem to fix, and stepping to
 * the next vendor only hides it behind "all providers failed".
 */
export class ModelUnavailableError extends Error {
  constructor(
    readonly provider: ModelProvider,
    readonly model: string,
    readonly available: string[],
  ) {
    super(
      `Model "${model}" is not available from ${provider}. ` +
        `Available models: ${available.slice(0, MAX_LISTED_IN_ERROR).join(', ')}` +
        (available.length > MAX_LISTED_IN_ERROR
          ? ` (+${available.length - MAX_LISTED_IN_ERROR} more)`
          : ''),
    );
    this.name = 'ModelUnavailableError';
  }
}

/** Enough names to be actionable without turning the error into a wall of text. */
const MAX_LISTED_IN_ERROR = 10;

/**
 * Shorter than the 30s call timeout: this is a pre-flight check, and a slow one
 * would tax every session for a lookup whose failure is already handled.
 */
const PROBE_TIMEOUT_MS = 5000;

/** Pinned so a future API revision cannot silently change the response shape. */
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Session cache. `null` records "the probe could not run" — a failure is cached
 * as deliberately as a success, so an unreachable provider costs one round-trip
 * per process rather than one per request.
 *
 * The *promise* is cached, not the resolved value. Visual comparisons run
 * through a worker pool, so the first batch of analyses starts concurrently and
 * would all miss a value-only cache — firing one `/v1/models` request each
 * before any of them finished writing. Caching the in-flight promise means the
 * second caller awaits the first's request instead of issuing its own.
 */
const probeCache = new Map<string, Promise<string[] | null>>();

/** Drop the session cache. Exported for tests; nothing in `src/` calls it. */
export function resetModelProbeCache(): void {
  probeCache.clear();
}

/**
 * Cache key. The API key is hashed rather than stored: it identifies the
 * account (two keys can see different model sets) without leaving a live
 * secret sitting in a long-lived Map that a heap dump or debugger would show.
 */
function cacheKey(provider: ModelProvider, creds: ModelProbeCredentials): string {
  const keyPrint = creds.apiKey
    ? createHash('sha256').update(creds.apiKey).digest('hex').slice(0, 16)
    : '';
  return `${provider}|${keyPrint}|${creds.endpoint ?? ''}`;
}

/** `IRIS_MODEL_PROBE=0` (or `false`/`off`) skips the probe entirely. */
function probeDisabled(): boolean {
  const flag = process.env.IRIS_MODEL_PROBE;
  return flag === '0' || flag === 'false' || flag === 'off';
}

/**
 * Ask a provider which models it currently serves, newest first.
 *
 * Returns `null` — meaning "could not check", never "there are none" — when the
 * probe is disabled, no credential is available, the request fails, or the
 * provider answers with an error status. That distinction matters: reading an
 * expired key's 401 as an empty list would turn every resolution into a
 * spurious {@link ModelUnavailableError}.
 */
export async function listModels(
  provider: ModelProvider,
  creds: ModelProbeCredentials,
): Promise<string[] | null> {
  if (probeDisabled()) return null;

  const key = cacheKey(provider, creds);
  const cached = probeCache.get(key);
  if (cached) return cached;

  // Stored before the first await, so concurrent callers share this request.
  // `probe` never rejects — it maps every failure to null — so a poisoned
  // rejected promise can never be cached here.
  const pending = probe(provider, creds);
  probeCache.set(key, pending);
  return pending;
}

async function probe(
  provider: ModelProvider,
  creds: ModelProbeCredentials,
): Promise<string[] | null> {
  try {
    switch (provider) {
      case 'anthropic': {
        if (!creds.apiKey) return null;
        const data = await getJson('https://api.anthropic.com/v1/models?limit=1000', {
          'x-api-key': creds.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        });
        const entries = container(data?.data);
        if (!entries) return null;
        // Anthropic already returns newest-first.
        return entries
          .map((m) => (m as { id?: string }).id)
          .filter((id): id is string => typeof id === 'string');
      }
      case 'openai': {
        if (!creds.apiKey) return null;
        const data = await getJson('https://api.openai.com/v1/models', {
          Authorization: `Bearer ${creds.apiKey}`,
        });
        const entries = container(data?.data) as Array<{ id?: string; created?: number }> | null;
        if (!entries) return null;
        return entries
          .filter((m): m is { id: string; created?: number } => typeof m.id === 'string')
          .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
          .map((m) => m.id);
      }
      case 'ollama': {
        if (!creds.endpoint) return null;
        const data = await getJson(`${creds.endpoint.replace(/\/$/, '')}/api/tags`, {});
        const entries = container(data?.models);
        if (!entries) return null;
        return entries
          .map((m) => (m as { name?: string }).name)
          .filter((n): n is string => typeof n === 'string');
      }
    }
  } catch {
    // Offline, DNS failure, timeout, malformed JSON — all mean the same thing to
    // the caller: we could not check. Never block work on a check that failed.
    return null;
  }
}

async function getJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ data?: unknown[]; models?: unknown[] } | null> {
  const response = await fetchWithTimeout(url, { headers }, PROBE_TIMEOUT_MS);
  if (!response.ok) return null;
  return (await response.json()) as { data?: unknown[]; models?: unknown[] };
}

/**
 * The list a provider's response is supposed to carry, or `null` if it has none.
 *
 * A 200 whose body lacks the container entirely (an OpenAI-compatible proxy
 * answering `{}`) means the same thing as a 401: we could not check. Reading it
 * as an empty list would let `resolveModel` tell the user their model does not
 * exist on the strength of a response that listed nothing at all. A container
 * that is *present but empty* is a real answer and stays `[]`.
 */
function container(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/**
 * Ollama reports `/api/tags` names with their tag (`llava:latest`), while users
 * — and our pins — write the bare name. Treat them as the same model.
 */
function ollamaAliases(name: string): string[] {
  return name.includes(':') ? [name] : [name, `${name}:latest`];
}

function isListed(provider: ModelProvider, listed: string[], wanted: string): boolean {
  const candidates = provider === 'ollama' ? ollamaAliases(wanted) : [wanted];
  return candidates.some((c) => listed.includes(c));
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/**
 * Pick the live model closest to a pin the provider no longer serves.
 *
 * Deliberately a prefix match and not a capability table: the failure being
 * fixed is "the pin was retired", and `claude-sonnet-5` -> `claude-sonnet-5-20260514`
 * handles that without anyone maintaining a list of which models can see.
 *
 * A candidate must agree with the pin **past the family root**. Sharing only
 * `claude-` is not evidence of a successor, and accepting it would let a
 * retired `claude-haiku-4-5` text default resolve to `claude-opus-5` — five
 * times the price for a model the user never chose. Rescuing within a model
 * line (dated snapshots, point revisions) is defensible; jumping lines is a
 * guess with a bill attached, so the pin is kept and the provider gets to
 * reject it with its own message. A bare-root pin like Ollama's `llava` is the
 * exception: the root is the whole name, so matching it is the strongest
 * signal available and any tagged form counts.
 *
 * `listed` arrives newest-first and the comparison is strict, so ties settle on
 * the newest candidate.
 *
 * ponytail: heuristic with a known ceiling — it cannot tell a vision model from
 * a text one. Swap for a capability lookup if a provider ever exposes one.
 */
function pickClosest(listed: string[], pinned: string): string {
  const root = pinned.split(/[-:]/)[0];
  // Root + separator + at least one character, unless the pin IS the root.
  const required = pinned === root ? root.length : root.length + 2;

  let best: string | undefined;
  let bestLength = 0;

  for (const candidate of listed) {
    const length = commonPrefixLength(candidate, pinned);
    if (length >= required && length > bestLength) {
      bestLength = length;
      best = candidate;
    }
  }

  // Nothing close enough: keep the pin rather than substituting a model the
  // user never asked for and may not want to pay for.
  return best ?? pinned;
}

export interface ResolveModelOptions {
  provider: ModelProvider;
  kind: ModelKind;
  /** The model the config layers settled on — a user choice or a built-in pin. */
  model: string;
  creds: ModelProbeCredentials;
}

/**
 * Resolve the model to actually request, checking it against the provider's
 * live list.
 *
 * There is no "was this explicit?" flag to thread through, because
 * {@link DEFAULT_MODELS} already knows what the pin is: a missing model that
 * *equals* the pin is our rot to repair, and a missing model that *differs* from
 * it is a user choice that does not exist. Both cases are handled without the
 * config layer having to remember where the value came from.
 *
 * @throws {ModelUnavailableError} when the user named a model the provider does
 *   not serve. Never thrown when the probe could not run.
 */
export async function resolveModel(options: ResolveModelOptions): Promise<string> {
  const { provider, kind, model, creds } = options;

  const listed = await listModels(provider, creds);
  if (!listed) return model; // could not check — trust the configured value
  if (isListed(provider, listed, model)) return model;

  if (model === DEFAULT_MODELS[kind][provider]) {
    return pickClosest(listed, model);
  }

  throw new ModelUnavailableError(provider, model, listed);
}

import type { IrisConfig } from '../config';
import { DEFAULT_MODELS } from './models';

/**
 * One tenant's AI credential for one request (#258): the vendor, its key or local
 * endpoint, and optionally a model. Hosted requests carry these instead of reading
 * the process-wide `*_API_KEY` variables or `~/.iris/config.json` (ADR 0001 §5).
 */
export interface AICredentials {
  provider: IrisConfig['ai']['provider'];
  apiKey?: string;
  endpoint?: string;
  model?: string;
}

/**
 * The client configuration for an injected credential, and nothing else: no process
 * configuration is read. It names only the credential's own vendor, so the key cannot
 * be sent to another, and `fallback` is the caller's (the org's opt-in), never the
 * process config's `ai.fallback` (#245). Even with fallback on, other vendors have no
 * credential here and are skipped, not contacted.
 */
export function configFromCredentials(
  credentials: AICredentials,
  { kind, fallback = false }: { kind: 'text' | 'vision'; fallback?: boolean },
): IrisConfig {
  // The AI clients fetch from the server process, outside the browser's egress
  // controls (#336): a tenant-chosen endpoint would be a request to wherever the
  // tenant points it (an internal host, cloud metadata). Injected credentials are
  // for the hosted vendors only.
  if (credentials.provider === 'ollama') {
    throw new Error('Injected AI credentials cannot use ollama: its endpoint is server-side');
  }
  if (credentials.endpoint !== undefined) {
    throw new Error('Injected AI credentials cannot set an endpoint');
  }
  return {
    ai: {
      provider: credentials.provider,
      apiKey: credentials.apiKey,
      endpoint: credentials.endpoint,
      model: credentials.model ?? DEFAULT_MODELS[kind][credentials.provider],
      fallback,
    },
    watch: { patterns: [], debounceMs: 1000, ignore: [] },
    browser: { headless: true, timeout: 30000 },
  };
}

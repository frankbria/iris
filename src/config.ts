import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { RetryConfig } from './ai-client/retry';

/**
 * Credentials scoped to a single provider.
 *
 * `apiKey`/`endpoint` at the top level of `ai` describe only the *configured*
 * provider, so a fallback chain that steps across vendors has nothing valid to
 * use for the others. This map supplies a credential per provider, which is what
 * lets the advertised Ollama -> OpenAI -> Anthropic chain actually cross clouds
 * instead of stopping at the one provider that happens to be configured (#74).
 */
export type ProviderCredentials = Partial<
  Record<'openai' | 'anthropic' | 'ollama', { apiKey?: string; endpoint?: string }>
>;

export interface IrisConfig {
  ai: {
    provider: 'openai' | 'anthropic' | 'ollama';
    apiKey?: string;
    model: string;
    endpoint?: string; // For local models like Ollama
    timeout?: number; // Per-call timeout in ms (default 30000)
    retryConfig?: RetryConfig; // Transient-failure retry/backoff (default 2/500ms/2x)
    credentials?: ProviderCredentials; // Per-provider keys for cross-vendor fallback
  };
  watch: {
    patterns: string[];
    debounceMs: number;
    ignore: string[];
  };
  browser: {
    headless: boolean;
    timeout: number;
  };
}

const DEFAULT_CONFIG: IrisConfig = {
  ai: {
    provider: 'openai',
    model: 'gpt-4o-mini',
  },
  watch: {
    patterns: ['**/*.{ts,tsx,js,jsx,html,css}'],
    debounceMs: 1000,
    ignore: ['node_modules/**', 'dist/**', '.git/**', 'coverage/**'],
  },
  browser: {
    headless: true,
    timeout: 30000,
  },
};

/**
 * Load environment variables from a `.env` file in `cwd` into `process.env`.
 *
 * Supports `KEY=value`, the `export KEY=value` prefix, `# comments`, blank
 * lines, surrounding single/double quotes, and inline `# comments` on unquoted
 * values. Existing `process.env` values always win, so real shell-exported
 * variables take precedence over the file. A missing `.env` is a silent no-op.
 *
 * ponytail: minimal parser, not full POSIX shell quoting — swap for the `dotenv`
 * package if multiline values or `${VAR}` expansion are ever needed.
 */
export function loadDotenv(cwd: string = process.cwd()): void {
  let content: string;
  try {
    content = fs.readFileSync(path.join(cwd, '.env'), 'utf8');
  } catch {
    return; // no .env file — nothing to load
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '');
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    const quoted = value.match(/^(['"])([\s\S]*)\1$/);
    if (quoted) {
      value = quoted[2];
    } else {
      // Strip a whitespace-preceded inline comment from unquoted values.
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function getConfigPath(): string {
  return path.join(os.homedir(), '.iris', 'config.json');
}

export function loadConfig(): IrisConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return loadFromEnvironment();
  }

  try {
    const configFile = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return mergeConfig(DEFAULT_CONFIG, configFile);
  } catch (error) {
    console.warn(`Warning: Failed to load config from ${configPath}, using defaults:`, error);
    return loadFromEnvironment();
  }
}

export function saveConfig(config: IrisConfig): void {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  // Config may hold ai.apiKey — keep it owner-only. `mode` on writeFileSync is
  // ignored for an existing file, so lock down any pre-existing (possibly
  // world-readable) file BEFORE writing secrets — otherwise the new contents
  // would briefly sit under the old loose perms until a post-write chmod.
  if (fs.existsSync(configPath)) {
    fs.chmodSync(configPath, 0o600);
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function loadFromEnvironment(): IrisConfig {
  // Clone nested objects too — a shallow copy would let the mutations below
  // write through to the shared DEFAULT_CONFIG (issue #63).
  const config: IrisConfig = {
    ai: { ...DEFAULT_CONFIG.ai },
    watch: { ...DEFAULT_CONFIG.watch },
    browser: { ...DEFAULT_CONFIG.browser },
  };

  // Collect EVERY credential present, not just the winning provider's. The
  // else-if chain below still decides which provider is primary, but discarding
  // the others left the fallback chain with nothing to authenticate as, so it
  // could never step from one cloud vendor to another (#74).
  const credentials: ProviderCredentials = {};
  if (process.env.OPENAI_API_KEY) {
    credentials.openai = { apiKey: process.env.OPENAI_API_KEY };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    credentials.anthropic = { apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.OLLAMA_ENDPOINT) {
    credentials.ollama = { endpoint: process.env.OLLAMA_ENDPOINT };
  }
  if (Object.keys(credentials).length > 0) {
    config.ai.credentials = credentials;
  }

  // Primary-provider selection is unchanged: first match wins.
  if (process.env.OPENAI_API_KEY) {
    config.ai.provider = 'openai';
    config.ai.apiKey = process.env.OPENAI_API_KEY;
  } else if (process.env.ANTHROPIC_API_KEY) {
    config.ai.provider = 'anthropic';
    config.ai.apiKey = process.env.ANTHROPIC_API_KEY;
    config.ai.model = 'claude-3-haiku-20240307';
  } else if (process.env.OLLAMA_ENDPOINT) {
    config.ai.provider = 'ollama';
    config.ai.endpoint = process.env.OLLAMA_ENDPOINT;
    config.ai.model = process.env.OLLAMA_MODEL || 'llama2';
  }

  return config;
}

function mergeConfig(defaultConfig: IrisConfig, userConfig: Partial<IrisConfig>): IrisConfig {
  return {
    ai: { ...defaultConfig.ai, ...userConfig.ai },
    watch: { ...defaultConfig.watch, ...userConfig.watch },
    browser: { ...defaultConfig.browser, ...userConfig.browser },
  };
}

export function validateConfig(config: IrisConfig): string[] {
  const errors: string[] = [];

  if (config.ai.provider === 'openai' && !config.ai.apiKey) {
    errors.push(
      'OpenAI API key is required. Set OPENAI_API_KEY environment variable or configure in ~/.iris/config.json',
    );
  }

  if (config.ai.provider === 'anthropic' && !config.ai.apiKey) {
    errors.push(
      'Anthropic API key is required. Set ANTHROPIC_API_KEY environment variable or configure in ~/.iris/config.json',
    );
  }

  if (config.ai.provider === 'ollama' && !config.ai.endpoint) {
    errors.push(
      'Ollama endpoint is required. Set OLLAMA_ENDPOINT environment variable or configure in ~/.iris/config.json',
    );
  }

  if (config.watch.debounceMs < 100) {
    errors.push('Watch debounce must be at least 100ms');
  }

  if (config.browser.timeout < 1000) {
    errors.push('Browser timeout must be at least 1000ms');
  }

  return errors;
}

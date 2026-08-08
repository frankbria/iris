import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { RetryConfig } from './ai-client/retry';
import { DEFAULT_MODELS } from './ai-client/models';

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
    model: DEFAULT_MODELS.text.openai,
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
 * `cwd` defaults to `IRIS_DOTENV_DIR` when set, else the process working
 * directory — so the `.env` IRIS reads can be aimed somewhere other than
 * wherever the command happened to be invoked from.
 *
 * That override is what makes the test suite hermetic (issue #185). `runCli()`
 * calls this with no argument, so under Jest — where the working directory is
 * the repo root — a developer's real `.env` was injected into `process.env`
 * mid-test, flipping the CLI onto its live-AI branch: four `cli.test.ts` tests
 * failed only on machines that had the file, and the run could bill real API
 * calls. A `beforeEach` scrub cannot fix that (this runs *during* the test,
 * after any scrub), and a per-test-file stub only protects the files that
 * remember it. One guard here covers every caller; `jest.setup.ts` points the
 * variable at an empty directory.
 *
 * ponytail: minimal parser, not full POSIX shell quoting — swap for the `dotenv`
 * package if multiline values or `${VAR}` expansion are ever needed.
 */
export function loadDotenv(cwd: string = process.env.IRIS_DOTENV_DIR ?? process.cwd()): void {
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

/**
 * Load configuration by layering, outermost layer last (issue #184).
 *
 *   built-in defaults  <  environment auto-detection  <  `~/.iris/config.json`  <  `<PROVIDER>_MODEL`
 *
 * The two middle layers used to be mutually exclusive — `loadConfig` returned
 * *either* the environment-derived config *or* the file-merged one — which had
 * two consequences the user could not work around:
 *
 * - With a key in the environment and no config file, `ai.model` was force-set
 *   to a hardcoded (eventually retired) name with no override hook.
 * - The moment a config file existed, every `*_API_KEY` stopped being read, so
 *   the key had to be written into the file.
 *
 * Layering fixes both. The ordering reflects how explicit each layer is:
 * credential *presence* is auto-detection and yields to an explicit
 * `ai.provider` in the file, while a `<PROVIDER>_MODEL` variable is the user
 * saying it outright for this run and outranks the file.
 */
export function loadConfig(): IrisConfig {
  const file = loadConfigFile();
  const env = loadFromEnvironment();

  // Provider: the file states it, the environment only infers it from which
  // credential happens to be exported.
  const provider = file.ai?.provider ?? env.provider ?? DEFAULT_CONFIG.ai.provider;

  // Credentials: every vendor's, so the fallback chain can cross clouds (#74).
  // Merged per *field*, not per provider — spreading one level shallower would
  // let a file entry that names only `apiKey` drop an `OLLAMA_ENDPOINT` the
  // environment supplied for the same vendor, leaving the client with no
  // endpoint at all. The file still wins field by field.
  const credentials: ProviderCredentials = {};
  for (const vendor of ['openai', 'anthropic', 'ollama'] as const) {
    const merged = { ...env.credentials[vendor], ...file.ai?.credentials?.[vendor] };
    if (Object.keys(merged).length > 0) credentials[vendor] = merged;
  }
  const forProvider = credentials[provider] ?? {};

  // A `<PROVIDER>_MODEL` var applies only while that provider is active, so
  // exporting OPENAI_MODEL can never leak into an Anthropic session.
  const model = env.models[provider] ?? file.ai?.model ?? DEFAULT_MODELS.text[provider];

  // The file's TOP-LEVEL apiKey/endpoint describe one vendor — the one the file
  // itself is about — exactly like an entry in the credentials map does. Using
  // them for whichever provider happens to win resolution is how a config
  // holding `{"ai":{"apiKey":"sk-openai-…"}}` would send that key to Anthropic
  // when only ANTHROPIC_API_KEY is exported. Scope them to the file's own
  // provider (its `ai.provider`, or the built-in default when it names none)
  // and fall back to the per-vendor credential otherwise. Same rule as #74.
  const fileProvider = file.ai?.provider ?? DEFAULT_CONFIG.ai.provider;
  const fileCredential = provider === fileProvider ? file.ai : undefined;

  return {
    ai: {
      ...DEFAULT_CONFIG.ai,
      ...file.ai,
      provider,
      model,
      apiKey: fileCredential?.apiKey ?? forProvider.apiKey,
      endpoint: fileCredential?.endpoint ?? forProvider.endpoint,
      ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
    },
    watch: { ...DEFAULT_CONFIG.watch, ...file.watch },
    browser: { ...DEFAULT_CONFIG.browser, ...file.browser },
  };
}

/**
 * Read `~/.iris/config.json`, or `{}` when it is absent, unreadable, or not a
 * JSON object.
 *
 * An unusable file degrades to "no file layer" rather than discarding the
 * environment as well — a typo in the config should not also take away the
 * user's exported API key. The shape check is not redundant with the `try`:
 * a file containing bare `null` parses successfully, and every `file.ai?.…`
 * read below would then throw on it.
 */
function loadConfigFile(): Partial<IrisConfig> {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.warn(`Warning: Failed to load config from ${configPath}, ignoring it:`, error);
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn(`Warning: Config at ${configPath} is not a JSON object, ignoring it`);
    return {};
  }
  return parsed as Partial<IrisConfig>;
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

/** What the environment actually says — never a built-in default (issue #184). */
interface EnvironmentLayer {
  /** Auto-detected from which credential is exported; first match wins. */
  provider?: IrisConfig['ai']['provider'];
  /** Every credential present, not just the detected provider's (#74). */
  credentials: ProviderCredentials;
  /** Explicit `<PROVIDER>_MODEL` overrides, by provider. */
  models: Partial<Record<IrisConfig['ai']['provider'], string>>;
}

/**
 * Read the environment layer.
 *
 * Crucially this no longer *invents* a model. The old version assigned a
 * hardcoded name inline (`config.ai.model = 'claude-haiku-4-5'`), which is what
 * made the built-in default indistinguishable from a user preference and left
 * `ANTHROPIC_API_KEY` users with no way to choose a model at all. A pin is a
 * default, and defaults belong in the innermost layer — see `loadConfig`.
 */
function loadFromEnvironment(): EnvironmentLayer {
  // Collect EVERY credential present, not just the winning provider's.
  // Discarding the others left the fallback chain with nothing to authenticate
  // as, so it could never step from one cloud vendor to another (#74).
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

  const models: EnvironmentLayer['models'] = {};
  if (process.env.OPENAI_MODEL) models.openai = process.env.OPENAI_MODEL;
  if (process.env.ANTHROPIC_MODEL) models.anthropic = process.env.ANTHROPIC_MODEL;
  if (process.env.OLLAMA_MODEL) models.ollama = process.env.OLLAMA_MODEL;

  // Primary-provider detection is unchanged: first match wins.
  let provider: EnvironmentLayer['provider'];
  if (credentials.openai) provider = 'openai';
  else if (credentials.anthropic) provider = 'anthropic';
  else if (credentials.ollama) provider = 'ollama';

  return { provider, credentials, models };
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

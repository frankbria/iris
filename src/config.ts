import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export interface IrisConfig {
  ai: {
    provider: 'openai' | 'anthropic' | 'ollama';
    apiKey?: string;
    model: string;
    endpoint?: string; // For local models like Ollama
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
  const config = { ...DEFAULT_CONFIG };

  // Load AI configuration from environment
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

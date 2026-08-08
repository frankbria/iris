/**
 * Tests for provider-driven model resolution (src/ai-client/models.ts, issue #184).
 *
 * The failure this module exists to prevent has now shipped twice (#111, #183):
 * a model ID that was correct when written and silently expired on the vendor's
 * schedule, surfacing as a generic "all providers failed". These tests pin the
 * three behaviours that matter — a retired default is rescued, a bogus explicit
 * model is named rather than swallowed, and being offline never blocks work.
 *
 * `fetch` is mocked at the global level; everything else is the real module.
 */

import {
  DEFAULT_MODELS,
  ModelUnavailableError,
  listModels,
  resetModelProbeCache,
  resolveModel,
} from '../src/ai-client/models';

const mockFetch = jest.fn();

/** Build a `Response`-alike good enough for the probe's `.ok` / `.json()` use. */
const jsonResponse = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 401,
  json: async () => body,
});

/** Anthropic `/v1/models` shape: newest first, `data[].id`. */
const anthropicList = (...ids: string[]) => jsonResponse({ data: ids.map((id) => ({ id })) });
/** OpenAI `/v1/models` shape: unordered, `data[].id` + `created` epoch seconds. */
const openaiList = (...entries: Array<[string, number]>) =>
  jsonResponse({ data: entries.map(([id, created]) => ({ id, created })) });
/** Ollama `/api/tags` shape: `models[].name`, tags included. */
const ollamaList = (...names: string[]) =>
  jsonResponse({ models: names.map((name) => ({ name })) });

beforeEach(() => {
  jest.clearAllMocks();
  resetModelProbeCache();
  // jest.setup.ts disables the probe suite-wide so unrelated tests stay
  // hermetic; this file is the one that actually exercises it.
  delete process.env.IRIS_MODEL_PROBE;
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  process.env.IRIS_MODEL_PROBE = '0';
});

describe('listModels', () => {
  it('queries the Anthropic model list with the key and API version header', async () => {
    mockFetch.mockResolvedValue(anthropicList('claude-sonnet-5', 'claude-haiku-4-5'));

    const models = await listModels('anthropic', { apiKey: 'sk-ant-test' });

    expect(models).toEqual(['claude-sonnet-5', 'claude-haiku-4-5']);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('api.anthropic.com');
    expect(url).toContain('/v1/models');
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    expect(init.headers['anthropic-version']).toBeTruthy();
  });

  it('queries the OpenAI model list with a bearer token, newest first', async () => {
    // Deliberately out of order: OpenAI does not sort, so the module must.
    mockFetch.mockResolvedValue(openaiList(['gpt-4o', 1700000000], ['gpt-5', 1800000000]));

    const models = await listModels('openai', { apiKey: 'sk-openai-test' });

    expect(models).toEqual(['gpt-5', 'gpt-4o']);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('api.openai.com');
    expect(init.headers.Authorization).toBe('Bearer sk-openai-test');
  });

  it('queries the Ollama tag list at the configured endpoint', async () => {
    mockFetch.mockResolvedValue(ollamaList('llava:13b', 'llama2:latest'));

    const models = await listModels('ollama', { endpoint: 'http://localhost:11434' });

    expect(models).toEqual(['llava:13b', 'llama2:latest']);
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11434/api/tags');
  });

  it('caches the result for the session — one call per provider, not per request', async () => {
    mockFetch.mockResolvedValue(anthropicList('claude-sonnet-5'));

    await listModels('anthropic', { apiKey: 'sk-ant-test' });
    await listModels('anthropic', { apiKey: 'sk-ant-test' });
    await listModels('anthropic', { apiKey: 'sk-ant-test' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('caches a failed probe too, so an unreachable provider is not retried every call', async () => {
    mockFetch.mockRejectedValue(new Error('ENOTFOUND api.anthropic.com'));

    expect(await listModels('anthropic', { apiKey: 'sk-ant-test' })).toBeNull();
    expect(await listModels('anthropic', { apiKey: 'sk-ant-test' })).toBeNull();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent callers onto a single in-flight request', async () => {
    // Visual comparisons run through a worker pool, so the first batch calls
    // this simultaneously. Caching only the resolved value would let every one
    // of them miss and issue its own request.
    mockFetch.mockResolvedValue(anthropicList('claude-sonnet-5'));

    const results = await Promise.all(
      Array.from({ length: 5 }, () => listModels('anthropic', { apiKey: 'sk-ant-test' })),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r?.[0] === 'claude-sonnet-5')).toBe(true);
  });

  it('treats a non-OK response as "probe unavailable", not as an empty model list', async () => {
    // An expired key returns 401. Reading that as "no models exist" would turn
    // every subsequent resolution into a spurious ModelUnavailableError.
    mockFetch.mockResolvedValue(jsonResponse({ error: 'invalid key' }, false));

    expect(await listModels('openai', { apiKey: 'sk-bad' })).toBeNull();
  });

  it('does not probe without a credential for the provider', async () => {
    expect(await listModels('openai', {})).toBeNull();
    expect(await listModels('ollama', {})).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('keys the cache per provider, so two vendors do not share one answer', async () => {
    mockFetch
      .mockResolvedValueOnce(anthropicList('claude-sonnet-5'))
      .mockResolvedValueOnce(openaiList(['gpt-4o', 1]));

    expect(await listModels('anthropic', { apiKey: 'sk-ant' })).toEqual(['claude-sonnet-5']);
    expect(await listModels('openai', { apiKey: 'sk-oai' })).toEqual(['gpt-4o']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('is disabled by IRIS_MODEL_PROBE=0', async () => {
    process.env.IRIS_MODEL_PROBE = '0';
    expect(await listModels('anthropic', { apiKey: 'sk-ant' })).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('resolveModel', () => {
  const creds = { apiKey: 'sk-ant-test' };

  it('returns a model the provider actually lists', async () => {
    mockFetch.mockResolvedValue(anthropicList('claude-sonnet-5', 'claude-opus-5'));

    const model = await resolveModel({
      provider: 'anthropic',
      kind: 'vision',
      model: 'claude-opus-5',
      creds,
    });

    expect(model).toBe('claude-opus-5');
  });

  // The #111 / #183 failure mode: the pin was correct when written and the
  // vendor retired it. Nobody edits source; the probe finds the successor.
  it('rescues a retired built-in pin with the closest live model', async () => {
    mockFetch.mockResolvedValue(
      anthropicList('claude-sonnet-5-20260514', 'claude-opus-5', 'claude-haiku-4-5'),
    );

    const model = await resolveModel({
      provider: 'anthropic',
      kind: 'vision',
      model: DEFAULT_MODELS.vision.anthropic, // 'claude-sonnet-5'
      creds,
    });

    expect(model).toBe('claude-sonnet-5-20260514');
  });

  it('breaks a prefix tie by recency, since the list arrives newest-first', async () => {
    // Both share only "claude-" with the retired pin; the newer one wins.
    mockFetch.mockResolvedValue(anthropicList('claude-opus-6', 'claude-opus-5'));

    const model = await resolveModel({
      provider: 'anthropic',
      kind: 'vision',
      model: DEFAULT_MODELS.vision.anthropic,
      creds,
    });

    expect(model).toBe('claude-opus-6');
  });

  it('keeps the pin when nothing in the list shares its family', async () => {
    mockFetch.mockResolvedValue(anthropicList('some-unrelated-model'));

    const model = await resolveModel({
      provider: 'anthropic',
      kind: 'vision',
      model: DEFAULT_MODELS.vision.anthropic,
      creds,
    });

    // Better to let the provider reject it with its own message than to send a
    // wildly unrelated model the user never asked for.
    expect(model).toBe(DEFAULT_MODELS.vision.anthropic);
  });

  // Acceptance criterion: an unavailable model must name itself, not look like
  // a provider outage. This is the error smart-client refuses to swallow.
  it('throws a named, actionable error for a user model the provider does not list', async () => {
    mockFetch.mockResolvedValue(anthropicList('claude-sonnet-5', 'claude-opus-5'));

    const promise = resolveModel({
      provider: 'anthropic',
      kind: 'vision',
      model: 'claude-3-opus-20240229',
      creds,
    });

    await expect(promise).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(promise).rejects.toThrow(/claude-3-opus-20240229/);
    await expect(promise).rejects.toThrow(/claude-sonnet-5/); // lists what IS available
  });

  it('passes an explicit model straight through when the probe is unavailable', async () => {
    // Offline, or no key: never block work on a check that could not run.
    mockFetch.mockRejectedValue(new Error('fetch failed'));

    const model = await resolveModel({
      provider: 'anthropic',
      kind: 'vision',
      model: 'claude-some-private-deployment',
      creds,
    });

    expect(model).toBe('claude-some-private-deployment');
  });

  it('matches a bare Ollama name against its tagged form', async () => {
    // `/api/tags` reports `llava:latest`; users (and our pin) write `llava`.
    mockFetch.mockResolvedValue(ollamaList('llava:latest', 'llama2:latest'));

    const model = await resolveModel({
      provider: 'ollama',
      kind: 'vision',
      model: 'llava',
      creds: { endpoint: 'http://localhost:11434' },
    });

    expect(model).toBe('llava');
  });

  it('resolves text and vision pins independently for the same provider', async () => {
    mockFetch.mockResolvedValue(openaiList(['gpt-4o', 2], ['gpt-4o-mini', 1]));

    expect(
      await resolveModel({
        provider: 'openai',
        kind: 'text',
        model: DEFAULT_MODELS.text.openai,
        creds: { apiKey: 'sk-oai' },
      }),
    ).toBe('gpt-4o-mini');

    expect(
      await resolveModel({
        provider: 'openai',
        kind: 'vision',
        model: DEFAULT_MODELS.vision.openai,
        creds: { apiKey: 'sk-oai' },
      }),
    ).toBe('gpt-4o');
  });
});

describe('malformed provider payloads', () => {
  // A provider that answers 200 with an unexpected body must degrade to an
  // empty/partial list, never throw out of a pre-flight check.
  it('tolerates a response with no list at all', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));
    expect(await listModels('anthropic', { apiKey: 'sk-ant' })).toEqual([]);
  });

  it('skips entries missing the identifying field', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-4o' }, {}, { id: 42 }] }));
    expect(await listModels('openai', { apiKey: 'sk-oai' })).toEqual(['gpt-4o']);
  });

  it('skips Ollama entries missing a name', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ models: [{ name: 'llava:latest' }, {}] }));
    expect(await listModels('ollama', { endpoint: 'http://localhost:11434/' })).toEqual([
      'llava:latest',
    ]);
    // Trailing slash on the endpoint must not produce a double slash.
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11434/api/tags');
  });
});

describe('ModelUnavailableError', () => {
  it('truncates a long model list so the message stays readable', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `claude-model-${i}`);
    mockFetch.mockResolvedValue(anthropicList(...many));

    const promise = resolveModel({
      provider: 'anthropic',
      kind: 'vision',
      model: 'definitely-not-real',
      creds: { apiKey: 'sk-ant' },
    });

    await expect(promise).rejects.toThrow(/\(\+15 more\)/);
  });
});

describe('DEFAULT_MODELS', () => {
  // Guard against the pins drifting back apart across modules: every provider
  // must have both a text and a vision entry, and none may be empty.
  it('defines a non-empty text and vision pin for every provider', () => {
    for (const kind of ['text', 'vision'] as const) {
      for (const provider of ['openai', 'anthropic', 'ollama'] as const) {
        expect(DEFAULT_MODELS[kind][provider]).toEqual(expect.any(String));
        expect(DEFAULT_MODELS[kind][provider].length).toBeGreaterThan(0);
      }
    }
  });
});

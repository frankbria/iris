/**
 * Vision capability and Ollama probes (issue #298).
 *
 * Capability used to be a model-name guess (OpenAI: contains `gpt-4`; Ollama: `llava` or
 * `bakllava`), so current vision models were skipped; the Ollama probe had no timeout and
 * ran before every analysis. The probes here run against real local HTTP servers: one that
 * answers like Ollama, one that accepts the connection and never answers.
 */

import { createServer, Server, IncomingMessage } from 'http';
import type { AddressInfo } from 'net';
import { isVisionModel, listModels, resetModelProbeCache } from '../src/ai-client/models';
import { OllamaVisionClient, OpenAIVisionClient } from '../src/ai-client/vision';
import { OllamaTextClient } from '../src/ai-client/text';

describe('isVisionModel (#298)', () => {
  it.each([
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4o-2024-08-06',
    'chatgpt-4o-latest',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4-turbo',
    'gpt-5',
    'gpt-5-mini',
    'o1',
    'o3',
    'o4-mini',
  ])('openai %s sees images', (model) => {
    expect(isVisionModel('openai', model)).toBe(true);
  });

  it.each([
    'gpt-3.5-turbo',
    'gpt-4',
    'gpt-4-0613',
    'o1-mini',
    'o3-mini',
    'gpt-4o-audio-preview',
    'gpt-4o-realtime-preview',
    'gpt-4o-mini-tts',
  ])('openai %s does not', (model) => {
    expect(isVisionModel('openai', model)).toBe(false);
  });

  it.each([
    'llava',
    'llava:13b',
    'bakllava',
    'llama3.2-vision:11b',
    'llama4:scout',
    'gemma3:12b',
    'qwen2.5vl:7b',
    'minicpm-v',
    'moondream',
    'library/llava:latest',
  ])('ollama %s sees images', (model) => {
    expect(isVisionModel('ollama', model)).toBe(true);
  });

  it.each(['llama2', 'llama3.1:8b', 'mistral', 'qwen2.5:7b'])('ollama %s does not', (model) => {
    expect(isVisionModel('ollama', model)).toBe(false);
  });

  it('the OpenAI vision client follows it', () => {
    const client = (model: string) =>
      new OpenAIVisionClient({ provider: 'openai', apiKey: 'k', model });
    expect(client('gpt-4.1-mini').supportsVision()).toBe(true);
    expect(client('gpt-4').supportsVision()).toBe(false);
  });

  it('the Ollama vision client follows it, defaulting to its vision pin', () => {
    const client = (model: string) => new OllamaVisionClient({ provider: 'ollama', model });
    expect(client('llama3.2-vision').supportsVision()).toBe(true);
    expect(client('mistral').supportsVision()).toBe(false);
    expect(client('').supportsVision()).toBe(true); // unset: the llava pin
  });
});

/** A stand-in Ollama. `show` answers `/api/show` per model; every request is counted. */
function fakeOllama(show: Record<string, object | number>): Server & { hits: string[] } {
  const hits: string[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push(`${req.method} ${req.url} ${body}`);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') return res.end('{"models":[]}');
      if (req.url === '/api/show') {
        const answer = show[JSON.parse(body).model];
        if (answer === undefined || typeof answer === 'number') {
          res.writeHead(typeof answer === 'number' ? answer : 404);
          return res.end('{"error":"model not found"}');
        }
        return res.end(JSON.stringify(answer));
      }
      res.writeHead(404).end();
    });
  });
  return Object.assign(server, { hits });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('Ollama probes (#298)', () => {
  const servers: Server[] = [];
  const serve = async (server: Server) => (servers.push(server), listen(server));

  beforeEach(() => resetModelProbeCache());
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise((resolve) => {
            s.closeAllConnections();
            s.close(resolve);
          }),
      ),
    );
  });

  const vision = (endpoint: string, model: string) =>
    new OllamaVisionClient({ provider: 'ollama', endpoint, model });

  it("takes vision from the model's own capabilities, over the name", async () => {
    const endpoint = await serve(
      fakeOllama({
        'gemma3:12b': { capabilities: ['completion', 'vision'] },
        'llava-text-only': { capabilities: ['completion'] },
      }),
    );
    expect(await vision(endpoint, 'gemma3:12b').isAvailable()).toBe(true);
    expect(await vision(endpoint, 'llava-text-only').isAvailable()).toBe(false);
  });

  it('falls back to the allowlist when Ollama reports no capabilities', async () => {
    const endpoint = await serve(fakeOllama({ llava: { details: {} }, mistral: { details: {} } }));
    expect(await vision(endpoint, 'llava').isAvailable()).toBe(true);
    expect(await vision(endpoint, 'mistral').isAvailable()).toBe(false);
  });

  // It used to ask whether ANY llava model was pulled, not the configured one.
  it('is unavailable when the configured model is not pulled', async () => {
    const server = fakeOllama({});
    const endpoint = await serve(server);
    expect(await vision(endpoint, 'llava:13b').isAvailable()).toBe(false);
    expect(server.hits).toEqual([`POST /api/show {"model":"llava:13b"}`]);
  });

  it('asks once per endpoint and model, not before every analysis', async () => {
    const server = fakeOllama({ llava: { capabilities: ['vision'] } });
    const endpoint = await serve(server);
    for (let i = 0; i < 3; i++) expect(await vision(endpoint, 'llava').isAvailable()).toBe(true);
    const text = new OllamaTextClient({ provider: 'ollama', endpoint, model: 'llama2' });
    for (let i = 0; i < 3; i++) expect(await text.isAvailable()).toBe(true);
    expect(server.hits).toHaveLength(2);
  });

  // A daemon that accepts and never answers held every analysis for the OS's TCP timeout.
  it('gives up on a daemon that never answers', async () => {
    const hung = createServer(() => undefined);
    const endpoint = await serve(hung);
    expect(await vision(endpoint, 'llava').isAvailable()).toBe(false);
    expect(
      await new OllamaTextClient({ provider: 'ollama', endpoint, model: 'llama2' }).isAvailable(),
    ).toBe(false);
  }, 6_000);

  // Codex review: the timer must cover the body too, not just the headers.
  it('gives up on a daemon that sends headers and then stalls the body', async () => {
    const stalls = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"capabilities":["vis');
    });
    const endpoint = await serve(stalls);
    expect(await vision(endpoint, 'llava').isAvailable()).toBe(false);
  }, 6_000);

  // #522: fetchWithTimeout used to stop timing at the headers, so a body that never came
  // held the call forever. A body timeout is transient, retried like one before headers.
  it('times out and retries an analysis whose response body stalls', async () => {
    let requests = 0;
    const endpoint = await serve(
      createServer((_req, res) => {
        requests++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"response":"');
      }),
    );
    const client = new OllamaVisionClient({
      provider: 'ollama',
      endpoint,
      model: 'llava',
      timeout: 300,
      retryConfig: { maxRetries: 1, initialDelayMs: 10, maxDelayMs: 10, backoffMultiplier: 1 },
    } as never);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await expect(
      client.analyzeVisualDiff({ baseline: png, current: png } as never),
    ).rejects.toThrow();
    expect(requests).toBe(2); // retried once, as a transient failure
  }, 10_000);

  it('the model probe answers null when the listing body stalls', async () => {
    const endpoint = await serve(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"models":[');
      }),
    );
    const before = process.env.IRIS_MODEL_PROBE;
    process.env.IRIS_MODEL_PROBE = '1';
    resetModelProbeCache();
    try {
      expect(await listModels('ollama', { endpoint })).toBeNull();
    } finally {
      if (before === undefined) delete process.env.IRIS_MODEL_PROBE;
      else process.env.IRIS_MODEL_PROBE = before;
      resetModelProbeCache();
    }
  }, 10_000);

  it('the text client only needs the daemon up', async () => {
    const endpoint = await serve(fakeOllama({}));
    expect(
      await new OllamaTextClient({ provider: 'ollama', endpoint, model: 'llama2' }).isAvailable(),
    ).toBe(true);
  });
});

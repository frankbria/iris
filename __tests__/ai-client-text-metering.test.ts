/**
 * Text and agent-turn LLM calls are metered and budget-gated (issue #242).
 *
 * Only vision calls used to reach the CostTracker, so every `iris run`
 * translation and every agent-loop turn spent provider tokens with no ledger
 * row and no circuit breaker. These tests read the real SQLite ledger the
 * client writes (under the per-worker IRIS_DATA_DIR from jest.setup.ts), so a
 * row that is never written, or written under the wrong operation, fails here.
 *
 * Ollama is a real local HTTP server. OpenAI and Anthropic are the SDK fakes
 * the rest of the suite uses — what is under test is what IRIS does with the
 * usage a provider returns, not the vendor.
 */

import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createResolvedAIClient, CostTracker } from '../src/ai-client';
import { translate } from '../src/translator';
import { IrisConfig } from '../src/config';
import { resolveDataDir } from '../src/data-dir';

const mockOpenAICreate = jest.fn();
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockOpenAICreate } },
  })),
}));

const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  Anthropic: jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  })),
}));

const PLAN = JSON.stringify({
  actions: [{ type: 'click', selector: '#go' }],
  confidence: 0.9,
  reasoning: 'ok',
});

const ledgerPath = () => path.join(resolveDataDir(), 'cache', 'cost-tracking.db');

interface Row {
  provider: string;
  model: string;
  operation: string;
  cost: number;
  input_tokens: number | null;
  output_tokens: number | null;
}

function rows(): Row[] {
  if (!fs.existsSync(ledgerPath())) return [];
  const db = new Database(ledgerPath(), { readonly: true });
  try {
    return db
      .prepare(
        'SELECT provider, model, operation, cost, input_tokens, output_tokens FROM cost_tracking ORDER BY id',
      )
      .all() as Row[];
  } finally {
    db.close();
  }
}

/**
 * Spend the whole budget named by `envVar` ($1), so the breaker is tripped
 * before the call under test. Seeded through CostTracker itself, so the row
 * has whatever shape production writes.
 */
function exhaustBudget(envVar = 'IRIS_DAILY_BUDGET_USD'): void {
  process.env[envVar] = '1';
  const tracker = new CostTracker(ledgerPath());
  try {
    // gpt-4o input at $2.50/1M: $2.50 of spend.
    tracker.trackOperation('openai', 'gpt-4o', false, { inputTokens: 1_000_000, outputTokens: 0 });
  } finally {
    tracker.close();
  }
}

const config = (ai: Partial<IrisConfig['ai']>): IrisConfig => ({
  ai: { provider: 'openai', model: 'gpt-4o-mini', ...ai } as IrisConfig['ai'],
  watch: { patterns: [], debounceMs: 1000, ignore: [] },
  browser: { headless: true, timeout: 30000 },
});

const openaiReply = {
  choices: [{ message: { content: PLAN } }],
  usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
};

describe('text LLM metering (#242)', () => {
  let ollama: Server;
  let ollamaEndpoint = '';
  let ollamaHits = 0;

  beforeAll(async () => {
    ollama = createServer((req, res) => {
      ollamaHits++;
      req.resume();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ response: PLAN, prompt_eval_count: 321, eval_count: 45 }));
    });
    await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r));
    ollamaEndpoint = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => ollama.close(r));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    ollamaHits = 0;
    delete process.env.IRIS_DAILY_BUDGET_USD;
    delete process.env.IRIS_MONTHLY_BUDGET_USD;
    delete process.env.OLLAMA_ENDPOINT;
    fs.rmSync(ledgerPath(), { force: true });
  });

  afterAll(() => {
    delete process.env.IRIS_DAILY_BUDGET_USD;
    delete process.env.IRIS_MONTHLY_BUDGET_USD;
    delete process.env.OLLAMA_ENDPOINT;
  });

  it('records an OpenAI translation as a `text` row priced from its token usage', async () => {
    mockOpenAICreate.mockResolvedValue(openaiReply);
    const client = await createResolvedAIClient(config({ apiKey: 'sk-test' }));

    const plan = await client.translateInstruction({ instruction: 'click go' });

    expect(plan.actions).toHaveLength(1);
    // gpt-4o-mini: $0.15/1M input, $0.60/1M output.
    expect(rows()).toEqual([
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        operation: 'text',
        cost: expect.closeTo(1000 * 1.5e-7 + 200 * 6e-7, 12),
        input_tokens: 1000,
        output_tokens: 200,
      },
    ]);
  });

  it('records an Anthropic call made for the agent loop as an `agent_turn` row', async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: PLAN }],
      usage: { input_tokens: 2000, output_tokens: 100 },
    });
    const client = await createResolvedAIClient(
      config({ provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-haiku-4-5' }),
      { operation: 'agent_turn' },
    );

    await client.translateInstruction({ instruction: 'click go' });

    expect(rows()).toEqual([
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        operation: 'agent_turn',
        cost: expect.closeTo(2000 * 1e-6 + 100 * 5e-6, 12),
        input_tokens: 2000,
        output_tokens: 100,
      },
    ]);
  });

  // The provider billed for the call whatever IRIS then made of the reply. Two
  // shapes, because they leave the client by different return paths.
  it.each([
    ['not JSON', 'nope'],
    ['an action of the wrong shape', JSON.stringify({ actions: [{ type: 'teleport' }] })],
  ])('still records the tokens when the model reply is %s', async (_label, content) => {
    mockOpenAICreate.mockResolvedValue({
      ...openaiReply,
      choices: [{ message: { content } }],
    });
    const client = await createResolvedAIClient(config({ apiKey: 'sk-test' }));

    const plan = await client.translateInstruction({ instruction: 'click go' });

    expect(plan.actions).toEqual([]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ input_tokens: 1000, output_tokens: 200 });
  });

  it.each(['IRIS_DAILY_BUDGET_USD', 'IRIS_MONTHLY_BUDGET_USD'])(
    'refuses a paid text call before contacting the provider once %s is spent',
    async (envVar) => {
      exhaustBudget(envVar);
      mockOpenAICreate.mockResolvedValue(openaiReply);
      const client = await createResolvedAIClient(config({ apiKey: 'sk-test' }));

      await expect(client.translateInstruction({ instruction: 'click go' })).rejects.toThrow(
        /circuit breaker/,
      );
      expect(mockOpenAICreate).not.toHaveBeenCalled();
      expect(rows()).toHaveLength(1); // only the seeded spend
    },
  );

  it('refuses a paid call whose model was never priced (unknown is billable)', async () => {
    exhaustBudget();
    const client = await createResolvedAIClient(
      config({ provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-unpriced-9' }),
    );

    await expect(client.translateInstruction({ instruction: 'click go' })).rejects.toThrow(
      /circuit breaker/,
    );
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it('lets a local Ollama call through a tripped breaker and records it at $0', async () => {
    exhaustBudget();
    const client = await createResolvedAIClient(
      config({ provider: 'ollama', endpoint: ollamaEndpoint, model: 'gemma3' }),
    );

    const plan = await client.translateInstruction({ instruction: 'click go' });

    expect(ollamaHits).toBe(1);
    expect(plan.actions).toHaveLength(1);
    expect(rows()[1]).toEqual({
      provider: 'ollama',
      model: 'gemma3',
      operation: 'text',
      cost: 0,
      input_tokens: 321,
      output_tokens: 45,
    });
  });

  it('writes no row for a call that failed before the provider billed', async () => {
    mockOpenAICreate.mockRejectedValue(Object.assign(new Error('bad key'), { status: 401 }));
    const client = await createResolvedAIClient(config({ apiKey: 'sk-test' }));

    const plan = await client.translateInstruction({ instruction: 'click go' });

    expect(plan.confidence).toBe(0);
    expect(rows()).toEqual([]);
  });

  // The path users actually take: `iris run`, the RPC `instruction` method and
  // the watcher all call translate(). Testing only createResolvedAIClient would
  // stay green if translate() went back to building an unmetered client.
  it('meters a translate() call that falls through to the model', async () => {
    process.env.OLLAMA_ENDPOINT = ollamaEndpoint;

    const result = await translate('make sure the order total is shown');

    expect(result.method).toBe('ai');
    expect(rows()).toEqual([
      expect.objectContaining({ provider: 'ollama', operation: 'text', input_tokens: 321 }),
    ]);
  });

  // Each call opens its own tracker, so a per-instance "already warned" set
  // would print the unpriced-model warning on every translation.
  it('warns about an unpriced model once, not once per call', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: PLAN }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const client = await createResolvedAIClient(
      config({ provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-unpriced-8' }),
    );

    await client.translateInstruction({ instruction: 'click go' });
    await client.translateInstruction({ instruction: 'click go' });

    const hits = warn.mock.calls.filter((c) => String(c[0]).includes('claude-unpriced-8'));
    expect(hits).toHaveLength(1);
    warn.mockRestore();
  });

  // A $0 budget is documented as "free providers only". With an empty ledger
  // the spend fraction was 0/0 = NaN, and NaN >= 1 is false, so the first paid
  // call went through.
  it('treats a $0 budget as spent before the first paid call', async () => {
    process.env.IRIS_DAILY_BUDGET_USD = '0';
    mockOpenAICreate.mockResolvedValue(openaiReply);
    const client = await createResolvedAIClient(config({ apiKey: 'sk-test' }));

    await expect(client.translateInstruction({ instruction: 'click go' })).rejects.toThrow(
      /circuit breaker/,
    );
    expect(mockOpenAICreate).not.toHaveBeenCalled();
  });

  // Issue #244. Every call used to check the budget, await the provider, then
  // record: N calls in flight together all saw the same unspent budget. Each
  // call opens its own tracker, so this also proves a reservation made on one
  // connection is seen by the next.
  it('keeps N parallel paid calls within the limit plus one call', async () => {
    const limit = 0.004;
    process.env.IRIS_DAILY_BUDGET_USD = String(limit);
    // gpt-4o-mini at 8000 in / 1000 out: $0.0018, as large as one call gets.
    const callCost = 8000 * 1.5e-7 + 1000 * 6e-7;
    mockOpenAICreate.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return {
        ...openaiReply,
        usage: { prompt_tokens: 8000, completion_tokens: 1000, total_tokens: 9000 },
      };
    });
    const client = await createResolvedAIClient(config({ apiKey: 'sk-test' }));

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => client.translateInstruction({ instruction: 'click go' })),
    );

    const refused = results.filter((r) => r.status === 'rejected');
    expect(refused.length).toBeGreaterThan(0);
    expect(mockOpenAICreate).toHaveBeenCalledTimes(10 - refused.length);
    const spent = rows().reduce((sum, r) => sum + r.cost, 0);
    expect(spent).toBeLessThanOrEqual(limit + callCost);
  });

  // The instruction is the one input with no cap short of the RPC payload
  // limit, so a fixed per-call estimate under-holds a long one: the next call
  // would be admitted against budget the first is about to spend.
  it('holds budget in proportion to a long instruction while it is in flight', async () => {
    process.env.IRIS_DAILY_BUDGET_USD = '0.05';
    let answer: (() => void) | undefined;
    mockOpenAICreate.mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve(openaiReply))),
    );
    const client = await createResolvedAIClient(config({ apiKey: 'sk-test' }));

    // ~400k characters: at gpt-4o-mini's input rate, more than the whole budget.
    const long = client.translateInstruction({ instruction: 'click go '.repeat(45_000) });
    await new Promise((r) => setImmediate(r));

    await expect(client.translateInstruction({ instruction: 'click go' })).rejects.toThrow(
      /Budget limit exceeded/,
    );
    answer!();
    await long;
  });
});

describe('text LLM metering per org (#255)', () => {
  const orgRows = (): Array<{ org_id: string | null; operation: string }> => {
    if (!fs.existsSync(ledgerPath())) return [];
    const db = new Database(ledgerPath(), { readonly: true });
    try {
      return db.prepare('SELECT org_id, operation FROM cost_tracking ORDER BY id').all() as never;
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.IRIS_DAILY_BUDGET_USD = '1';
    fs.rmSync(ledgerPath(), { force: true });
  });

  afterAll(() => {
    delete process.env.IRIS_DAILY_BUDGET_USD;
  });

  it("charges the org that asked, and only that org's spend trips its breaker", async () => {
    mockOpenAICreate.mockResolvedValue(openaiReply);
    // Org A has spent its whole budget.
    const a = new CostTracker(ledgerPath(), {}, { orgId: 'org-a' });
    a.trackOperation('openai', 'gpt-4o', false, { inputTokens: 1_000_000, outputTokens: 0 });
    a.close();

    const forA = await createResolvedAIClient(config({ apiKey: 'sk-test' }), { orgId: 'org-a' });
    await expect(forA.translateInstruction({ instruction: 'click go' })).rejects.toThrow(
      /Budget limit exceeded/,
    );
    expect(mockOpenAICreate).not.toHaveBeenCalled();

    const forB = await createResolvedAIClient(config({ apiKey: 'sk-test' }), { orgId: 'org-b' });
    await expect(forB.translateInstruction({ instruction: 'click go' })).resolves.toBeDefined();
    expect(orgRows()).toEqual([
      { org_id: 'org-a', operation: 'vision-analysis' },
      { org_id: 'org-b', operation: 'text' },
    ]);
  });

  it('passes the org from translate() to the metered client', async () => {
    mockOpenAICreate.mockResolvedValue(openaiReply);
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      const result = await translate('make sure the order total is shown', undefined, {
        orgId: 'org-b',
      });
      expect(result.method).toBe('ai');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
    expect(orgRows()).toEqual([{ org_id: 'org-b', operation: 'text' }]);
  });
});

describe('settled calls reported for billing (#263)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(ledgerPath(), { force: true });
  });

  it('reports each settled call with its cost and whether that cost is estimated', async () => {
    mockOpenAICreate.mockResolvedValue(openaiReply);
    const calls: unknown[] = [];
    const client = await createResolvedAIClient(config({ apiKey: 'sk-test' }), {
      onUsage: (call) => {
        calls.push(call);
      },
    });
    await client.translateInstruction({ instruction: 'click go' });
    expect(calls).toEqual([
      {
        callId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        operation: 'text',
        provider: 'openai',
        model: 'gpt-4o-mini',
        costUsd: expect.closeTo(1000 * 1.5e-7 + 200 * 6e-7, 12),
        estimated: false,
      },
    ]);
  });

  it('reports an unpriced model as estimated, and a failing report does not fail the call', async () => {
    mockOpenAICreate.mockResolvedValue(openaiReply);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let seen: { estimated: boolean } | undefined;
    const client = await createResolvedAIClient(
      config({ apiKey: 'sk-test', model: 'gpt-imaginary-9' }),
      {
        onUsage: (call) => {
          seen = call;
          throw new Error('usage store down');
        },
      },
    );
    await expect(client.translateInstruction({ instruction: 'click go' })).resolves.toBeDefined();
    expect(seen?.estimated).toBe(true);
    expect(errors.mock.calls.flat().join(' ')).toMatch(/usage store down/);
    errors.mockRestore();
    warn.mockRestore();
  });
});

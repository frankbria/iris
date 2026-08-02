/**
 * Tests for `parseModelJson`, the shared tolerance layer in front of every
 * text client's response parsing.
 *
 * Found by running `iris run --agent` against a local Ollama model: gemma3
 * markdown-fences its JSON on essentially every call, the bare `JSON.parse`
 * threw, and the agent loop saw an empty plan every turn and terminated having
 * done nothing. All three providers shared the same bare parse.
 */

import { parseModelJson } from '../src/ai-client/base';
import { OllamaTextClient } from '../src/ai-client/text';
import { IrisConfig } from '../src/config';

describe('parseModelJson', () => {
  const payload = { actions: [{ type: 'click', selector: '#go' }], confidence: 0.9 };

  it('parses a clean JSON object', () => {
    expect(parseModelJson(JSON.stringify(payload))).toEqual(payload);
  });

  it.each([
    ['```json fence', '```json\n{"a":1}\n```'],
    ['bare ``` fence', '```\n{"a":1}\n```'],
    ['fence with no newlines', '```json {"a":1} ```'],
    ['leading prose', 'Here is the JSON you asked for:\n{"a":1}'],
    ['trailing sign-off', '{"a":1}\nLet me know if you need anything else!'],
    ['prose around a fence', 'Sure!\n```json\n{"a":1}\n```\nHope that helps.'],
    ['surrounding whitespace', '\n\n  {"a":1}  \n'],
  ])('recovers the object from %s', (_label, raw) => {
    expect(parseModelJson(raw)).toEqual({ a: 1 });
  });

  it('keeps a clean response byte-identical rather than reshaping it', () => {
    // Strictest-first ordering matters: the brace-span salvage would mangle an
    // object containing a string with braces in it.
    const tricky = { reasoning: 'use the {selector} placeholder', actions: [] };
    expect(parseModelJson(JSON.stringify(tricky))).toEqual(tricky);
  });

  it.each([
    ['a bare array', '[1,2,3]'],
    ['a bare string', '"just text"'],
    ['a number', '42'],
    ['null', 'null'],
  ])('rejects %s — valid JSON, but never a valid response here', (_label, raw) => {
    expect(() => parseModelJson(raw)).toThrow(/did not return a JSON object/);
  });

  it('throws with a truncated excerpt when nothing parses', () => {
    const noise = `I cannot help with that. ${'x'.repeat(500)}`;
    expect(() => parseModelJson(noise)).toThrow(/did not return a JSON object/);
    // The excerpt must not dump the entire model reply into the log.
    try {
      parseModelJson(noise);
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(140);
    }
  });
});

describe('OllamaTextClient tolerates a fenced response (regression)', () => {
  const config: IrisConfig['ai'] = {
    provider: 'ollama',
    endpoint: 'http://localhost:11434',
    model: 'gemma3:latest',
    timeout: 1000,
  } as IrisConfig['ai'];

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('extracts actions from a markdown-fenced reply instead of returning none', async () => {
    // Exactly the shape gemma3 returned when this was found.
    const fenced =
      '```json\n{\n  "actions": [{"type": "click", "selector": "#signin"}],\n' +
      '  "confidence": 0.9,\n  "reasoning": "Click the sign in button"\n}\n```';

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ response: fenced }),
    } as Response);

    const result = await new OllamaTextClient(config).translateInstruction({
      instruction: 'click sign in',
    });

    expect(result.actions).toEqual([{ type: 'click', selector: '#signin' }]);
    expect(result.confidence).toBe(0.9);
    expect(result.reasoning).toBe('Click the sign in button');
  });

  it('preserves a legitimate confidence of 0 instead of coercing it to 0.5', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        response: JSON.stringify({ actions: [], confidence: 0, reasoning: 'no idea' }),
      }),
    } as Response);

    const result = await new OllamaTextClient(config).translateInstruction({
      instruction: 'do something impossible',
    });

    expect(result.confidence).toBe(0);
  });
});

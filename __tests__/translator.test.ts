import { translate, translateSync } from '../src/translator';

// Mock config and AI client
jest.mock('../src/config', () => ({
  loadConfig: jest.fn().mockReturnValue({
    ai: {
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    },
  }),
  validateConfig: jest.fn().mockReturnValue([]),
}));

jest.mock('../src/ai-client', () => ({
  createAIClient: jest.fn().mockReturnValue({
    isAvailable: jest.fn().mockResolvedValue(true),
    translateInstruction: jest.fn().mockResolvedValue({
      actions: [{ type: 'click', selector: '#ai-generated' }],
      confidence: 0.8,
      reasoning: 'AI-generated action',
    }),
  }),
}));

describe('Translator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('translateSync (legacy)', () => {
    it('should translate click commands', () => {
      const result = translateSync('click submit');
      expect(result).toEqual([{ type: 'click', selector: 'submit' }]);
    });

    it('should translate fill commands', () => {
      const result = translateSync('fill email with test@example.com');
      expect(result).toEqual([{ type: 'fill', selector: 'email', text: 'test@example.com' }]);
    });

    it('should translate navigate commands', () => {
      const result = translateSync('navigate to https://example.com');
      expect(result).toEqual([{ type: 'navigate', url: 'https://example.com' }]);
    });

    it('should return empty array for unrecognized commands', () => {
      const result = translateSync('unknown command');
      expect(result).toEqual([]);
    });
  });

  describe('translate (async with AI)', () => {
    it('should reject oversized instructions with a clear error', async () => {
      const oversized = 'click '.repeat(2000); // ~12k chars, over the 10k cap
      await expect(translate(oversized)).rejects.toThrow(/too long/i);
    });

    it('translateSync also rejects oversized instructions', () => {
      const oversized = 'click '.repeat(2000);
      expect(() => translateSync(oversized)).toThrow(/too long/i);
    });

    it('should use pattern matching for simple click commands', async () => {
      const result = await translate('click submit');

      expect(result.actions).toEqual([{ type: 'click', selector: 'submit' }]);
      expect(result.method).toBe('pattern');
      expect(result.confidence).toBe(0.9);
    });

    it('should use enhanced pattern matching', async () => {
      const tests = [
        { input: 'press submit', expected: 'submit' },
        { input: 'tap login', expected: 'login' },
      ];

      for (const test of tests) {
        const result = await translate(test.input);
        expect(result.actions).toEqual([{ type: 'click', selector: test.expected }]);
        expect(result.method).toBe('pattern');
      }
    });

    it('should use enhanced fill patterns', async () => {
      const tests = [
        { input: 'enter john into name', selector: 'name', text: 'john' },
        { input: 'type password in password-field', selector: 'password-field', text: 'password' },
        { input: 'input hello to message', selector: 'message', text: 'hello' },
      ];

      for (const test of tests) {
        const result = await translate(test.input);
        expect(result.actions).toEqual([
          { type: 'fill', selector: test.selector, text: test.text },
        ]);
        expect(result.method).toBe('pattern');
      }
    });

    it('should use enhanced navigation patterns', async () => {
      const tests = [
        'go to https://example.com',
        'visit https://example.com',
        'open https://example.com',
      ];

      for (const test of tests) {
        const result = await translate(test);
        expect(result.actions).toEqual([{ type: 'navigate', url: 'https://example.com' }]);
        expect(result.method).toBe('pattern');
      }
    });

    it('should fall back to AI for complex instructions', async () => {
      const { createAIClient } = await import('../src/ai-client');

      const result = await translate('find the blue button next to the search box and click it');

      expect(result.actions).toEqual([{ type: 'click', selector: '#ai-generated' }]);
      expect(result.method).toBe('ai');
      expect(result.confidence).toBe(0.8);
      expect(result.reasoning).toBe('AI-generated action');
      expect(createAIClient).toHaveBeenCalled();
    });

    it('should handle AI client not available', async () => {
      const { createAIClient } = await import('../src/ai-client');
      const mockClient = {
        isAvailable: jest.fn().mockResolvedValue(false),
        translateInstruction: jest.fn(),
      };
      (createAIClient as jest.Mock).mockReturnValue(mockClient);

      const result = await translate('complex instruction that no pattern matches');

      expect(result.actions).toEqual([]);
      expect(result.method).toBe('ai');
      expect(result.confidence).toBe(0);
      expect(result.reasoning).toBe('AI client not available');
    });

    it('should handle config validation errors', async () => {
      const { validateConfig } = await import('../src/config');
      (validateConfig as jest.Mock).mockReturnValue(['API key missing']);

      const result = await translate('complex instruction');

      expect(result.actions).toEqual([]);
      expect(result.method).toBe('ai');
      expect(result.confidence).toBe(0);
      expect(result.reasoning).toBe('AI translation failed: API key missing');
    });

    it('should handle AI translation errors', async () => {
      const { createAIClient } = await import('../src/ai-client');
      const { validateConfig } = await import('../src/config');

      // Reset validation to return no errors for this test
      (validateConfig as jest.Mock).mockReturnValue([]);

      const mockClient = {
        isAvailable: jest.fn().mockResolvedValue(true),
        translateInstruction: jest.fn().mockRejectedValue(new Error('Network error')),
      };
      (createAIClient as jest.Mock).mockReturnValue(mockClient);

      const result = await translate('complex instruction that no pattern matches');

      expect(result.actions).toEqual([]);
      expect(result.method).toBe('ai');
      expect(result.confidence).toBe(0);
      expect(result.reasoning).toBe('AI translation error: Network error');
    });

    it('should include context in AI requests', async () => {
      const { createAIClient } = await import('../src/ai-client');
      const mockClient = {
        isAvailable: jest.fn().mockResolvedValue(true),
        translateInstruction: jest.fn().mockResolvedValue({
          actions: [],
          confidence: 0.5,
        }),
      };
      (createAIClient as jest.Mock).mockReturnValue(mockClient);

      await translate('complex instruction', { url: 'https://example.com' });

      expect(mockClient.translateInstruction).toHaveBeenCalledWith({
        instruction: 'complex instruction',
        context: { url: 'https://example.com' },
      });
    });
  });
});

// Issue #116: the PRD's defining command class ("make sure X") could not even be
// represented — the vocabulary was click|fill|navigate and success meant "the
// Playwright call didn't throw".
describe('assertion vocabulary (issue #116)', () => {
  const { translateSync } = require('../src/translator');
  const { ActionSchema, parseActions, describeAction } = require('../src/actions');

  describe('explicit pattern forms', () => {
    it.each([
      ['verify Welcome is visible', 'text_visible', 'Welcome'],
      ['make sure Welcome is visible', 'text_visible', 'Welcome'],
      ['check Welcome is visible', 'text_visible', 'Welcome'],
      ['confirm Welcome is visible', 'text_visible', 'Welcome'],
      ['verify #spinner is not visible', 'element_absent', '#spinner'],
      ['verify #spinner is hidden', 'element_absent', '#spinner'],
      ['verify the url contains /checkout', 'url_matches', '/checkout'],
      ['verify url contains /checkout', 'url_matches', '/checkout'],
    ])('%s -> assert %s', (instruction, kind, target) => {
      expect(translateSync(instruction)).toEqual([
        { type: 'assert', kind, target, description: instruction },
      ]);
    });

    // Anything richer needs the AI path; a greedy pattern would silently
    // mistranslate a multi-step goal into one shallow check.
    it('leaves an open-ended goal to the AI path rather than guessing', () => {
      expect(translateSync('make sure users can complete checkout')).toEqual([]);
    });
  });

  describe('ActionSchema', () => {
    it('accepts a well-formed assert', () => {
      expect(
        ActionSchema.safeParse({ type: 'assert', kind: 'text_visible', target: 'Hi' }).success,
      ).toBe(true);
    });

    it('rejects an unknown assert kind', () => {
      expect(ActionSchema.safeParse({ type: 'assert', kind: 'bogus', target: 'Hi' }).success).toBe(
        false,
      );
    });

    it('rejects an assert with no target', () => {
      expect(
        ActionSchema.safeParse({ type: 'assert', kind: 'text_visible', target: '' }).success,
      ).toBe(false);
    });

    it('still accepts the pre-existing action types', () => {
      expect(ActionSchema.safeParse({ type: 'click', selector: '#a' }).success).toBe(true);
      expect(ActionSchema.safeParse({ type: 'navigate', url: 'https://a.test' }).success).toBe(
        true,
      );
    });
  });

  describe('parseActions', () => {
    it('accepts a valid list', () => {
      const result = parseActions([{ type: 'click', selector: '#a' }]);
      expect(result).toEqual({ ok: true, actions: [{ type: 'click', selector: '#a' }] });
    });

    // All-or-nothing: executing the valid subset would present a partial run as
    // a complete one.
    it('rejects the whole list when any member is malformed', () => {
      const result = parseActions([
        { type: 'click', selector: '#a' },
        { type: 'assert', kind: 'bogus', target: 'x' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/action\[1\]/);
    });

    it('rejects a non-array', () => {
      expect(parseActions('nope').ok).toBe(false);
    });
  });

  it('describeAction covers every union member', () => {
    expect(describeAction({ type: 'click', selector: '#a' })).toBe('click #a');
    expect(describeAction({ type: 'fill', selector: '#a', text: 'b' })).toBe('fill #a = "b"');
    expect(describeAction({ type: 'navigate', url: 'https://a.test' })).toBe(
      'navigate https://a.test',
    );
    expect(describeAction({ type: 'assert', kind: 'url_matches', target: '/x' })).toBe(
      'assert url_matches /x',
    );
  });
});

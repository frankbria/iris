import { formatError } from '../src/ai-client/base';

describe('formatError (log hygiene, issue #37)', () => {
  it('returns the message for a plain Error without dumping the object', () => {
    expect(formatError(new Error('boom'))).toBe('boom');
  });

  it('appends status and code when present (SDK APIError shape)', () => {
    const apiError = Object.assign(new Error('rate limited'), {
      status: 429,
      code: 'rate_limit_exceeded',
    });
    expect(formatError(apiError)).toBe('rate limited (status=429, code=rate_limit_exceeded)');
  });

  it('does not leak sensitive fields like headers or request_id', () => {
    const apiError = Object.assign(new Error('unauthorized'), {
      status: 401,
      headers: { authorization: 'Bearer sk-secret' },
      request_id: 'req_12345',
    });
    const out = formatError(apiError);
    expect(out).not.toContain('sk-secret');
    expect(out).not.toContain('req_12345');
    expect(out).not.toContain('authorization');
    expect(out).toBe('unauthorized (status=401)');
  });

  it('stringifies non-Error values', () => {
    expect(formatError('just a string')).toBe('just a string');
    expect(formatError(42)).toBe('42');
  });
});

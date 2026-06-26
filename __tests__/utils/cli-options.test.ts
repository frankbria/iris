import { InvalidArgumentError } from 'commander';
import { parseIntOption, parseFloatOption } from '../../src/utils/cli-options';

describe('cli-options numeric validation', () => {
  // One invalid value per CLI option (issue #33 acceptance criteria), plus a
  // valid pass-through, to prove the friendly error fires and good input works.
  const intCases = [
    { name: 'timeout', min: 1000, max: 3600000, bad: 'abc', good: '30000', expected: 30000 },
    { name: 'browserTimeout', min: 1000, max: 3600000, bad: 'NaN', good: '5000', expected: 5000 },
    { name: 'retryAttempts', min: 0, max: 10, bad: '99', good: '2', expected: 2 },
    { name: 'retryDelay', min: 0, max: 60000, bad: '-1', good: '1000', expected: 1000 },
    { name: 'port', min: 1, max: 65535, bad: 'notaport', good: '4000', expected: 4000 },
    { name: 'concurrency', min: 1, max: 32, bad: '0', good: '3', expected: 3 },
  ];

  for (const c of intCases) {
    test(`${c.name}: rejects "${c.bad}" with a friendly error`, () => {
      expect(() => parseIntOption(c.bad, { min: c.min, max: c.max, name: c.name })).toThrow(
        InvalidArgumentError,
      );
      expect(() => parseIntOption(c.bad, { min: c.min, max: c.max, name: c.name })).toThrow(c.name);
    });

    test(`${c.name}: accepts valid "${c.good}"`, () => {
      expect(parseIntOption(c.good, { min: c.min, max: c.max, name: c.name })).toBe(c.expected);
    });
  }

  test('parseIntOption rejects non-integer values', () => {
    expect(() => parseIntOption('1.5', { min: 0, max: 10, name: 'retryAttempts' })).toThrow(
      'integer',
    );
  });

  test('threshold: rejects out-of-range float with a friendly error', () => {
    expect(() => parseFloatOption('2', { min: 0, max: 1, name: 'threshold' })).toThrow(
      InvalidArgumentError,
    );
    expect(() => parseFloatOption('2', { min: 0, max: 1, name: 'threshold' })).toThrow('threshold');
  });

  test('threshold: rejects non-numeric value', () => {
    expect(() => parseFloatOption('abc', { min: 0, max: 1, name: 'threshold' })).toThrow('number');
  });

  test('threshold: accepts valid fractional value', () => {
    expect(parseFloatOption('0.25', { min: 0, max: 1, name: 'threshold' })).toBe(0.25);
  });

  // Number('') === 0, so empty values must be rejected even for min:0 options.
  test('rejects empty value for a min:0 option', () => {
    expect(() => parseIntOption('', { min: 0, max: 10, name: 'retryDelay' })).toThrow(
      InvalidArgumentError,
    );
    expect(() => parseFloatOption('   ', { min: 0, max: 1, name: 'threshold' })).toThrow(
      InvalidArgumentError,
    );
  });
});

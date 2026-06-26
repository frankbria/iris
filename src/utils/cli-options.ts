import { InvalidArgumentError } from 'commander';

export interface NumericRange {
  min: number;
  max: number;
  name: string;
}

/**
 * Parse and validate a numeric CLI option/argument.
 *
 * Uses `Number()` (not `parseInt`/`parseFloat`) so partial-numeric typos like
 * "3abc" become NaN and are rejected instead of silently truncated. Throws
 * commander's `InvalidArgumentError` so commander prints a friendly one-line
 * message and exits with code 1 instead of a stack trace.
 */
function parse(raw: string, { min, max, name }: NumericRange, integer: boolean): number {
  // `Number('')` and `Number('  ')` are 0, so an empty/whitespace value would
  // silently pass for min:0 options — reject it explicitly.
  const value = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new InvalidArgumentError(
      `${name} must be ${integer ? 'an integer' : 'a number'} (got "${raw}").`,
    );
  }
  if (value < min || value > max) {
    throw new InvalidArgumentError(`${name} must be between ${min} and ${max} (got ${value}).`);
  }
  return value;
}

export function parseIntOption(raw: string, range: NumericRange): number {
  return parse(raw, range, true);
}

export function parseFloatOption(raw: string, range: NumericRange): number {
  return parse(raw, range, false);
}

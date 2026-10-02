import type { createAuth } from '../src/auth/config';

type Options = Parameters<typeof createAuth>[0];

// A type-level guard (checked by `tsc`, #276): options that create users outside
// `/sign-up/email` would skip the terms check, so createAuth must not accept them.
describe('createAuth options', () => {
  it('reject socialProviders', () => {
    // @ts-expect-error socialProviders is omitted from the options type
    const bad: Options['socialProviders'] = {};
    expect(bad).toEqual({});
  });
});

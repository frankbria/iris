/**
 * IRIS_HOSTED=1 forces the strict URL policy on every navigation path (#334,
 * ADR 0001 §5). The switch is read once and memoized, so each case loads a fresh
 * module registry with the variable set the way that case needs it.
 */

type UrlPolicyModule = typeof import('../src/url-policy');
type HostedModule = typeof import('../src/hosted');

function withEnv<T>(value: string | undefined, load: () => T): T {
  const prev = process.env.IRIS_HOSTED;
  if (value === undefined) delete process.env.IRIS_HOSTED;
  else process.env.IRIS_HOSTED = value;
  try {
    let loaded!: T;
    jest.isolateModules(() => {
      loaded = load();
    });
    return loaded;
  } finally {
    if (prev === undefined) delete process.env.IRIS_HOSTED;
    else process.env.IRIS_HOSTED = prev;
  }
}

// The switch is read on first use, so read it while the variable is still set.
const loadPolicy = (value: string | undefined): UrlPolicyModule =>
  withEnv(value, () => {
    (require('../src/hosted') as HostedModule).isHostedMode();
    return require('../src/url-policy') as UrlPolicyModule;
  });

const hostedFor = (value: string | undefined): boolean =>
  withEnv(value, () => (require('../src/hosted') as HostedModule).isHostedMode());

// 100.64.0.0 rather than an arbitrary CGNAT host: the #329 hygiene guard only
// allowlists range edges there, since tailnet addresses live in that range.
const INTERNAL_TARGETS = [
  'http://127.0.0.1/',
  'http://10.0.0.1/',
  'http://100.64.0.0/',
  'http://169.254.169.254/latest/meta-data/',
];

describe('isHostedMode', () => {
  it.each([undefined, '', '0', 'false', 'FALSE'])('is off for %p', (value) => {
    expect(hostedFor(value)).toBe(false);
  });

  // Fail closed: a deploy that writes `true` or `yes` must not silently run permissive.
  it.each(['1', 'true', 'yes', 'on'])('is on for %p', (value) => {
    expect(hostedFor(value)).toBe(true);
  });

  it('is read once: clearing the variable afterwards does not relax it', () => {
    const prev = process.env.IRIS_HOSTED;
    process.env.IRIS_HOSTED = '1';
    try {
      jest.isolateModules(() => {
        const { isHostedMode } = require('../src/hosted') as HostedModule;
        expect(isHostedMode()).toBe(true);
        delete process.env.IRIS_HOSTED;
        expect(isHostedMode()).toBe(true);
      });
    } finally {
      if (prev === undefined) delete process.env.IRIS_HOSTED;
      else process.env.IRIS_HOSTED = prev;
    }
  });
});

describe('assertNavigationAllowed under IRIS_HOSTED=1', () => {
  const { assertNavigationAllowed } = loadPolicy('1');

  it.each(INTERNAL_TARGETS)('refuses %s by default', (url) => {
    expect(() => assertNavigationAllowed(url)).toThrow(/Navigation blocked/);
  });

  it.each(INTERNAL_TARGETS)('refuses %s even when the caller opts out', (url) => {
    expect(() => assertNavigationAllowed(url, { blockPrivateHosts: false })).toThrow(
      /Navigation blocked/,
    );
  });

  it('refuses file:// even when the caller opts in', () => {
    expect(() => assertNavigationAllowed('file:///etc/passwd', { allowFile: true })).toThrow(
      /file/,
    );
  });

  it('refuses data: even when the caller opts in', () => {
    expect(() => assertNavigationAllowed('data:text/html,hi', { allowData: true })).toThrow(
      /data:/,
    );
  });

  it('still allows a public URL, and still enforces a pinned origin', () => {
    expect(() => assertNavigationAllowed('https://example.com/')).not.toThrow();
    expect(() =>
      assertNavigationAllowed('https://other.example/', { pinnedOrigin: 'https://example.com' }),
    ).toThrow(/pinned origin/);
  });
});

describe('assertNavigationAllowed in local mode', () => {
  const { assertNavigationAllowed } = loadPolicy(undefined);

  it('keeps the permissive default for loopback and private hosts', () => {
    expect(() => assertNavigationAllowed('http://127.0.0.1/')).not.toThrow();
    expect(() => assertNavigationAllowed('http://10.0.0.1/')).not.toThrow();
  });
});

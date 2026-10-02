import { spawnSync } from 'child_process';
import path from 'path';
import { axeTagsFor } from '../src/worker';

/** `iris worker` (#267): refuses outside hosted mode, in a real process. */
describe('iris worker', () => {
  const run = (env: NodeJS.ProcessEnv) =>
    spawnSync(
      process.execPath,
      ['-r', 'ts-node/register', path.join(__dirname, '../src/cli.ts'), 'worker'],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', ...env },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );

  it('exits 2 without IRIS_HOSTED', () => {
    const { status, stderr } = run({ IRIS_HOSTED: '' });
    expect(status).toBe(2);
    expect(stderr).toContain('hosted mode only');
  });

  it('exits 3 in hosted mode without a database URL', () => {
    const { status, stderr } = run({ IRIS_HOSTED: '1', DATABASE_URL: '', DATABASE_URL_FILE: '' });
    expect(status).toBe(3);
    expect(stderr).toContain('DATABASE_URL');
  });
});

describe('axeTagsFor', () => {
  it('each WCAG level includes the ones below, like --tags', () => {
    expect(axeTagsFor('A')).toEqual(['wcag2a']);
    expect(axeTagsFor('AA')).toEqual(['wcag2a', 'wcag2aa']);
    expect(axeTagsFor('AAA')).toEqual(['wcag2a', 'wcag2aa', 'wcag2aaa']);
  });
});

describe('processNextA11yJob', () => {
  it('records a generic error when the result cannot be stored, and logs the detail', async () => {
    const { processNextA11yJob } = await import('../src/worker');
    const job = {
      id: 'j',
      orgId: 'o',
      apiKeyId: null,
      kind: 'a11y',
      startedAt: new Date(),
      params: { urls: ['https://a.example/'], wcagLevel: 'AA', failOn: [] },
    };
    const fail = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../src/a11y/a11y-runner', () => ({
      AccessibilityRunner: class {
        async run() {
          return { summary: {}, results: [] };
        }
      },
    }));
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await processNextA11yJob({
      claim: async () => job as never,
      finish: async () => {
        throw new Error('relation "usage_events" does not exist');
      },
      fail,
    });
    expect(fail).toHaveBeenCalledWith(job, 'Could not store the result');
    expect(log.mock.calls.flat().join(' ')).toContain('usage_events');
    log.mockRestore();
    jest.dontMock('../src/a11y/a11y-runner');
  });
});

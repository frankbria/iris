import { FREE_ORGS_PER_USER, PLANS, resolveEntitlements } from '../../src/billing/plans';

/** The plan catalog (#260): owner-approved launch limits, and how overrides resolve. */
describe('plan catalog', () => {
  it('has the launch plans with the approved limits', () => {
    expect(PLANS).toEqual({
      free: {
        maxConcurrentSessions: 1,
        runsPerMonth: 50,
        agentTurnsPerMonth: 100,
        visionCallsPerMonth: 50,
        artifactStorageBytes: 1 * 1024 ** 3,
        managedAiCreditUsdPerMonth: 0,
        byokAllowed: true,
      },
      pro: {
        maxConcurrentSessions: 2,
        runsPerMonth: 1000,
        agentTurnsPerMonth: 2000,
        visionCallsPerMonth: 1000,
        artifactStorageBytes: 20 * 1024 ** 3,
        managedAiCreditUsdPerMonth: 10,
        byokAllowed: true,
      },
      team: {
        maxConcurrentSessions: 4,
        runsPerMonth: 5000,
        agentTurnsPerMonth: 10000,
        visionCallsPerMonth: 5000,
        artifactStorageBytes: 100 * 1024 ** 3,
        managedAiCreditUsdPerMonth: 50,
        byokAllowed: true,
      },
    });
    expect(FREE_ORGS_PER_USER).toBe(1);
  });
});

describe('resolveEntitlements', () => {
  it("is the plan's limits when there are no overrides", () => {
    expect(resolveEntitlements('pro', {})).toEqual({ plan: 'pro', ...PLANS.pro });
  });

  it('applies valid overrides on top of the plan (a support grant)', () => {
    expect(resolveEntitlements('free', { runsPerMonth: 500, byokAllowed: false })).toEqual({
      plan: 'free',
      ...PLANS.free,
      runsPerMonth: 500,
      byokAllowed: false,
    });
  });

  it('ignores unknown keys and invalid values rather than trusting them', () => {
    const resolved = resolveEntitlements('free', {
      runsPerMonth: -1,
      agentTurnsPerMonth: 1.5,
      visionCallsPerMonth: '9999',
      maxConcurrentSessions: Number.POSITIVE_INFINITY,
      byokAllowed: 'yes',
      plan: 'team',
      isAdmin: true,
      extraSeats: 5, // a number, but not a limit the plans define
    });
    expect(resolved).toEqual({ plan: 'free', ...PLANS.free });
  });

  it('ignores prototype keys in overrides', () => {
    const hostile = JSON.parse('{"__proto__":{"runsPerMonth":9},"constructor":1,"toString":2}');
    const resolved = resolveEntitlements('free', hostile);
    expect(resolved).toEqual({ plan: 'free', ...PLANS.free });
    expect(({} as Record<string, unknown>).runsPerMonth).toBeUndefined();
  });

  it('treats an unknown plan id as free (fails closed)', () => {
    expect(resolveEntitlements('enterprise', {})).toEqual({ plan: 'free', ...PLANS.free });
  });

  it('treats overrides that are not an object as none', () => {
    expect(resolveEntitlements('pro', null)).toEqual({ plan: 'pro', ...PLANS.pro });
    expect(resolveEntitlements('pro', [1, 2])).toEqual({ plan: 'pro', ...PLANS.pro });
  });
});

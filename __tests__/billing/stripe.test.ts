import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hasLiveSubscription, planForPrice, resolveStripeConfig } from '../../src/billing/stripe';

/** Stripe configuration (#261): all four settings or none, and the price-to-plan map. */
const FULL = {
  IRIS_STRIPE_SECRET_KEY: 'sk_test_123',
  IRIS_STRIPE_WEBHOOK_SECRET: 'whsec_123',
  IRIS_STRIPE_PRICE_PRO: 'price_pro',
  IRIS_STRIPE_PRICE_TEAM: 'price_team',
};

describe('resolveStripeConfig', () => {
  it('is null when nothing is set: billing is off', () => {
    expect(resolveStripeConfig({})).toBeNull();
  });

  it('reads all four settings', () => {
    expect(resolveStripeConfig(FULL)).toEqual({
      secretKey: 'sk_test_123',
      webhookSecret: 'whsec_123',
      prices: { pro: 'price_pro', team: 'price_team' },
    });
  });

  it('reads a secret from its _FILE variant', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-stripe-'));
    const file = path.join(dir, 'secret');
    fs.writeFileSync(file, 'sk_test_from_file\n');
    const { IRIS_STRIPE_SECRET_KEY: _inline, ...rest } = FULL;
    expect(resolveStripeConfig({ ...rest, IRIS_STRIPE_SECRET_KEY_FILE: file })?.secretKey).toBe(
      'sk_test_from_file',
    );
    fs.rmSync(dir, { recursive: true });
  });

  it('throws on a partial configuration, naming what is missing', () => {
    const { IRIS_STRIPE_WEBHOOK_SECRET: _secret, IRIS_STRIPE_PRICE_TEAM: _team, ...partial } = FULL;
    expect(() => resolveStripeConfig(partial)).toThrow(
      /IRIS_STRIPE_WEBHOOK_SECRET, IRIS_STRIPE_PRICE_TEAM/,
    );
  });
});

describe('planForPrice', () => {
  const config = resolveStripeConfig(FULL)!;

  it('maps each configured price to its plan', () => {
    expect(planForPrice(config, 'price_pro')).toBe('pro');
    expect(planForPrice(config, 'price_team')).toBe('team');
  });

  it('is null for a price IRIS does not sell', () => {
    expect(planForPrice(config, 'price_other')).toBeNull();
  });
});

describe('hasLiveSubscription', () => {
  it('is false with no account, no subscription, or one that ended', () => {
    expect(hasLiveSubscription(null)).toBe(false);
    for (const subscriptionStatus of [null, 'canceled', 'incomplete_expired'])
      expect(hasLiveSubscription({ customerId: 'cus_1', subscriptionStatus })).toBe(false);
  });

  it('is true while a subscription runs, past due included', () => {
    for (const subscriptionStatus of ['active', 'trialing', 'past_due', 'incomplete'])
      expect(hasLiveSubscription({ customerId: 'cus_1', subscriptionStatus })).toBe(true);
  });
});

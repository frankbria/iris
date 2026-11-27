import { resolveGraceDays } from '../../src/billing/payment-grace';

describe('resolveGraceDays (IRIS_BILLING_GRACE_DAYS, #266)', () => {
  it('defaults to 7 days when unset or empty', () => {
    expect(resolveGraceDays({})).toBe(7);
    expect(resolveGraceDays({ IRIS_BILLING_GRACE_DAYS: '' })).toBe(7);
  });

  it('accepts whole days from 0 to 90', () => {
    expect(resolveGraceDays({ IRIS_BILLING_GRACE_DAYS: '0' })).toBe(0);
    expect(resolveGraceDays({ IRIS_BILLING_GRACE_DAYS: '14' })).toBe(14);
    expect(resolveGraceDays({ IRIS_BILLING_GRACE_DAYS: '90' })).toBe(90);
  });

  it.each(['-1', '1.5', '91', 'a week', '7d', ' '])('refuses %j', (value) => {
    expect(() => resolveGraceDays({ IRIS_BILLING_GRACE_DAYS: value })).toThrow(
      'IRIS_BILLING_GRACE_DAYS must be a whole number of days from 0 to 90',
    );
  });
});

/**
 * `stripeMeters` (#264): what IRIS sends to Stripe's meter API and how it reads errors.
 *
 * Test strategy: the real Stripe SDK pointed at a local HTTP server that answers as the
 * Stripe API documents. So the requests are the bytes the SDK would send to Stripe; only
 * Stripe's own behaviour is played.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../../src/billing/stripe';
import { METER_EVENT_NAME, MeterEventRejected, stripeMeters } from '../../src/billing/stripe-meter';

interface Received {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  idempotencyKey: string | undefined;
}

type Answer = { status: number; body: object };

describe('stripeMeters', () => {
  let server: http.Server;
  let stripe: Stripe;
  let received: Received[];
  let answer: (request: Received) => Answer;

  const list = (data: object[], hasMore = false): Answer => ({
    status: 200,
    body: { object: 'list', data, has_more: hasMore, url: '/v1/x' },
  });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://stripe.test');
        const header = req.headers['idempotency-key'];
        const request: Received = {
          method: req.method ?? '',
          path: url.pathname,
          query: url.searchParams,
          form: new URLSearchParams(Buffer.concat(chunks).toString('utf8')),
          idempotencyKey: typeof header === 'string' ? header : undefined,
        };
        received.push(request);
        const { status, body } = answer(request);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    stripe = new Stripe('sk_test_local', {
      apiVersion: STRIPE_API_VERSION,
      host: '127.0.0.1',
      port,
      protocol: 'http',
      maxNetworkRetries: 0,
    });
  });

  beforeEach(() => {
    received = [];
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const event = {
    identifier: 'usage-7b0c',
    customerId: 'cus_123',
    microUsd: 12_500,
    at: new Date('2026-11-10T08:30:15.900Z'),
  };

  it('sends a meter event with the identifier as its idempotency key', async () => {
    answer = () => ({ status: 200, body: { object: 'billing.meter_event' } });

    await stripeMeters(stripe).send(event);

    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v1/billing/meter_events');
    expect(request.idempotencyKey).toBe('usage-7b0c');
    expect(Object.fromEntries(request.form)).toEqual({
      event_name: METER_EVENT_NAME,
      identifier: 'usage-7b0c',
      timestamp: '1794299415',
      'payload[stripe_customer_id]': 'cus_123',
      'payload[value]': '12500',
    });
  });

  it('turns an invalid request into MeterEventRejected with Stripe’s message', async () => {
    answer = () => ({
      status: 400,
      body: {
        error: { type: 'invalid_request_error', message: 'Timestamp is too far in the past.' },
      },
    });

    const sending = stripeMeters(stripe).send(event);

    await expect(sending).rejects.toThrow(MeterEventRejected);
    await expect(sending).rejects.toThrow('Timestamp is too far in the past.');
  });

  it.each([
    ['a server error', 500, { error: { type: 'api_error', message: 'Something went wrong' } }],
    ['a rate limit', 429, { error: { type: 'rate_limit_error', message: 'Too many requests' } }],
    [
      'a refused key',
      401,
      { error: { type: 'invalid_request_error', message: 'Invalid API Key' } },
    ],
  ])(
    'lets %s through as it is: the event is not rejected, the pass is over',
    async (_n, status, body) => {
      answer = () => ({ status, body });

      const failure: unknown = await stripeMeters(stripe)
        .send(event)
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(MeterEventRejected);
    },
  );

  it('sums the meter’s event summaries for a customer and period, over every page', async () => {
    answer = (request) => {
      if (request.path === '/v1/billing/meters')
        return list([
          { id: 'mtr_other', object: 'billing.meter', event_name: 'something_else' },
          { id: 'mtr_iris', object: 'billing.meter', event_name: METER_EVENT_NAME },
        ]);
      return request.query.has('starting_after')
        ? list([{ id: 'sum_2', object: 'billing.meter_event_summary', aggregated_value: 500 }])
        : list(
            [{ id: 'sum_1', object: 'billing.meter_event_summary', aggregated_value: 12_000 }],
            true,
          );
    };
    const meters = stripeMeters(stripe);
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-11-01T00:00:00Z');

    expect(await meters.total('cus_123', from, to)).toBe(12_500);

    const summaries = received.filter(
      (r) => r.path === '/v1/billing/meters/mtr_iris/event_summaries',
    );
    expect(summaries).toHaveLength(2);
    expect(summaries[0].method).toBe('GET');
    expect(summaries[0].query.get('customer')).toBe('cus_123');
    expect(summaries[0].query.get('start_time')).toBe('1790812800');
    expect(summaries[0].query.get('end_time')).toBe('1793491200');
    expect(summaries[1].query.get('starting_after')).toBe('sum_1');

    // The meter is looked up once per gateway, not once per customer.
    await meters.total('cus_456', from, to);
    expect(received.filter((r) => r.path === '/v1/billing/meters')).toHaveLength(1);
  });

  it('says which meter is missing when the account has none with the event name', async () => {
    answer = () =>
      list([{ id: 'mtr_other', object: 'billing.meter', event_name: 'something_else' }]);

    await expect(
      stripeMeters(stripe).total('cus_123', new Date(0), new Date(60_000)),
    ).rejects.toThrow(`No active Stripe meter with the event name ${METER_EVENT_NAME}`);
  });
});

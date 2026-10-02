/**
 * The SDK clients' env fallbacks, against the real SDKs (#258).
 *
 * IRIS passes `authToken: null` (Anthropic) and `organization`/`project: null`
 * (OpenAI) so the process's ANTHROPIC_AUTH_TOKEN / OPENAI_ORG_ID /
 * OPENAI_PROJECT_ID never ride along on a tenant's request. Whether an explicit
 * `null` pins depends on how each SDK resolves the option (`=== undefined` and a
 * destructuring default do; `??` would not). This pins that behaviour, so an SDK
 * upgrade that changes it fails here instead of leaking the operator's credential.
 */

import { OpenAI } from 'openai';
import { Anthropic } from '@anthropic-ai/sdk';

const ENV = {
  OPENAI_ORG_ID: 'org-OPERATOR',
  OPENAI_PROJECT_ID: 'proj-OPERATOR',
  ANTHROPIC_AUTH_TOKEN: 'tok-OPERATOR',
};

beforeEach(() => Object.assign(process.env, ENV));
afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
});

it('an explicit null keeps the process values out', () => {
  const openai = new OpenAI({ apiKey: 'sk-tenant', organization: null, project: null });
  expect([openai.organization, openai.project]).toEqual([null, null]);
  const anthropic = new Anthropic({ apiKey: 'sk-ant-tenant', authToken: null });
  expect(anthropic.authToken).toBeNull();
});

it('(control) leaving them out would send the operator values', () => {
  expect(new OpenAI({ apiKey: 'sk-tenant' }).organization).toBe('org-OPERATOR');
  expect(new Anthropic({ apiKey: 'sk-ant-tenant' }).authToken).toBe('tok-OPERATOR');
});

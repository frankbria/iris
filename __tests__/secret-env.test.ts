import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readSecretEnv } from '../src/secret-env';

describe('readSecretEnv (#273)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-secret-'));
  const file = path.join(dir, 'secret');
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads NAME, and NAME_FILE trimmed', () => {
    expect(readSecretEnv('S', { S: 'inline' })).toBe('inline');
    fs.writeFileSync(file, '  from-file\n');
    expect(readSecretEnv('S', { S_FILE: file })).toBe('from-file');
  });

  it('returns undefined when neither is set (or NAME is empty)', () => {
    expect(readSecretEnv('S', {})).toBeUndefined();
    expect(readSecretEnv('S', { S: '' })).toBeUndefined();
  });

  it('refuses both at once, an empty file and a missing file', () => {
    fs.writeFileSync(file, 'x');
    expect(() => readSecretEnv('S', { S: 'a', S_FILE: file })).toThrow(/one at a time/);
    fs.writeFileSync(file, '\n');
    expect(() => readSecretEnv('S', { S_FILE: file })).toThrow(/S_FILE .* is empty/);
    expect(() => readSecretEnv('S', { S_FILE: path.join(dir, 'missing') })).toThrow(/ENOENT/);
  });
});

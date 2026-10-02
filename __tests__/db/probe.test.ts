/**
 * probeDatabase() (#273) without a database: a refused connection must fail with a
 * message that says so and never repeats the URL it was given.
 */

import { createServer } from 'net';
import { createPostgresDb, probeDatabase } from '../../src/db/postgres';

/** A port nothing listens on. On [::1]: a closed 127.0.0.1 port hangs on WSL (#382). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '::1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('probeDatabase', () => {
  it('reports an unreachable database without echoing its URL', async () => {
    const marker = 'probe-marker-db';
    const db = createPostgresDb(`postgres://iris@[::1]:${await closedPort()}/${marker}`);
    try {
      const err = await probeDatabase(db).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message).toMatch(/^Cannot reach the database: \S/);
      expect(err?.message).not.toContain(marker);
    } finally {
      await db.destroy();
    }
  });
});

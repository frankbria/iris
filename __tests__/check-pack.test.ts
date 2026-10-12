/**
 * The pack check's rules (#320), on synthetic tarball listings. The real check runs in CI
 * (`npm run check:pack` after a build); npm's `prepare` rebuilds a clean dist before every
 * pack, so a stale file cannot reach it there to prove the rule.
 */
const { packProblems } = require('../scripts/check-pack.js') as {
  packProblems: (files: string[], pkg: object, exists: (p: string) => boolean) => string[];
};

const pkg = {
  main: 'dist/cli.js',
  bin: { iris: './dist/cli.js', 'iris-mcp': './dist/mcp/server.js' },
  files: ['dist', 'README.md', 'LICENSE'],
};
const sources = new Set(['src/cli.ts', 'src/mcp/server.ts']);
const exists = (p: string) => sources.has(p);
const good = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/cli.js',
  'dist/cli.d.ts',
  'dist/mcp/server.js',
];

it('passes a tarball of entry points and sourced build output', () => {
  expect(packProblems(good, pkg, exists)).toEqual([]);
});

it('flags build output whose source was deleted (stale dist)', () => {
  expect(packProblems([...good, 'dist/old-module.js'], pkg, exists)).toEqual([
    'no source for dist/old-module.js (stale build output?)',
  ]);
});

it('flags a missing entry point and a file outside "files"', () => {
  const files = good.filter((f) => f !== 'dist/mcp/server.js').concat('src/cli.ts');
  expect(packProblems(files, pkg, exists)).toEqual([
    'entry point not in the package: dist/mcp/server.js',
    'not in "files": src/cli.ts',
  ]);
});

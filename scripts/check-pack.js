#!/usr/bin/env node
/**
 * What `npm pack` would publish, checked before it ever is (#320): every `bin` and `main`
 * target ships, nothing ships outside the package's `files`, and every compiled file in
 * `dist/` has a source in `src/` (a stale file from deleted code fails it).
 *
 *   npm run build && node scripts/check-pack.js
 * Plain CommonJS with no dependencies, like scripts/third-party-notices.js.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Problems with a tarball listing; empty when it is fine. */
function packProblems(files, pkg, sourceExists) {
  const problems = [];
  const listed = new Set(files);
  const targets = [pkg.main, ...Object.values(pkg.bin ?? {})].map((t) => t.replace(/^\.\//, ''));
  for (const target of targets) {
    if (!listed.has(target)) problems.push(`entry point not in the package: ${target}`);
  }
  const allowed = (file) =>
    file === 'package.json' ||
    pkg.files.some((entry) => file === entry || file.startsWith(`${entry}/`));
  for (const file of files) {
    if (!allowed(file)) problems.push(`not in "files": ${file}`);
    const compiled = file.match(/^dist\/(.+)\.(?:js|d\.ts|js\.map)$/);
    if (compiled && !sourceExists(`src/${compiled[1]}.ts`)) {
      problems.push(`no source for ${file} (stale build output?)`);
    }
  }
  return problems;
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  // npm runs `prepare` (a clean build) before packing, as it will before a publish, so this
  // checks what would really ship. The stale-file rule guards that clean build.
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  const problems = packProblems(files, pkg, (p) => fs.existsSync(path.join(root, p)));
  if (problems.length) {
    console.error(`npm pack would publish a broken package:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`npm pack: ${files.length} files, entry points present, no stale build output`);
}

module.exports = { packProblems };

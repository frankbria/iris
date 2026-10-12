#!/usr/bin/env node
/**
 * Third-party notices for the image (#360): every production dependency the lockfile
 * installs, with its version, its declared license and the license text it ships.
 *
 * Run where `npm ci --omit=dev` has installed node_modules (the image's deps stage):
 *   node scripts/third-party-notices.js [root] > THIRD_PARTY_NOTICES.txt
 * Plain CommonJS with no dependencies, so it runs before anything is built.
 */
const fs = require('fs');
const path = require('path');

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.[a-z]+)?$/i;

/**
 * Production packages the lockfile lists *and* that are installed: the root lockfile also
 * carries the portal workspace's packages (#247), which the image does not install. Version
 * and license come from the installed package.json, so they describe what ships.
 */
function productionPackages(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  return Object.entries(lock.packages)
    .filter(([key, entry]) => key.startsWith('node_modules/') && !entry.dev && !entry.link)
    .flatMap(([key]) => {
      let pkg;
      try {
        pkg = JSON.parse(fs.readFileSync(path.join(root, key, 'package.json'), 'utf8'));
      } catch {
        return []; // not installed: another platform's optional package, or the portal's
      }
      const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
      return [{ dir: key, version: pkg.version, license }];
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/** The package name from its lockfile path (the last `node_modules/` segment). */
function nameOf(dir) {
  return dir.slice(dir.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

/** The license and notice files a package ships, read from disk; '' when it ships none. */
function licenseTexts(root, dir) {
  return fs
    .readdirSync(path.join(root, dir))
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => fs.readFileSync(path.join(root, dir, f), 'utf8').trim())
    .join('\n\n');
}

function notices(root) {
  const sections = productionPackages(root).map(({ dir, version, license }) => {
    const text = licenseTexts(root, dir);
    return [
      `${nameOf(dir)}@${version}`,
      `License: ${license ?? 'UNKNOWN'}`,
      text || '(no license file in the package)',
    ].join('\n');
  });
  return [
    'Third-party software in this image, from its package-lock.json (production dependencies).',
    '',
    sections.join(`\n\n${'-'.repeat(72)}\n\n`),
    '',
  ].join('\n');
}

if (require.main === module) {
  process.stdout.write(notices(path.resolve(process.argv[2] ?? '.')));
}

module.exports = { notices, productionPackages, nameOf };

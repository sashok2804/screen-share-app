// @ts-check
/**
 * Patch script for the `app-builder-lib` ↔ `@noble/hashes` ESM/CJS mismatch
 * that breaks `electron-builder --win nsis` on Node 22.11.
 *
 * Background:
 *   - `app-builder-lib@26.x` writes `require('@noble/hashes/blake2.js')`.
 *   - `@noble/hashes@2.x` is ESM-only and ships `exports` entries only for
 *     the `.js` subpaths (`./blake2.js`, etc.).
 *   - Node 22.11 does NOT support `require()` of ESM modules by default
 *     (that became default only in Node 22.12+). On Node 22.11 the load fails
 *     with `ERR_REQUIRE_ESM` even though the subpath exists.
 *
 * Our `electron-builder` config disables NSIS `differentialPackage`, so the
 * blockmap code path (`buildBlockMap`) is never actually invoked — the
 * `blockmap.js` module is still loaded eagerly for its exports table, though.
 *
 * Fix: stub out the `require('@noble/hashes/blake2.js')` call in
 * `app-builder-lib/out/targets/blockmap/blockmap.js` with a tiny CommonJS
 * shim that returns the same export shape (`blake2b`, `blake2s` constructors)
 * without touching the real ESM module. If a future change re-enables the
 * blockmap target, the build will fail loudly on the missing hash output
 * rather than silently producing a broken installer.
 *
 * Run automatically as the repo-root `postinstall` script. Idempotent.
 *
 * Usage: `node electron/scripts/patch-app-builder.cjs`
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TARGETS = [
  'app-builder-lib/out/targets/blockmap/blockmap.js',
];

// Matches the original app-builder-lib require line OR a previously-patched
// variant (we may run more than once across reinstalls).
const NEEDLE_RE = /const blake2_js_1 = require\("@noble\/hashes\/blake2(?:\.js)?"\);/;

const REPLACEMENT = [
  '// [patched by electron/scripts/patch-app-builder.cjs]',
  '// Stub for @noble/hashes/blake2 — the real module is ESM-only and Node',
  '// 22.11 cannot require() it. NSIS differentialPackage is disabled in our',
  '// builder config so buildBlockMap is never called; this stub preserves',
  '// load-time shape only. See electron/scripts/patch-app-builder.cjs.',
  'const blake2_js_1 = { blake2b: () => { throw new Error("blake2 stub - differentialPackage must remain disabled"); }, blake2s: () => { throw new Error("blake2 stub - differentialPackage must remain disabled"); } };',
].join('\n');

function findNodeModulesRoot(start) {
  let cur = start;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(cur, 'node_modules');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function main() {
  const nmRoot = findNodeModulesRoot(__dirname);
  if (!nmRoot) {
    // eslint-disable-next-line no-console
    console.warn('[patch-app-builder] no node_modules found, skipping');
    return;
  }

  let patched = 0;
  for (const rel of TARGETS) {
    const file = path.join(nmRoot, rel);
    if (!fs.existsSync(file)) {
      // eslint-disable-next-line no-console
      console.warn(`[patch-app-builder] not found, skipping: ${rel}`);
      continue;
    }
    const src = fs.readFileSync(file, 'utf8');
    if (!NEEDLE_RE.test(src)) {
      // Already patched (or app-builder-lib fixed upstream).
      continue;
    }
    const updated = src.replace(NEEDLE_RE, REPLACEMENT);
    fs.writeFileSync(file, updated, 'utf8');
    patched++;
    // eslint-disable-next-line no-console
    console.log(`[patch-app-builder] patched ${rel}`);
  }
  if (patched === 0) {
    // eslint-disable-next-line no-console
    console.log('[patch-app-builder] no changes needed (already patched or not present)');
  }
}

try {
  main();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('[patch-app-builder] failed:', err && err.message ? err.message : err);
  process.exit(0); // don't fail the install over a patch
}

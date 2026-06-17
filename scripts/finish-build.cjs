/* Post-build for the dual ESM/CJS output:
 *  1. Drop a `package.json` type-marker in each dist subdir so Node treats
 *     dist/cjs/*.js as CommonJS and dist/esm/*.js as ESM.
 *  2. Add explicit `.js` extensions to relative imports in the ESM output, so
 *     it also resolves under pure Node ESM (not only bundlers). tsc emits
 *     extensionless relative specifiers; Node ESM requires the extension.
 */
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');

fs.writeFileSync(path.join(dist, 'cjs', 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n');
fs.writeFileSync(path.join(dist, 'esm', 'package.json'), JSON.stringify({ type: 'module' }) + '\n');

// Rewrite relative import/export specifiers in the ESM output to add `.js`.
const esmDir = path.join(dist, 'esm');
const RELATIVE = /(\b(?:import|export)\b[^'"]*?\bfrom\s*['"])(\.\.?\/[^'"]*?)(['"])/g;
const DYNAMIC = /(\bimport\(\s*['"])(\.\.?\/[^'"]*?)(['"]\s*\))/g;

function addExt(spec) {
  // Only a KNOWN module extension counts as "already extensioned". A dotted
  // filename like './constants.preprod' must still get '.js' (its '.preprod' is
  // part of the name, not an extension). tsc emits a flat dir, so no bare-dir
  // specifiers to worry about.
  if (/\.(js|mjs|cjs|json)$/i.test(spec)) return spec;
  return spec + '.js';
}

function rewrite(file) {
  let src = fs.readFileSync(file, 'utf8');
  src = src
    .replace(RELATIVE, (_m, a, spec, c) => a + addExt(spec) + c)
    .replace(DYNAMIC, (_m, a, spec, c) => a + addExt(spec) + c);
  fs.writeFileSync(file, src);
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) rewrite(p);
  }
}
walk(esmDir);

console.log('finish-build: wrote type markers + fixed ESM import extensions');

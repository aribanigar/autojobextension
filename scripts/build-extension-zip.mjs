// Build the DOWNLOADABLE, obfuscated extension zip.
//
// The repo's extension/ folder stays readable source (the owner develops from
// it and can "Load unpacked" it directly — the admin exception). This script
// produces jobbot-extension.zip with the JS obfuscated so a customer who has
// the zip cannot easily read, analyse, or clone the selectors/logic.
//
// Obfuscation is deliberately CONSERVATIVE: identifier mangling + string/array
// encoding + compaction only. The semantic-risky transforms (control-flow
// flattening, self-defending, debug protection, dead-code injection, object-key
// transform, global renaming) are OFF so the agent's behaviour on LinkedIn,
// Indeed, Naukri, Naukri Gulf and Bayt is byte-for-byte equivalent to source.
//
// Usage:  node scripts/build-extension-zip.mjs
// Requires: npm --prefix .build-tools install   (javascript-obfuscator)
//           and the `zip` CLI on PATH.

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'extension');
const OUT = join(ROOT, '.build-tools', 'dist');
const OUT_EXT = join(OUT, 'extension');
const ZIP = join(ROOT, 'jobbot-extension.zip');

const require = createRequire(join(ROOT, '.build-tools', 'noop.cjs'));
const JsObf = require('javascript-obfuscator');

// The scripts users receive. content.js and linkedin_autoapply.js are IIFEs;
// background.js is the service worker; popup.js is the popup logic.
const OBFUSCATE = new Set(['content.js', 'background.js', 'popup.js', 'linkedin_autoapply.js']);

// Safe, integration-preserving obfuscation options.
const OPTS = {
  compact: true,
  simplify: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,          // never rename chrome/window/document bindings
  transformObjectKeys: false,    // API-shaped object keys must stay intact
  stringArray: true,
  stringArrayThreshold: 1,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayWrappersType: 'variable',
  splitStrings: true,
  splitStringsChunkLength: 10,
  numbersToExpressions: true,
  unicodeEscapeSequence: false,
  // risky transforms — kept OFF so runtime behaviour is unchanged
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  selfDefending: false,
  disableConsoleOutput: false,
};

function walk(dir, base = '') {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) { walk(abs, rel); continue; }
    const outAbs = join(OUT_EXT, rel);
    mkdirSync(dirname(outAbs), { recursive: true });
    if (OBFUSCATE.has(rel)) {
      const code = readFileSync(abs, 'utf8');
      const res = JsObf.obfuscate(code, OPTS).getObfuscatedCode();
      // Fail loudly if the obfuscated output is not syntactically valid.
      new Function(res); // throws on syntax error
      writeFileSync(outAbs, res);
      console.log(`  obfuscated  ${rel}  (${code.length} → ${res.length} bytes)`);
    } else {
      cpSync(abs, outAbs);
      console.log(`  copied      ${rel}`);
    }
  }
}

console.log('Building obfuscated extension zip…');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT_EXT, { recursive: true });
walk(SRC);

rmSync(ZIP, { force: true });
execFileSync('zip', ['-rq', ZIP, 'extension'], { cwd: OUT, stdio: 'inherit' });
const ver = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8')).version;
console.log(`\n✓ jobbot-extension.zip built (v${ver}) — obfuscated, source under extension/ left readable.`);

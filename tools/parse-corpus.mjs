#!/usr/bin/env node
// Runs the CG/PL parser over a corpus of known-good production code.
//
// The bar is absolute: working code that the CommuniGate Pro server itself
// runs must produce ZERO diagnostics. Every diagnostic reported here is a
// parser bug until proven otherwise - a language tool that flags correct code
// is worse than no tool, because people learn to ignore it.
//
// Usage: node tools/parse-corpus.mjs <dir> [<dir> ...]

import { readFileSync, globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { parse } = require(path.resolve(here, '../server/out/parser.js'));

const CGPL_EXT = ['.wcgp', '.wcgi', '.sppr', '.sppi', '.scgp'];

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node tools/parse-corpus.mjs <dir> [<dir> ...]');
  process.exit(1);
}

function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

let files = 0;
let clean = 0;
let totalDiags = 0;
const samples = [];
const byMessage = new Map();

for (const dir of dirs) {
  const found = globSync(CGPL_EXT.map((e) => `**/*${e}`), { cwd: dir }).map((f) => path.join(dir, f));
  for (const file of found) {
    files++;
    const text = readFileSync(file, 'utf8');
    let result;
    try {
      result = parse(text);
    } catch (err) {
      totalDiags++;
      samples.push(`${file}: PARSER THREW: ${err.stack?.split('\n')[0] ?? err}`);
      continue;
    }
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length === 0) {
      clean++;
      continue;
    }
    totalDiags += errors.length;
    for (const d of errors) {
      // Group by message shape so a systematic gap is obvious at a glance.
      const key = d.message.replace(/'[^']*'/g, "'X'");
      byMessage.set(key, (byMessage.get(key) ?? 0) + 1);
    }
    if (samples.length < 40) {
      const d = errors[0];
      const snippet = text.slice(d.start, Math.min(d.end + 60, text.length)).split('\n')[0];
      samples.push(`${file}:${lineOf(text, d.start)}: ${d.message}\n      | ${snippet.trim()}`);
    }
  }
}

console.log(`files parsed:      ${files}`);
console.log(`clean (0 errors):  ${clean}`);
console.log(`files with errors: ${files - clean}`);
console.log(`total errors:      ${totalDiags}`);

if (byMessage.size) {
  console.log('\n--- error kinds, most frequent first ---');
  for (const [msg, count] of [...byMessage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`${String(count).padStart(5)}  ${msg}`);
  }
}
if (samples.length) {
  console.log('\n--- samples ---');
  samples.forEach((s) => console.log(s));
}

process.exit(totalDiags === 0 ? 0 : 1);

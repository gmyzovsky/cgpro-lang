#!/usr/bin/env node
// Tokenizes every CG/PL script, WSSP template and data file found under a
// corpus directory, using the real oniguruma-backed
// vscode-textmate engine (the same engine VSCode uses) and reports:
//   - any tokenizer exceptions (a grammar bug that would break highlighting)
//   - lines that end up entirely unscoped (heuristic for "grammar doesn't
//     recognize this construct at all")
// tools/vendor/text.html.basic.tmLanguage.json is a vendored copy of
// VSCode's HTML grammar (github.com/microsoft/vscode, MIT, itself derived
// from textmate/html.tmbundle) - only used here so the wssp grammar's
// `text.html.basic` include resolves during standalone validation; real
// VSCode/JetBrains installs already ship an HTML grammar.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { globSync } from 'node:fs';
import oniguruma from 'vscode-oniguruma';
import textmate from 'vscode-textmate';
const { Registry, parseRawGrammar, INITIAL } = textmate;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
// Point CGPRO_CORPUS at a directory of real CG/PL and WSSP files - the
// scripts that ship with a CommuniGate Pro installation make a good corpus.
const corpusRoot = process.env.CGPRO_CORPUS ?? path.resolve(repoRoot, 'examples');

const GRAMMARS = {
  'source.cgpl': path.join(repoRoot, 'syntaxes/cgpl.tmLanguage.json'),
  'text.html.wssp': path.join(repoRoot, 'syntaxes/wssp.tmLanguage.json'),
  'source.cgpro-data': path.join(repoRoot, 'syntaxes/cgpro-data.tmLanguage.json'),
  'text.html.basic': path.join(repoRoot, 'tools/vendor/text.html.basic.tmLanguage.json'),
};

const EXT_TO_SCOPE = {
  '.wcgp': 'source.cgpl',
  '.wcgi': 'source.cgpl',
  '.sppr': 'source.cgpl',
  '.sppi': 'source.cgpl',
  '.scgp': 'source.cgpl',
  '.scgi': 'source.cgpl',
  '.wssp': 'text.html.wssp',
  '.wssi': 'text.html.wssp',
  '.data': 'source.cgpro-data',
  '.settings': 'source.cgpro-data',
};

const wasmBin = readFileSync(path.join(repoRoot, 'node_modules/vscode-oniguruma/release/onig.wasm')).buffer;
await oniguruma.loadWASM(wasmBin);

const vscodeOnigurumaLib = {
  createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
  createOnigString: (s) => new oniguruma.OnigString(s),
};

const registry = new Registry({
  onigLib: Promise.resolve(vscodeOnigurumaLib),
  loadGrammar: async (scopeName) => {
    const file = GRAMMARS[scopeName];
    if (!file) return null;
    return parseRawGrammar(readFileSync(file, 'utf8'), file);
  },
});

let filesChecked = 0;
let exceptions = 0;
let unscopedLines = 0;
let totalLines = 0;
const exceptionSamples = [];
const unscopedSamples = [];

async function checkFile(file, scopeName) {
  const grammar = await registry.loadGrammar(scopeName);
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r\n|\r|\n/);
  let ruleStack = INITIAL;
  filesChecked++;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    totalLines++;
    let result;
    try {
      result = grammar.tokenizeLine(line, ruleStack);
    } catch (err) {
      exceptions++;
      if (exceptionSamples.length < 15) exceptionSamples.push(`${file}:${i + 1}: ${err.message}`);
      continue;
    }
    ruleStack = result.ruleStack;
    if (line.trim().length === 0) continue;
    const onlyDefaultScope = result.tokens.every((t) => t.scopes.length <= 1);
    if (onlyDefaultScope) {
      unscopedLines++;
      if (unscopedSamples.length < 40) unscopedSamples.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
    }
  }
}

const patterns = Object.keys(EXT_TO_SCOPE).map((ext) => `**/*${ext}`);
const files = globSync(patterns, { cwd: corpusRoot, withFileTypes: false }).map((f) =>
  path.join(corpusRoot, f),
);

if (files.length === 0) {
  console.error(`No corpus files found under ${corpusRoot} - set CGPRO_CORPUS to a directory of CG/PL files`);
  process.exit(1);
}

for (const file of files) {
  const ext = path.extname(file);
  await checkFile(file, EXT_TO_SCOPE[ext]);
}

console.log(`checked ${filesChecked} files, ${totalLines} lines`);
console.log(`tokenizer exceptions: ${exceptions}`);
console.log(`unscoped non-blank lines: ${unscopedLines} (${((unscopedLines / totalLines) * 100).toFixed(2)}%)`);

if (exceptionSamples.length) {
  console.log('\n--- exception samples ---');
  exceptionSamples.forEach((s) => console.log(s));
}
if (unscopedSamples.length) {
  console.log('\n--- unscoped-line samples (first 40) ---');
  unscopedSamples.forEach((s) => console.log(s));
}

if (exceptions > 0) process.exit(1);

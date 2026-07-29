#!/usr/bin/env node
// Ad-hoc: dump TextMate token scopes for one line, to spot-check that
// builtin calls/keywords actually land the scopes we intend (not just
// "doesn't crash" - see validate.mjs for the corpus-wide crash/coverage
// check). Usage: node tools/dump-tokens.mjs <scopeName> '<line of code>'
import { readFileSync } from 'node:fs';
import path from 'node:path';
import oniguruma from 'vscode-oniguruma';
import textmate from 'vscode-textmate';
const { Registry, parseRawGrammar, INITIAL } = textmate;

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const GRAMMARS = {
  'source.cgpl': path.join(repoRoot, 'syntaxes/cgpl.tmLanguage.json'),
  'text.html.wssp': path.join(repoRoot, 'syntaxes/wssp.tmLanguage.json'),
  'source.cgpro-data': path.join(repoRoot, 'syntaxes/cgpro-data.tmLanguage.json'),
  'text.html.basic': path.join(repoRoot, 'tools/vendor/text.html.basic.tmLanguage.json'),
};

const wasmBin = readFileSync(path.join(repoRoot, 'node_modules/vscode-oniguruma/release/onig.wasm')).buffer;
await oniguruma.loadWASM(wasmBin);
const onigLib = Promise.resolve({
  createOnigScanner: (p) => new oniguruma.OnigScanner(p),
  createOnigString: (s) => new oniguruma.OnigString(s),
});
const registry = new Registry({
  onigLib,
  loadGrammar: async (scopeName) => {
    const file = GRAMMARS[scopeName];
    return file ? parseRawGrammar(readFileSync(file, 'utf8'), file) : null;
  },
});

const [, , scopeName, line] = process.argv;
const grammar = await registry.loadGrammar(scopeName);
const { tokens } = grammar.tokenizeLine(line, INITIAL);
for (const t of tokens) {
  console.log(`${JSON.stringify(line.slice(t.startIndex, t.endIndex)).padEnd(30)} ${t.scopes.join(' ')}`);
}

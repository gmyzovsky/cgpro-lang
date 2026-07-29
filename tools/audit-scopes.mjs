#!/usr/bin/env node
// Deeper than validate.mjs: validate.mjs only proves the tokenizer doesn't
// crash and every line got *some* scope. This one reports WHICH scope each
// identifier got across a corpus, so mis-scoping is visible - in particular:
//   - calls resolved as builtins (support.function.*) vs unknown/user-defined
//     (entity.name.function) - an unknown call that should be a builtin means
//     the docs-derived list has a gap
//   - identifiers that got no scope at all beyond the base (plain variables -
//     expected, but a keyword landing here would be a bug)
// Usage: node tools/audit-scopes.mjs <corpusDir> [scopeName]

import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import oniguruma from 'vscode-oniguruma';
import textmate from 'vscode-textmate';
const { Registry, parseRawGrammar, INITIAL } = textmate;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const GRAMMARS = {
  'source.cgpl': path.join(repoRoot, 'syntaxes/cgpl.tmLanguage.json'),
  'text.html.wssp': path.join(repoRoot, 'syntaxes/wssp.tmLanguage.json'),
  'source.cgpro-data': path.join(repoRoot, 'syntaxes/cgpro-data.tmLanguage.json'),
  'text.html.basic': path.join(repoRoot, 'tools/vendor/text.html.basic.tmLanguage.json'),
};
const EXT_TO_SCOPE = {
  '.wcgp': 'source.cgpl', '.wcgi': 'source.cgpl', '.sppr': 'source.cgpl',
  '.sppi': 'source.cgpl', '.scgp': 'source.cgpl',
  '.wssp': 'text.html.wssp', '.wssi': 'text.html.wssp',
  '.data': 'source.cgpro-data', '.settings': 'source.cgpro-data',
};

await oniguruma.loadWASM(readFileSync(path.join(repoRoot, 'node_modules/vscode-oniguruma/release/onig.wasm')).buffer);
const registry = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (p) => new oniguruma.OnigScanner(p),
    createOnigString: (s) => new oniguruma.OnigString(s),
  }),
  loadGrammar: async (scopeName) => {
    const file = GRAMMARS[scopeName];
    return file ? parseRawGrammar(readFileSync(file, 'utf8'), file) : null;
  },
});

const corpusDir = process.argv[2];
if (!corpusDir) {
  console.error('usage: node tools/audit-scopes.mjs <corpusDir> [scopeName]');
  process.exit(1);
}

const byScope = new Map(); // leaf scope -> Map(text -> count)
const record = (scope, text) => {
  if (!byScope.has(scope)) byScope.set(scope, new Map());
  const m = byScope.get(scope);
  m.set(text, (m.get(text) ?? 0) + 1);
};

const files = globSync(
  Object.keys(EXT_TO_SCOPE).map((e) => `**/*${e}`),
  { cwd: corpusDir },
).map((f) => path.join(corpusDir, f));

for (const file of files) {
  const scopeName = process.argv[3] ?? EXT_TO_SCOPE[path.extname(file)];
  const grammar = await registry.loadGrammar(scopeName);
  let ruleStack = INITIAL;
  for (const line of readFileSync(file, 'utf8').split(/\r\n|\r|\n/)) {
    const res = grammar.tokenizeLine(line, ruleStack);
    ruleStack = res.ruleStack;
    for (const t of res.tokens) {
      const text = line.slice(t.startIndex, t.endIndex).trim();
      if (!text || !/[A-Za-z_]/.test(text)) continue;
      record(t.scopes[t.scopes.length - 1], text);
    }
  }
}

const INTERESTING = [
  'entity.name.function.cgpl',
  'support.function.builtin.cgpl',
  'support.function.pbxapp.cgpl',
  'support.function.webapp.cgpl',
  'entity.name.namespace.cgpl',
];

console.log(`corpus: ${corpusDir}\nfiles: ${files.length}\n`);
for (const scope of INTERESTING) {
  const m = byScope.get(scope);
  if (!m) continue;
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`=== ${scope} (${sorted.length} distinct) ===`);
  console.log(sorted.map(([t, c]) => `${t}(${c})`).join(' '));
  console.log();
}

// Anything that is a bare identifier with only the root scope: normal for
// variables, but list the most frequent so a missed keyword stands out.
const bare = byScope.get('source.cgpl');
if (bare) {
  const sorted = [...bare.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
  console.log(`=== unscoped bare identifiers, top 60 of ${bare.size} (expected: variables) ===`);
  console.log(sorted.map(([t, c]) => `${t}(${c})`).join(' '));
}

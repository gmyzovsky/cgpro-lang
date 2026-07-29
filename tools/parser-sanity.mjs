#!/usr/bin/env node
// Guards against the failure mode that a corpus run cannot see: a parser so
// permissive it reports zero errors because it accepts anything. Checks that
// (a) real code yields a populated AST, and (b) genuinely broken code is
// still rejected.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, globSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { parse } = require(path.resolve(here, '../server/out/parser.js'));

let failures = 0;
const ok = (label) => console.log(`  ok   ${label}`);
const bad = (label, detail) => {
  console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
  failures++;
};

// --- (a) real code must produce a populated AST -----------------------------

console.log('AST is populated on real code:');
// Any directory of real CG/PL will do; CGPRO_CORPUS may list several,
// separated by the platform path separator.
const corpora = (process.env.CGPRO_CORPUS ?? path.resolve(here, '../examples')).split(path.delimiter);
let sections = 0;
let statements = 0;
let files = 0;

const countStatements = (list) => {
  let n = 0;
  for (const s of list ?? []) {
    n++;
    if (s.kind === 'IfStatement') {
      for (const c of s.clauses) n += countStatements(c.body);
      n += countStatements(s.alternate);
    } else if (s.kind === 'LoopStatement') {
      n += countStatements(s.body);
      for (const e of s.exitIfs) n += countStatements(e.body);
    }
  }
  return n;
};

for (const dir of corpora) {
  const found = globSync(['**/*.wcgp', '**/*.wcgi', '**/*.sppr', '**/*.sppi', '**/*.scgp'], { cwd: dir });
  for (const rel of found) {
    files++;
    const { program } = parse(readFileSync(path.join(dir, rel), 'utf8'));
    for (const item of program.body) {
      if (item.kind === 'CodeSection') {
        sections++;
        statements += countStatements(item.body);
      }
    }
  }
}
console.log(`  ${files} files -> ${sections} code sections, ${statements} statements`);
// The thresholds only mean something against a substantial corpus. With just
// the bundled examples there is nothing to conclude, so say so instead of
// failing a check the caller never had the inputs to pass.
if (files >= 20) {
  if (sections > 500) ok('code sections found'); else bad('code sections found', `only ${sections}`);
  if (statements > 10000) ok('statements found'); else bad('statements found', `only ${statements}`);
} else {
  console.log('  (set CGPRO_CORPUS to a real corpus to make this check meaningful)');
  if (sections > 0) ok('parses the bundled examples'); else bad('parses the bundled examples');
}

// --- (b) broken code must still be rejected ---------------------------------

console.log('\nBroken code is rejected:');
const mustFail = {
  'unclosed section': 'entry main is\n  x = 1;\n',
  'missing then/brace': 'entry main is\n  if x\n    y = 1;\n  end if;\nend entry;\n',
  'unterminated string': 'entry main is\n  x = "abc;\nend entry;\n',
  'unclosed paren': 'entry main is\n  x = foo(1, 2;\nend entry;\n',
  'garbage token': 'entry main is\n  x = ` ;\nend entry;\n',
  'missing expression': 'entry main is\n  x = ;\nend entry;\n',
  'unclosed block comment': 'entry main is\n  /* never closed\n  x = 1;\nend entry;\n',
  'stray closing brace': 'entry main is\n  x = 1;\n}\nend entry;\n',
};
for (const [label, src] of Object.entries(mustFail)) {
  const errs = parse(src).diagnostics.filter((d) => d.severity === 'error');
  if (errs.length > 0) ok(`${label} (${errs.length} error${errs.length > 1 ? 's' : ''})`);
  else bad(label, 'no error reported');
}

// --- (c) valid code in both dialects must be accepted -----------------------

console.log('\nValid code is accepted:');
const mustPass = {
  'is/end dialect': `entry main is
  var i = 0;
  if i < 10 then i = i + 2; elif i < 20 then i = i - 3; else i = i * 4; end if;
  while i < 10 loop i += 1; end loop;
  for j = 5 while j < 10 by j += 2 loop myProc(j); end loop;
  loop myWord += "a"; exitif Length(myWord) >= 20; myWord += "b"; end loop;
end entry;`,
  'brace dialect': `entry main {
  var i = 0;
  if (i < 10) { i += 2; } elif (i < 20) { i -= 3; } else { i *= 4; }
  while (true) { i += 1; exitif (i > 5); i += 2; }
  for (var k = 0; k <= 10; k += 1) { i *= k; }
  for (;;) { exitif !IsDictionary(d); }
}`,
  'declarations': `var taskVar;
const c1 = 1234, c2 = "test", cFlag = true;
procedure mod::helper(a, b) external;
function Factorial(x) forward;
function Factorial(x) { return x <= 1 ? 1 : Factorial(x - 1) * x; }`,
  'expressions': `entry main is
  x = a.b.c[0].(key).method(1, 2) + -3 * (4 % 5);
  y = p and then q or else r xor s;
  z = obj.mod::qualifiedMethod("v");
  w = "adjacent" "strings" "concatenate";
  t = spawn worker(1);
  v = not null;
end entry;`,
};
for (const [label, src] of Object.entries(mustPass)) {
  const errs = parse(src).diagnostics.filter((d) => d.severity === 'error');
  if (errs.length === 0) ok(label);
  else bad(label, errs.map((e) => e.message).join('; '));
}

console.log(failures === 0 ? '\nall parser sanity checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);

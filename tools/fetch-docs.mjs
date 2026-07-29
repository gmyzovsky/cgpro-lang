#!/usr/bin/env node
// Downloads the CommuniGate Pro developer documentation pages that
// extract-builtins.mjs reads, so regenerating the built-in database needs
// nothing but a network connection.
//
// Usage: node tools/fetch-docs.mjs [targetDir]   (default: ./docs)

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? process.env.CGPRO_DOCS_ROOT ?? path.resolve(here, '../docs');

const BASE = 'https://doc.communigatepro.ru/development/';
const PAGES = ['CGPL', 'PBXApp', 'WebApp', 'WSSP', 'Data'];

mkdirSync(target, { recursive: true });

let failures = 0;
for (const page of PAGES) {
  const url = `${BASE}${page}.html`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`  FAIL ${page}: HTTP ${response.status}`);
      failures++;
      continue;
    }
    const body = await response.text();
    const file = path.join(target, `${page}.html`);
    writeFileSync(file, body);
    console.log(`  ok   ${page}.html (${(body.length / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.error(`  FAIL ${page}: ${err.message}`);
    failures++;
  }
}

console.log(
  failures === 0
    ? `\nfetched ${PAGES.length} pages into ${target}\nnext: node tools/extract-builtins.mjs && node tools/build-grammars.mjs`
    : `\n${failures} page(s) could not be fetched`,
);
process.exit(failures === 0 ? 0 : 1);

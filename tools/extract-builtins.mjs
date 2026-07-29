#!/usr/bin/env node
// Extracts built-in function/procedure names and signatures from the
// CommuniGate Pro developer documentation, so the TextMate grammars and the
// language server never hand-maintain a separate copy of the function list.
//
// Input is the Markdown form of the pages published at
// https://doc.communigatepro.ru/development/ - point CGPRO_DOCS_ROOT at a
// directory holding CGPL.md, PBXApp.md, WebApp.md and WSSP.md.
//
// Two heading shapes are used across those documents:
//   CGPL.md              #### `Name(args)` {#Anchor}
//   PBXApp/WebApp/WSSP.md - `Name(args)`        (top-level bullet, column 0)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = process.env.CGPRO_DOCS_ROOT ?? path.resolve(here, '../docs');

// name may be a plain identifier, or WSSP's `<!--%%IF expression-->` style,
// or a comma-free signature list on separate lines (ProcCall style).
const NAME_RE = String.raw`(?:<!--%%)?[A-Za-z_][A-Za-z0-9_]*`;

// Turns the markdown prose that documents one builtin into a short plain-text
// summary suitable for an LSP hover popup. Keeps it to the first few
// sentences: hovers are read at a glance, and the full text is a click away
// in the docs.
function summarize(body) {
  const text = body
    .replace(/```[\s\S]*?```/g, '') // drop fenced examples
    .replace(/^\s*[|:-]{2,}.*$/gm, '') // drop table rules
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> their text
    .replace(/_([^_]+)_/g, '$1')
    .trim();
  if (!text) return '';
  const sentences = text.match(/[^.]+\.(?:\s|$)/g);
  if (!sentences) return text.slice(0, 400);
  let out = '';
  for (const s of sentences) {
    if (out.length + s.length > 400) break;
    out += s;
  }
  return (out || sentences[0]).trim();
}

/** Splits `Name(a, b)` into its parameter names, or [] when there are none. */
function paramsOf(signature) {
  const open = signature.indexOf('(');
  if (open < 0) return [];
  const close = signature.lastIndexOf(')');
  const inner = signature.slice(open + 1, close < 0 ? undefined : close).trim();
  if (!inner) return [];
  return inner.split(',').map((p) => p.trim()).filter(Boolean);
}

// Collects every match of `re` plus the text between it and the next match
// (or end of document). Done by slicing on match offsets rather than with a
// terminating lookahead: JavaScript has no \Z, and using it silently drops
// the last entry in the file, which is exactly the kind of quiet gap this
// whole generate-from-docs approach exists to avoid.
function matchesWithBodies(text, re) {
  const found = [];
  let m;
  while ((m = re.exec(text))) {
    found.push({ groups: m, headEnd: m.index + m[0].length });
  }
  return found.map((entry, i) => ({
    groups: entry.groups,
    body: text.slice(entry.headEnd, i + 1 < found.length ? found[i + 1].groups.index : text.length),
  }));
}

function extractHeadingStyle(text) {
  // #### `Name(args)` {#Anchor}   followed by the prose describing it
  const re = /^#{2,5}[ \t]+`([^`]+)`(?:[ \t]*\{#([^}]+)\})?[^\n]*/gm;
  const out = [];
  for (const { groups, body } of matchesWithBodies(text, re)) {
    const sig = groups[1].trim();
    const nameMatch = sig.match(new RegExp(`^(${NAME_RE})`));
    if (!nameMatch) continue;
    out.push({
      name: nameMatch[1],
      signature: sig,
      anchor: groups[2] ?? null,
      params: paramsOf(sig),
      doc: summarize(body),
    });
  }
  return out;
}

function extractBulletStyle(text) {
  // Top-level (column 0) bullet: - `Name(args)`
  // PBXApp/WebApp/WSSP.md use this SAME bullet convention for two unrelated
  // things: actual function/procedure calls (`AcceptCall()`) and bare
  // dataset-key names documented inline (`charset`, `attendees`). Only the
  // former are callable identifiers a grammar should highlight as
  // support.function - keep bullets whose signature is an actual call,
  // i.e. `Name(`.
  // The indented prose under the bullet is the description.
  const re = /^- `([^`]+)`[ \t]*$/gm;
  const functions = [];
  for (const { groups, body } of matchesWithBodies(text, re)) {
    const sig = groups[1].trim();
    if (sig.startsWith('<!--%%')) continue; // WSSP structural tag, handled separately
    const callMatch = sig.match(new RegExp(`^(${NAME_RE})\\(`));
    if (!callMatch) continue; // bare dataset-key bullet, not a callable
    functions.push({
      name: callMatch[1],
      signature: sig,
      anchor: null,
      params: paramsOf(sig),
      // A bullet's body runs to the next bullet, which may be in a different
      // section; cut at the next heading so a description can't bleed across.
      doc: summarize(body.split(/^#{1,5}[ \t]/m)[0]),
    });
  }
  return functions;
}

function extractWsspStructuralTags(text) {
  // WSSP structural elements (`<!--%%IF expr-->` ... `<!--%%ENDIF-->`) are
  // documented inline, not always as their own bullet (e.g. ELIF/ENDIF are
  // just mentioned in prose) - so scan the whole doc for the tag spelling
  // rather than relying on bullet position.
  const re = /`<!--%%([A-Z]+)/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push({ name: m[1], signature: `<!--%%${m[1]}-->`, anchor: null });
  return out;
}

function dedupe(entries) {
  const byName = new Map();
  for (const e of entries) {
    if (!byName.has(e.name)) {
      byName.set(e.name, {
        name: e.name,
        signatures: [],
        params: e.params ?? [],
        doc: e.doc ?? '',
        anchor: e.anchor ?? null,
      });
    }
    const bucket = byName.get(e.name);
    if (!bucket.signatures.includes(e.signature)) bucket.signatures.push(e.signature);
    // Overloads are documented as several headings; keep the longest
    // parameter list and the first non-empty description.
    if ((e.params?.length ?? 0) > bucket.params.length) bucket.params = e.params;
    if (!bucket.doc && e.doc) bucket.doc = e.doc;
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function loadDoc(file) {
  const full = path.join(docsRoot, file);
  if (!existsSync(full)) {
    console.error(
      `Cannot find ${file} under ${docsRoot}.\n` +
        'Set CGPRO_DOCS_ROOT to a directory holding the Markdown form of the pages at\n' +
        'https://doc.communigatepro.ru/development/ (CGPL.md, PBXApp.md, WebApp.md, WSSP.md).',
    );
    process.exit(1);
  }
  return readFileSync(full, 'utf8');
}

const wsspDoc = loadDoc('WSSP.md');

const categories = {
  cgpl: dedupe(extractHeadingStyle(loadDoc('CGPL.md'))),
  pbxapp: dedupe(extractBulletStyle(loadDoc('PBXApp.md'))),
  webapp: dedupe(extractBulletStyle(loadDoc('WebApp.md'))),
  wssp: dedupe(extractBulletStyle(wsspDoc)),
  wsspStructural: dedupe(extractWsspStructuralTags(wsspDoc)),
};

// Sanity: fail loudly instead of silently shipping an empty/half grammar.
const MIN_EXPECTED = { cgpl: 150, pbxapp: 20, webapp: 5, wssp: 30, wsspStructural: 8 };
for (const [cat, min] of Object.entries(MIN_EXPECTED)) {
  if (categories[cat].length < min) {
    throw new Error(
      `extract-builtins: ${cat} yielded only ${categories[cat].length} entries ` +
        `(expected >= ${min}) - doc heading pattern probably changed, check ${cat} source doc`,
    );
  }
}

// Merge in tools/builtins-supplement.json - a curated table of built-ins the
// published documentation does not describe, plus the argument counts the
// prose never states. It exists because real CG/PL calls plenty of functions
// that no document mentions (TextToObject, StartPBXTask and friends); without
// it those show up as unknown calls in perfectly good code. The two inputs
// are complementary: the supplement supplies existence and arity, the
// documentation supplies the descriptions.
const supplementFile = path.resolve(here, 'builtins-supplement.json');
let merged = { fromDocsOnly: 0, fromSupplementOnly: 0, both: 0 };
if (existsSync(supplementFile)) {
  const supplement = JSON.parse(readFileSync(supplementFile, 'utf8'));
  for (const [env, entries] of Object.entries(supplement)) {
    // Environments outside the three the grammars know about fold into the
    // core list rather than being dropped.
    const target = ['cgpl', 'pbxapp', 'webapp'].includes(env) ? env : 'cgpl';
    const bucket = categories[target] ?? (categories[target] = []);
    const byLower = new Map(bucket.map((e) => [e.name.toLowerCase(), e]));
    for (const e of entries) {
      const existing = byLower.get(e.name.toLowerCase());
      if (existing) {
        existing.minArgs = e.minArgs;
        existing.maxArgs = e.maxArgs;
        existing.isFunction = e.isFunction;
        existing.source = 'both';
        merged.both++;
      } else {
        bucket.push({
          name: e.name,
          signatures: [`${e.name}(${e.minArgs === 0 && e.maxArgs === 0 ? '' : '...'})`],
          params: [],
          doc: '',
          anchor: null,
          minArgs: e.minArgs,
          maxArgs: e.maxArgs,
          isFunction: e.isFunction,
          source: 'supplement',
        });
        merged.fromSupplementOnly++;
      }
    }
    bucket.sort((a, b) => a.name.localeCompare(b.name));
  }
  for (const bucket of Object.values(categories)) {
    for (const e of bucket) {
      if (!e.source) {
        e.source = 'docs';
        merged.fromDocsOnly++;
      }
    }
  }
  console.log(
    `merged with the supplement: ${merged.both} documented and supplemented, ` +
      `${merged.fromSupplementOnly} undocumented, ` +
      `${merged.fromDocsOnly} documented only`,
  );
} else {
  console.log('note: tools/builtins-supplement.json not found - built-ins are docs-derived only');
}

const outFile = path.resolve(here, 'builtins.json');
writeFileSync(outFile, JSON.stringify(categories, null, 2) + '\n');

for (const [cat, entries] of Object.entries(categories)) {
  console.log(`${cat}: ${entries.length} builtins`);
}
console.log(`wrote ${outFile}`);

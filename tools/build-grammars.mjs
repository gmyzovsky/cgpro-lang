#!/usr/bin/env node
// Builds syntaxes/*.tmLanguage.json from the hand-authored grammar structure
// below plus the function-name lists extracted from the documentation
// (tools/builtins.json, produced by extract-builtins.mjs). Function lists
// are the only doc-derived part; the grammar shape itself is authored here
// from CGPL.md's Formal Syntax section and Data.md's Formal Syntax Rules.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../syntaxes');
const builtins = JSON.parse(readFileSync(path.join(here, 'builtins.json'), 'utf8'));

function names(list) {
  return list.map((e) => e.name);
}

// Longest-first so a prefix name can never pre-empt matching before we even
// try the longer alternative in engines that don't backtrack across \b.
function wordAlt(list) {
  const sorted = [...new Set(list)].sort((a, b) => b.length - a.length);
  return `\\b(?:${sorted.join('|')})\\b`;
}

// ---------------------------------------------------------------------------
// CG/PL
// ---------------------------------------------------------------------------

const CGPL_CONTROL_KEYWORDS = [
  'if', 'then', 'elif', 'else', 'end', 'loop', 'while', 'for', 'by',
  'exitif', 'return', 'stop', 'spawn',
];
// var/const are handled by the dedicated varConstDecl pattern below, and
// entry/procedure/function by codeSectionDecl (so the declared name can be
// captured too). entry/procedure/function are ALSO listed here as plain
// keywords, because codeSectionDecl only matches a declaration - it leaves
// the optional trailing keyword of `end procedure;` / `end entry;`
// unhighlighted. codeSectionDecl is matched first, so declarations still win.
const CGPL_STORAGE_KEYWORDS = ['forward', 'external', 'is', 'entry', 'procedure', 'function'];
const CGPL_WORD_OPERATORS = ['and then', 'or else', 'and', 'or', 'xor', 'not'];

const cgplExpressionPatterns = [
  { include: '#comments' },
  { include: '#strings' },
  { include: '#numbers' },
  { include: '#constants' },
  { include: '#wordOperators' },
  { include: '#qualifiedName' },
  { include: '#builtinCalls' },
  { include: '#genericCall' },
  { include: '#operators' },
  { include: '#punctuation' },
];

const cgpl = {
  $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
  name: 'CommuniGate Pro CG/PL',
  scopeName: 'source.cgpl',
  fileTypes: ['wcgp', 'wcgi', 'sppr', 'sppi', 'scgp'],
  patterns: [
    { include: '#comments' },
    { include: '#strings' },
    { include: '#numbers' },
    { include: '#constants' },
    { include: '#codeSectionDecl' },
    { include: '#varConstDecl' },
    { include: '#controlKeywords' },
    { include: '#storageKeywords' },
    { include: '#wordOperators' },
    { include: '#qualifiedName' },
    { include: '#builtinCalls' },
    { include: '#genericCall' },
    { include: '#operators' },
    { include: '#punctuation' },
  ],
  repository: {
    comments: {
      patterns: [
        { name: 'comment.block.cgpl', begin: '/\\*', end: '\\*/' },
        { name: 'comment.line.double-slash.cgpl', begin: '//', end: '$' },
      ],
    },
    strings: {
      patterns: [
        {
          name: 'string.quoted.double.cgpl',
          begin: '"',
          end: '"',
          patterns: [
            { name: 'constant.character.escape.cgpl', match: '\\\\(?:[rnetf\\\\"]|[0-9]{3}|u\'[0-9A-Fa-f]+\')' },
          ],
        },
      ],
    },
    numbers: {
      patterns: [{ name: 'constant.numeric.cgpl', match: '\\b[0-9]+(?:\\.[0-9]+)?\\b|\\B\\.[0-9]+\\b' }],
    },
    constants: {
      patterns: [{ name: 'constant.language.cgpl', match: '\\b(?i:true|false|null)\\b' }],
    },
    controlKeywords: {
      patterns: [{ name: 'keyword.control.cgpl', match: `(?i:${wordAlt(CGPL_CONTROL_KEYWORDS)})` }],
    },
    storageKeywords: {
      patterns: [{ name: 'keyword.other.cgpl', match: `(?i:${wordAlt(CGPL_STORAGE_KEYWORDS)})` }],
    },
    wordOperators: {
      patterns: [
        {
          name: 'keyword.operator.word.cgpl',
          match: `(?i:\\b(?:${['and\\s+then', 'or\\s+else', ...CGPL_WORD_OPERATORS.filter((w) => !w.includes(' '))].join('|')})\\b)`,
        },
      ],
    },
    qualifiedName: {
      patterns: [
        {
          match: '\\b([A-Za-z_][A-Za-z0-9_]*)(::)([A-Za-z_][A-Za-z0-9_]*)\\b',
          captures: {
            1: { name: 'entity.name.namespace.cgpl' },
            2: { name: 'punctuation.accessor.cgpl' },
            3: { name: 'entity.name.function.cgpl' },
          },
        },
      ],
    },
    builtinCalls: {
      // CGPL.md #Lexemes: "All names are case-insensitive." Real-world code
      // leans on this heavily - e.g. SysLog is written Syslog/syslog, Void as
      // void, Length as length - so these MUST be matched case-insensitively
      // or the most common calls in a codebase get scoped as user functions.
      patterns: [
        { name: 'support.function.builtin.cgpl', match: `(?i:${wordAlt(names(builtins.cgpl))})(?=\\s*\\()` },
        { name: 'support.function.pbxapp.cgpl', match: `(?i:${wordAlt(names(builtins.pbxapp))})(?=\\s*\\()` },
        { name: 'support.function.webapp.cgpl', match: `(?i:${wordAlt(names(builtins.webapp))})(?=\\s*\\()` },
      ],
    },
    genericCall: {
      patterns: [{ name: 'entity.name.function.cgpl', match: '\\b[A-Za-z_][A-Za-z0-9_]*(?=\\s*\\()' }],
    },
    codeSectionDecl: {
      patterns: [
        {
          comment: 'entry NAME',
          match: '\\b(?i:entry)\\b\\s+([A-Za-z_][A-Za-z0-9_]*)\\b',
          captures: { 0: { name: 'keyword.other.cgpl' }, 1: { name: 'entity.name.function.cgpl' } },
        },
        {
          comment: 'procedure/function NAME(params)',
          match:
            '\\b(?i:procedure|function)\\b\\s+((?:[A-Za-z_][A-Za-z0-9_]*::)?[A-Za-z_][A-Za-z0-9_]*)\\s*(\\()([^)]*)(\\))',
          captures: {
            0: { name: 'keyword.other.cgpl' },
            1: { name: 'entity.name.function.cgpl' },
            2: { name: 'punctuation.definition.parameters.begin.cgpl' },
            3: { patterns: [{ include: '#paramList' }] },
            4: { name: 'punctuation.definition.parameters.end.cgpl' },
          },
        },
      ],
    },
    paramList: {
      patterns: [
        { name: 'variable.parameter.cgpl', match: '[A-Za-z_][A-Za-z0-9_]*' },
        { name: 'punctuation.separator.comma.cgpl', match: ',' },
      ],
    },
    varConstDecl: {
      patterns: [
        {
          comment: 'var/const declaration list - names before any initializer are declarations',
          begin: '\\b(?i:var|const)\\b',
          beginCaptures: { 0: { name: 'keyword.other.declaration.cgpl' } },
          end: ';',
          endCaptures: { 0: { name: 'punctuation.terminator.statement.cgpl' } },
          patterns: [
            { name: 'variable.other.cgpl', match: '[A-Za-z_][A-Za-z0-9_]*(?=\\s*(?:[,=]|;))' },
            ...cgplExpressionPatterns,
          ],
        },
      ],
    },
    operators: {
      patterns: [
        {
          name: 'keyword.operator.cgpl',
          // ^ is the symbol form of `xor` (CGPL.md #Exprs). It is missing from
          // that doc's own list of signs in #Lexemes, but documented in the
          // operator descriptions - trust the descriptions.
          match: '\\+=|-=|\\*=|/=|%=|\\|=|&=|==|!=|<=|>=|&&|\\|\\||[-+*/%=<>!&|^?:]',
        },
      ],
    },
    punctuation: {
      patterns: [
        { name: 'punctuation.terminator.statement.cgpl', match: ';' },
        { name: 'punctuation.separator.comma.cgpl', match: ',' },
        { name: 'punctuation.accessor.cgpl', match: '\\.' },
        { name: 'punctuation.section.parens.cgpl', match: '[()]' },
        { name: 'punctuation.section.braces.cgpl', match: '[{}]' },
        { name: 'punctuation.section.brackets.cgpl', match: '[\\[\\]]' },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// CGPro Data format (.data, .settings)
// ---------------------------------------------------------------------------

const cgproData = {
  $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
  name: 'CommuniGate Pro Data',
  scopeName: 'source.cgpro-data',
  fileTypes: ['data', 'settings'],
  patterns: [
    { include: '#comments' },
    { include: '#dictKey' },
    { include: '#values' },
    { include: '#punctuation' },
  ],
  repository: {
    comments: {
      patterns: [
        { name: 'comment.block.cgpro-data', begin: '/\\*', end: '\\*/' },
        { name: 'comment.line.double-slash.cgpro-data', begin: '//', end: '$' },
      ],
    },
    dictKey: {
      patterns: [
        {
          comment: 'dictionary key before the = sign',
          match: '("(?:[^"\\\\]|\\\\.)*"|[A-Za-z0-9@_.-]+)\\s*(=)',
          captures: { 1: { name: 'entity.name.tag.key.cgpro-data' }, 2: { name: 'keyword.operator.cgpro-data' } },
        },
      ],
    },
    values: {
      patterns: [
        { name: 'constant.language.null.cgpro-data', match: '#NULL#' },
        { name: 'constant.other.timestamp.cgpro-data', match: '#TPAST|#TFUTURE|#T[0-9]{2}-[0-9]{2}-[0-9]{4}(?:_[0-9]{2}:[0-9]{2}:[0-9]{2})?' },
        { name: 'constant.other.ipaddress.cgpro-data', match: '#I\\[[0-9A-Fa-f:.]*\\](?::[0-9]+)?' },
        { name: 'constant.numeric.cgpro-data', match: '#-?(?:0x[0-9A-Fa-f]+|0o[0-7]+|0b[01]+|[0-9]+)' },
        { name: 'string.unquoted.datablock.cgpro-data', match: '\\[[A-Za-z0-9+/=\\s]*\\]' },
        {
          name: 'string.quoted.double.cgpro-data',
          begin: '"',
          end: '"',
          patterns: [
            { name: 'constant.character.escape.cgpro-data', match: '\\\\(?:[rnetf\\\\"]|[0-9]{3}|u\'[0-9A-Fa-f]+\')' },
          ],
        },
        { name: 'string.unquoted.atom.cgpro-data', match: '[A-Za-z][A-Za-z0-9@_.-]*' },
      ],
    },
    punctuation: {
      patterns: [
        { name: 'punctuation.terminator.statement.cgpro-data', match: ';' },
        { name: 'punctuation.separator.comma.cgpro-data', match: ',' },
        { name: 'punctuation.section.braces.cgpro-data', match: '[{}]' },
        { name: 'punctuation.section.parens.cgpro-data', match: '[()]' },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// WSSP
// ---------------------------------------------------------------------------

// WSSP's own expression language (WSSP.md #Exprs) is a subset of CG/PL's:
// data/scanner/keyed/indexed elements, function calls, boolean |,&,^,
// string constants - no CG/PL statements. Kept as its own small repository
// so the wssp grammar is self-contained (no cross-file include needed).
const wsspExprPatterns = [
  { include: '#wsspStrings' },
  { include: '#wsspNumbers' },
  {
    // WSSP.md #Exprs: "Function names are case-insensitive."
    name: 'support.function.wssp',
    match: `(?i:${wordAlt(names(builtins.wssp))})(?=\\s*\\()`,
  },
  { name: 'variable.other.scanner.wssp', match: '\\b[A-Za-z_][A-Za-z0-9_]*(?=\\[\\])' },
  {
    comment: 'word separators inside function args: EQUALS(a AND b), ISINDEX(x IN s), TRANSLATE(x USING d)',
    name: 'keyword.operator.word.wssp',
    match: '\\b(?i:AND|IN|USING)\\b',
  },
  { name: 'entity.name.function.wssp', match: '\\b[A-Za-z_][A-Za-z0-9_]*(?=\\s*\\()' },
  { name: 'keyword.operator.wssp', match: '[|&^!]' },
  { name: 'variable.other.readwrite.wssp', match: '\\b[A-Za-z_][A-Za-z0-9_]*\\b' },
  { name: 'punctuation.accessor.wssp', match: '\\.' },
  { name: 'punctuation.section.brackets.wssp', match: '[\\[\\]]' },
  { name: 'punctuation.section.parens.wssp', match: '[()]' },
  { name: 'punctuation.separator.wssp', match: ',' },
];

const wssp = {
  $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
  name: 'CommuniGate Pro WSSP',
  scopeName: 'text.html.wssp',
  fileTypes: ['wssp', 'wssi'],
  patterns: [
    { include: '#structural' },
    { include: '#textElement' },
    { include: 'text.html.basic' },
  ],
  repository: {
    wsspStrings: {
      patterns: [
        {
          name: 'string.quoted.double.wssp',
          begin: '"',
          end: '"',
          patterns: [{ name: 'constant.character.escape.wssp', match: '\\\\.' }],
        },
      ],
    },
    wsspNumbers: {
      patterns: [{ name: 'constant.numeric.wssp', match: '\\b[0-9]+(?:\\.[0-9]+)?\\b' }],
    },
    textElement: {
      comment: '%%[HTML:|URL:]expression%% text substitution',
      name: 'meta.embedded.line.wssp',
      begin: '%%',
      end: '%%',
      beginCaptures: { 0: { name: 'punctuation.definition.tag.wssp' } },
      endCaptures: { 0: { name: 'punctuation.definition.tag.wssp' } },
      patterns: [
        { name: 'keyword.other.encoder.wssp', match: '\\b(?i:HTML|URL):' },
        ...wsspExprPatterns,
      ],
    },
    structural: {
      comment: '<!--%%IF ...--> ... <!--%%ENDIF--> structural elements',
      name: 'meta.embedded.block.wssp',
      begin: '<!--%%',
      end: '-->',
      beginCaptures: { 0: { name: 'punctuation.definition.tag.begin.wssp' } },
      endCaptures: { 0: { name: 'punctuation.definition.tag.end.wssp' } },
      patterns: [
        { name: 'keyword.control.wssp', match: `(?i:${wordAlt(names(builtins.wsspStructural))})` },
        ...wsspExprPatterns,
      ],
    },
  },
};

for (const [file, grammar] of Object.entries({
  'cgpl.tmLanguage.json': cgpl,
  'wssp.tmLanguage.json': wssp,
  'cgpro-data.tmLanguage.json': cgproData,
})) {
  writeFileSync(path.join(outDir, file), JSON.stringify(grammar, null, 2) + '\n');
  console.log(`wrote syntaxes/${file}`);
}

// The CG/PL language server.
//
// Everything it knows comes from three places: the parser (syntax), the
// analyzer (symbols in the open file), and the generated built-in database.
// Nothing here reaches across files except go-to-definition on an
// external-declaration, which resolves the module by filename.

import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  InitializeResult,
  Diagnostic,
  DiagnosticSeverity,
  SymbolKind,
  DocumentSymbol,
  CompletionItem,
  CompletionItemKind,
  MarkupKind,
  Location,
  Range,
  SignatureInformation,
  SignatureHelp,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from './uri';
import * as fs from 'fs';
import * as path from 'path';

import { parse } from './parser';
import { analyze, unresolvedCalls, arityProblems, AnalysisResult, SymbolInfo } from './analyzer';
import { allBuiltins, lookupBuiltin, builtinHover, Builtin } from './builtins';
import { tokenize, TokenKind } from './lexer';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

interface Settings {
  /** Report calls that resolve to nothing known. */
  reportUnknownCalls: boolean;
  /** Report built-in calls with an impossible argument count. */
  reportArity: boolean;
  maxProblems: number;
}

const DEFAULT_SETTINGS: Settings = {
  reportUnknownCalls: true,
  reportArity: true,
  maxProblems: 200,
};

let settings: Settings = DEFAULT_SETTINGS;

/** Cache of the last analysis per document, keyed by URI and version. */
const analyses = new Map<string, { version: number; analysis: AnalysisResult; text: string }>();

function analysisFor(doc: TextDocument): AnalysisResult {
  const cached = analyses.get(doc.uri);
  if (cached && cached.version === doc.version) return cached.analysis;
  const text = doc.getText();
  const analysis = analyze(parse(text).program);
  analyses.set(doc.uri, { version: doc.version, analysis, text });
  return analysis;
}

function rangeOf(doc: TextDocument, start: number, end: number): Range {
  return { start: doc.positionAt(start), end: doc.positionAt(end) };
}

// --- diagnostics ------------------------------------------------------------

function validate(doc: TextDocument): void {
  const text = doc.getText();
  const { diagnostics: parseDiagnostics } = parse(text);
  const analysis = analysisFor(doc);
  const out: Diagnostic[] = [];

  for (const d of parseDiagnostics) {
    out.push({
      severity: d.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
      range: rangeOf(doc, d.start, d.end),
      message: d.message,
      source: 'cgpl',
    });
    if (out.length >= settings.maxProblems) break;
  }

  // Semantic checks only run on a file that parses cleanly. Reporting
  // "unknown function" inside code the parser could not make sense of would
  // be noise on top of noise.
  const hasSyntaxErrors = parseDiagnostics.some((d) => d.severity === 'error');
  if (!hasSyntaxErrors) {
    if (settings.reportArity) {
      for (const p of arityProblems(analysis)) {
        if (out.length >= settings.maxProblems) break;
        out.push({
          severity: DiagnosticSeverity.Error,
          range: rangeOf(doc, p.start, p.end),
          message: p.message,
          source: 'cgpl',
        });
      }
    }
    if (settings.reportUnknownCalls) {
      for (const call of unresolvedCalls(analysis)) {
        if (out.length >= settings.maxProblems) break;
        out.push({
          severity: DiagnosticSeverity.Warning,
          range: rangeOf(doc, call.start, call.end),
          message:
            `'${text.slice(call.start, call.end)}' is not a built-in and is not defined or ` +
            'declared in this file',
          source: 'cgpl',
        });
      }
    }
  }

  connection.sendDiagnostics({ uri: doc.uri, diagnostics: out });
}

// --- outline ----------------------------------------------------------------

const SYMBOL_KINDS: Record<string, SymbolKind> = {
  entry: SymbolKind.Event,
  procedure: SymbolKind.Method,
  function: SymbolKind.Function,
  variable: SymbolKind.Variable,
  constant: SymbolKind.Constant,
  parameter: SymbolKind.Variable,
};

function toDocumentSymbol(doc: TextDocument, sym: SymbolInfo): DocumentSymbol {
  const detail =
    sym.bodyKind === 'external'
      ? 'external'
      : sym.bodyKind === 'forward'
        ? 'forward'
        : sym.params && sym.params.length
          ? `(${sym.params.join(', ')})`
          : undefined;
  return {
    name: sym.name,
    detail,
    kind: SYMBOL_KINDS[sym.kind] ?? SymbolKind.Variable,
    range: rangeOf(doc, sym.start, sym.end),
    selectionRange: rangeOf(doc, sym.nameStart, sym.nameEnd),
    children: sym.children?.map((c) => toDocumentSymbol(doc, c)),
  };
}

// --- position helpers -------------------------------------------------------

/** The identifier-ish token at `offset`, if any. */
function tokenAt(text: string, offset: number): { text: string; start: number; end: number } | undefined {
  const { tokens } = tokenize(text);
  for (const t of tokens) {
    if (t.kind !== TokenKind.Identifier && t.kind !== TokenKind.Keyword) continue;
    if (offset >= t.start && offset <= t.end) return { text: t.text, start: t.start, end: t.end };
  }
  return undefined;
}

const CGPL_EXTENSIONS = ['.sppi', '.sppr', '.wcgi', '.wcgp', '.scgi', '.scgp'];

/**
 * The extension an external module is stored under, per environment. Each pair
 * is a program extension and the include extension its external modules use:
 * .sppr/.sppi for Real-Time Applications (PBXApp.md), .wcgp/.wcgi for Web
 * Applications (WebApp.md), .scgp/.scgi for synchronous scripts (CGPL.md
 * #SynchronousScripts). A module is always the include half of the pair.
 */
const MODULE_EXTENSION: Record<string, string> = {
  '.sppr': '.sppi',
  '.sppi': '.sppi',
  '.wcgp': '.wcgi',
  '.wcgi': '.wcgi',
  '.scgp': '.scgi',
  '.scgi': '.scgi',
};

/**
 * An external-declaration names a separate program module, which the server
 * loads from the current Environment or Skin - a flat list of files, so a
 * sibling of the file doing the declaring.
 *
 * TODO: a Real-Time Application Environment is flat only at its top level. It
 * may also hold language directories named for the language they serve
 * (french, russian, ...), one level deep and never nested, and a task that has
 * selected a language reads from that directory first, falling back to the
 * Environment root when the file is absent there (PBXApp.md #Environments).
 * Those directories usually override only media, but they may carry .sppr/.sppi
 * under the same names. Looking in siblings alone is right for a file at the
 * root; what it misses is the fallback the other way, from a file inside a
 * language directory to a module that only exists at the root.
 *
 * The name is matched case-insensitively because CG/PL names are: the module
 * bridgedLoopHash and the file bridgedloophash.sppi are the same thing.
 * Probing constructed spellings instead gets that wrong twice over - it misses
 * on Linux, where CommuniGate Pro servers run, and on a case-insensitive file
 * system it matches while reporting back the guessed spelling rather than the
 * name on disk. One directory listing per jump costs less than either.
 */
function findModuleFile(docUri: string, moduleName: string): string | undefined {
  const fsPath = URI.toFsPath(docUri);
  const dir = path.dirname(fsPath);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }

  const wanted = moduleName.toLowerCase();
  const matches = entries.filter(
    (entry) =>
      CGPL_EXTENSIONS.includes(path.extname(entry).toLowerCase()) &&
      path.basename(entry, path.extname(entry)).toLowerCase() === wanted,
  );
  if (matches.length === 0) return undefined;

  // Which file wins matters when a Web Application and a Real-Time Application
  // sit in one directory under a shared module name. The extension the calling
  // environment actually loads comes first; the rest stay reachable, because a
  // checkout need not be laid out the way a deployed Environment is, and some
  // answer beats none.
  const preferred = MODULE_EXTENSION[path.extname(fsPath).toLowerCase()];
  const rank = (name: string): number => {
    const ext = path.extname(name).toLowerCase();
    return ext === preferred ? -1 : CGPL_EXTENSIONS.indexOf(ext);
  };
  const spellingRank = (name: string): number =>
    Number(path.basename(name, path.extname(name)) !== moduleName);

  matches.sort((a, b) => spellingRank(a) - spellingRank(b) || rank(a) - rank(b));
  return path.join(dir, matches[0]);
}

function definitionInFile(file: string, sectionLower: string): Location | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const analysis = analyze(parse(text).program);
  const target =
    analysis.sections.get(sectionLower) ??
    // A module's section may be declared unqualified inside its own file.
    analysis.sections.get(sectionLower.split('::').pop() ?? sectionLower);
  // The module file may itself only re-declare the section as external; that is
  // a dead end, not a definition, and following it would land the cursor on
  // another 'external;' line.
  if (!target || target.bodyKind === 'external') return undefined;
  const doc = TextDocument.create(URI.fromFsPath(file), 'cgpl', 0, text);
  return {
    uri: doc.uri,
    range: rangeOf(doc, target.nameStart, target.nameEnd),
  };
}

/**
 * Follows an external-declaration to the module that defines it.
 *
 * Which module is named depends on how the declaration was written, and the two
 * forms differ (CGPL.md #Modules):
 *
 *   function myName(p) external;           -> module "myName",   section myName
 *   function myModule::myName(p) external; -> module "myModule", section myName
 *
 * The unqualified form is the one stock CommuniGate Pro scripts use, and it is
 * easy to misread: the module name is not absent, it is the section name.
 */
function externalDefinition(docUri: string, section: SymbolInfo): Location | undefined {
  if (section.bodyKind !== 'external') return undefined;
  const sectionName = section.name.split('::').pop() ?? section.name;
  const moduleName = section.module ?? sectionName;
  const file = findModuleFile(docUri, moduleName);
  if (!file) return undefined;
  return definitionInFile(file, sectionName.toLowerCase());
}

// --- completion -------------------------------------------------------------

function builtinCompletion(b: Builtin): CompletionItem {
  return {
    label: b.name,
    kind: b.isFunction === false ? CompletionItemKind.Method : CompletionItemKind.Function,
    detail: b.signatures[0] ?? b.name,
    documentation: { kind: MarkupKind.Markdown, value: builtinHover(b) },
    // Locals sort above built-ins, and undocumented built-ins below the
    // documented ones.
    sortText: b.source === 'registry' || b.source === 'alias' ? `3_${b.name}` : `2_${b.name}`,
  };
}

function localCompletions(analysis: AnalysisResult, offset: number): CompletionItem[] {
  const out: CompletionItem[] = [];
  const seen = new Set<string>();
  const add = (sym: SymbolInfo, kind: CompletionItemKind, detail: string) => {
    if (seen.has(sym.lower)) return;
    seen.add(sym.lower);
    out.push({ label: sym.name, kind, detail, sortText: `1_${sym.name}` });
  };

  for (const sym of analysis.symbols) {
    if (sym.kind === 'entry' || sym.kind === 'procedure' || sym.kind === 'function') {
      const detail = sym.params && sym.params.length ? `${sym.name}(${sym.params.join(', ')})` : `${sym.name}()`;
      add(sym, sym.kind === 'function' ? CompletionItemKind.Function : CompletionItemKind.Method, detail);
      // Variables of the section the cursor is in.
      if (offset >= sym.start && offset <= sym.end) {
        for (const child of sym.children ?? []) {
          add(
            child,
            child.kind === 'parameter' ? CompletionItemKind.Variable : CompletionItemKind.Variable,
            child.kind === 'parameter' ? 'parameter' : child.kind,
          );
        }
      }
    } else {
      add(sym, CompletionItemKind.Variable, sym.kind === 'constant' ? 'constant' : 'task variable');
    }
  }
  return out;
}

// --- signature help ---------------------------------------------------------

/**
 * Walks backwards from `offset` to find the call being typed and which
 * argument the cursor sits in. Bracket-aware so nested calls resolve to the
 * innermost one.
 */
function enclosingCall(text: string, offset: number): { name: string; argIndex: number } | undefined {
  const { tokens } = tokenize(text);
  let i = tokens.findIndex((t) => t.start >= offset);
  if (i < 0) i = tokens.length - 1;

  let depth = 0;
  let argIndex = 0;
  for (let k = i - 1; k >= 0; k--) {
    const t = tokens[k];
    if (t.kind === TokenKind.Punctuation) {
      if (t.text === ')' || t.text === ']' || t.text === '}') depth++;
      else if (t.text === '[' || t.text === '{') {
        if (depth === 0) return undefined;
        depth--;
      } else if (t.text === '(') {
        if (depth === 0) {
          const name = tokens[k - 1];
          if (name && name.kind === TokenKind.Identifier) {
            return { name: name.text, argIndex };
          }
          return undefined;
        }
        depth--;
      } else if (t.text === ',' && depth === 0) {
        argIndex++;
      } else if (t.text === ';' && depth === 0) {
        return undefined;
      }
    }
  }
  return undefined;
}

// --- wiring -----------------------------------------------------------------

connection.onInitialize((): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: true,
      definitionProvider: true,
      hoverProvider: true,
      completionProvider: { resolveProvider: false, triggerCharacters: ['.', ':'] },
      signatureHelpProvider: { triggerCharacters: ['(', ','] },
    },
  };
});

connection.onDidChangeConfiguration((change) => {
  const incoming = (change.settings as { cgpl?: Partial<Settings> } | undefined)?.cgpl;
  settings = { ...DEFAULT_SETTINGS, ...(incoming ?? {}) };
  documents.all().forEach(validate);
});

documents.onDidChangeContent((change) => validate(change.document));
documents.onDidClose((event) => {
  analyses.delete(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onDocumentSymbol((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return analysisFor(doc).symbols.map((s) => toDocumentSymbol(doc, s));
});

connection.onDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  const offset = doc.offsetAt(params.position);
  const analysis = analysisFor(doc);

  // A qualified name may point at another module's file even with no matching
  // declaration in this one.
  const call = analysis.calls.find((c) => offset >= c.start && offset <= c.end);
  if (call && call.lower.includes('::')) {
    const [moduleName] = call.lower.split('::');
    const file = findModuleFile(doc.uri, moduleName);
    if (file) {
      // The qualified name, so that a module declaring its own section as
      // module::name still matches; definitionInFile falls back to the bare
      // section name for the usual case where it does not.
      const loc = definitionInFile(file, call.lower);
      if (loc) return loc;
    }
  }

  const tok = tokenAt(text, offset);
  if (!tok) return null;
  const lower = tok.text.toLowerCase();

  const section = analysis.sections.get(lower);
  if (section) {
    // An external-declaration is a signpost, not a destination: jumping to it
    // would leave the cursor on the 'external;' line the user is already
    // looking at. Follow it to the module that defines the section, and fall
    // back to the declaration only when that module cannot be found.
    return (
      externalDefinition(doc.uri, section) ??
      ({ uri: doc.uri, range: rangeOf(doc, section.nameStart, section.nameEnd) } as Location)
    );
  }

  // Fall back to a local variable or parameter declaration.
  for (const sym of analysis.symbols) {
    if (!sym.children) continue;
    if (offset < sym.start || offset > sym.end) continue;
    const local = sym.children.find((c) => c.lower === lower);
    if (local) return { uri: doc.uri, range: rangeOf(doc, local.nameStart, local.nameEnd) } as Location;
  }
  const global = analysis.globals.find((g) => g.lower === lower);
  if (global) return { uri: doc.uri, range: rangeOf(doc, global.nameStart, global.nameEnd) } as Location;
  return null;
});

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const tok = tokenAt(doc.getText(), doc.offsetAt(params.position));
  if (!tok) return null;

  const analysis = analysisFor(doc);
  const lower = tok.text.toLowerCase();

  const section = analysis.sections.get(lower);
  if (section) {
    const params_ = section.params?.length ? section.params.join(', ') : '';
    const body = section.bodyKind === 'definition' ? '' : ` ${section.bodyKind}`;
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: ['```cgpl', `${section.kind} ${section.name}(${params_})${body}`, '```'].join('\n'),
      },
    };
  }

  const builtin = lookupBuiltin(lower);
  if (builtin) {
    return { contents: { kind: MarkupKind.Markdown, value: builtinHover(builtin) } };
  }
  return null;
});

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const offset = doc.offsetAt(params.position);
  const items = localCompletions(analysisFor(doc), offset);
  for (const b of allBuiltins()) items.push(builtinCompletion(b));
  return items;
});

connection.onSignatureHelp((params): SignatureHelp | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const found = enclosingCall(doc.getText(), doc.offsetAt(params.position));
  if (!found) return null;

  const analysis = analysisFor(doc);
  const section = analysis.sections.get(found.name.toLowerCase());
  if (section) {
    const paramNames = section.params ?? [];
    const label = `${section.name}(${paramNames.join(', ')})`;
    const info: SignatureInformation = {
      label,
      parameters: paramNames.map((p) => ({ label: p })),
    };
    return { signatures: [info], activeSignature: 0, activeParameter: found.argIndex };
  }

  const builtin = lookupBuiltin(found.name);
  if (!builtin) return null;
  const signatures: SignatureInformation[] = (builtin.signatures.length ? builtin.signatures : [builtin.name]).map(
    (sig) => ({
      label: sig,
      documentation: builtin.doc ? { kind: MarkupKind.Markdown, value: builtin.doc } : undefined,
      parameters: (builtin.params ?? []).map((p) => ({ label: p })),
    }),
  );
  return { signatures, activeSignature: 0, activeParameter: found.argIndex };
});

documents.listen(connection);
connection.listen();

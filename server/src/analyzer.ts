// Walks a parsed program to build the symbol information the editor needs:
// the outline, definition targets, local variables in scope, and the
// "unknown call" check.

import * as ast from './ast';
import { lookupBuiltin } from './builtins';

export type SymbolKind = 'entry' | 'procedure' | 'function' | 'variable' | 'constant' | 'parameter';

export interface SymbolInfo {
  name: string;
  lower: string;
  kind: SymbolKind;
  /** For code sections declared as `module::name`. */
  module?: string;
  /** Full node range. */
  start: number;
  end: number;
  /** Range of just the name, used as the go-to-definition target. */
  nameStart: number;
  nameEnd: number;
  /** Sections only: how the body was written. */
  bodyKind?: ast.SectionBody;
  /** Sections only: parameter names, for signature help. */
  params?: string[];
  children?: SymbolInfo[];
}

export interface Reference {
  lower: string;
  start: number;
  end: number;
  /** Number of arguments passed, for arity checking. */
  argCount?: number;
}

export interface ArityProblem {
  message: string;
  start: number;
  end: number;
}

export interface AnalysisResult {
  /** Top-level symbols, each section carrying its locals as children. */
  symbols: SymbolInfo[];
  /** Every code section defined or declared in this file, by lower-cased name. */
  sections: Map<string, SymbolInfo>;
  /** Every name used in a call position, for the unknown-call check. */
  calls: Reference[];
  /** Task-scoped variables and constants, visible to all sections. */
  globals: SymbolInfo[];
}

function declaratorSymbols(
  decls: ast.Declarator[],
  kind: SymbolKind,
): SymbolInfo[] {
  return decls.map((d) => ({
    name: d.name.name,
    lower: d.name.lower,
    kind,
    start: d.name.start,
    end: d.init ? d.init.end : d.name.end,
    nameStart: d.name.start,
    nameEnd: d.name.end,
  }));
}

/** Collects variables declared anywhere inside a statement list. */
function collectLocals(body: ast.Statement[], out: SymbolInfo[]): void {
  for (const stmt of body) {
    switch (stmt.kind) {
      case 'VarDeclaration':
        out.push(...declaratorSymbols(stmt.declarators, 'variable'));
        break;
      case 'ConstDeclaration':
        out.push(...declaratorSymbols(stmt.declarators, 'constant'));
        break;
      case 'IfStatement':
        for (const clause of stmt.clauses) collectLocals(clause.body, out);
        if (stmt.alternate) collectLocals(stmt.alternate, out);
        break;
      case 'LoopStatement':
        if (stmt.init) collectLocals([stmt.init], out);
        collectLocals(stmt.body, out);
        for (const e of stmt.exitIfs) collectLocals(e.body, out);
        break;
      default:
        break;
    }
  }
}

/** Walks every expression in a statement list, calling `visit` on each node. */
function walkExpressions(body: ast.Statement[], visit: (e: ast.Expression) => void): void {
  const expr = (e: ast.Expression | undefined): void => {
    if (!e) return;
    visit(e);
    switch (e.kind) {
      case 'UnaryExpression':
        expr(e.argument);
        break;
      case 'BinaryExpression':
        expr(e.left);
        expr(e.right);
        break;
      case 'ConditionalExpression':
        expr(e.test);
        expr(e.consequent);
        expr(e.alternate);
        break;
      case 'CallExpression':
        e.args.forEach(expr);
        break;
      case 'MethodCallExpression':
        expr(e.object);
        e.args.forEach(expr);
        break;
      case 'MemberExpression':
        expr(e.object);
        break;
      case 'ComputedMemberExpression':
        expr(e.object);
        expr(e.key);
        break;
      case 'IndexExpression':
        expr(e.object);
        expr(e.index);
        break;
      case 'ParenExpression':
        expr(e.expression);
        break;
      case 'SpawnExpression':
        expr(e.argument);
        break;
      default:
        break;
    }
  };

  const stmt = (s: ast.Statement): void => {
    switch (s.kind) {
      case 'ExpressionStatement':
        expr(s.expression);
        break;
      case 'AssignmentStatement':
        expr(s.target);
        expr(s.value);
        break;
      case 'ReturnStatement':
        expr(s.argument);
        break;
      case 'VarDeclaration':
      case 'ConstDeclaration':
        for (const d of s.declarators) expr(d.init);
        break;
      case 'IfStatement':
        for (const c of s.clauses) {
          expr(c.test);
          c.body.forEach(stmt);
        }
        s.alternate?.forEach(stmt);
        break;
      case 'LoopStatement':
        if (s.init) stmt(s.init);
        expr(s.test);
        if (s.step) stmt(s.step);
        s.body.forEach(stmt);
        for (const e of s.exitIfs) {
          expr(e.test);
          e.body.forEach(stmt);
        }
        break;
      default:
        break;
    }
  };

  body.forEach(stmt);
}

export function analyze(program: ast.Program): AnalysisResult {
  const symbols: SymbolInfo[] = [];
  const sections = new Map<string, SymbolInfo>();
  const globals: SymbolInfo[] = [];
  const calls: Reference[] = [];

  for (const item of program.body) {
    if (item.kind === 'VarDeclaration') {
      const syms = declaratorSymbols(item.declarators, 'variable');
      globals.push(...syms);
      symbols.push(...syms);
      continue;
    }
    if (item.kind === 'ConstDeclaration') {
      const syms = declaratorSymbols(item.declarators, 'constant');
      globals.push(...syms);
      symbols.push(...syms);
      continue;
    }
    if (item.kind !== 'CodeSection') continue;

    const children: SymbolInfo[] = item.params.map((p) => ({
      name: p.name,
      lower: p.lower,
      kind: 'parameter' as const,
      start: p.start,
      end: p.end,
      nameStart: p.start,
      nameEnd: p.end,
    }));
    collectLocals(item.body, children);

    const info: SymbolInfo = {
      name: item.name.module ? `${item.name.module.name}::${item.name.name.name}` : item.name.name.name,
      lower: item.name.qualified,
      kind: item.sectionKind,
      module: item.name.module?.name,
      start: item.start,
      end: item.end,
      nameStart: item.nameStart,
      nameEnd: item.nameEnd,
      bodyKind: item.bodyKind,
      params: item.params.map((p) => p.name),
      children,
    };

    // A forward declaration followed by the definition is the normal idiom;
    // keep whichever actually has a body as the definition target.
    const existing = sections.get(info.lower);
    if (!existing || (existing.bodyKind !== 'definition' && info.bodyKind === 'definition')) {
      sections.set(info.lower, info);
    }
    symbols.push(info);

    walkExpressions(item.body, (e) => {
      if (e.kind === 'CallExpression') {
        calls.push({
          lower: e.callee.qualified,
          start: e.callee.start,
          end: e.callee.end,
          argCount: e.args.length,
        });
      } else if (e.kind === 'SpawnExpression' && e.target.lower) {
        calls.push({ lower: e.target.lower, start: e.target.start, end: e.target.end });
      }
    });
  }

  return { symbols, sections, calls, globals };
}

/**
 * Calls that resolve to nothing known: not a built-in, not defined or declared
 * in this file. Reported as a hint rather than an error - CG/PL resolves
 * external modules at run time, and a name may legitimately live in another
 * file, so this can only ever be a suggestion.
 */
export function unresolvedCalls(result: AnalysisResult): Reference[] {
  const out: Reference[] = [];
  for (const call of result.calls) {
    if (result.sections.has(call.lower)) continue;
    // A module-qualified call is resolved by the server at run time.
    if (call.lower.includes('::')) continue;
    if (lookupBuiltin(call.lower)) continue;
    out.push(call);
  }
  return out;
}

/**
 * Calls to built-ins with an argument count the server would reject. Arity
 * comes from the server's own registration tables, so this is a real error
 * rather than a style opinion - but it is only applied to entries that
 * actually carry arity, and never to the method-call form (where the object
 * itself becomes the first argument).
 */
export function arityProblems(result: AnalysisResult): ArityProblem[] {
  const out: ArityProblem[] = [];
  for (const call of result.calls) {
    if (call.argCount === undefined) continue;
    // A locally defined section shadows nothing, but it is what actually runs.
    if (result.sections.has(call.lower)) continue;
    const builtin = lookupBuiltin(call.lower);
    if (!builtin || builtin.minArgs === undefined || builtin.maxArgs === undefined) continue;
    const { minArgs, maxArgs } = builtin;
    if (call.argCount >= minArgs && call.argCount <= maxArgs) continue;
    const expected =
      minArgs === maxArgs
        ? `${minArgs} argument${minArgs === 1 ? '' : 's'}`
        : `${minArgs} to ${maxArgs} arguments`;
    out.push({
      message: `${builtin.name} takes ${expected}, but ${call.argCount} given`,
      start: call.start,
      end: call.end,
    });
  }
  return out;
}

/** The section whose body encloses `offset`, if any. */
export function sectionAt(result: AnalysisResult, offset: number): SymbolInfo | undefined {
  for (const sym of result.symbols) {
    if (sym.children && offset >= sym.start && offset <= sym.end) return sym;
  }
  return undefined;
}

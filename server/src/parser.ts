// Recursive-descent parser for CG/PL, following the Formal Syntax table in
// CGPL.md #Syntax. Both documented dialects are accepted in the same file:
// the `is ... end` form and the brace form (CGPL.md #AlternativeForms).
//
// Error handling: the parser never throws and never stops early. On an
// unexpected token it records a diagnostic, emits an Error* node, and
// resynchronizes at the next statement or section boundary, so an edit in
// progress at the top of a file cannot blank out the outline for the rest.

import { Token, TokenKind, tokenize } from './lexer';
import * as ast from './ast';

export interface ParseDiagnostic {
  message: string;
  start: number;
  end: number;
  severity: 'error' | 'warning';
}

export interface ParseResult {
  program: ast.Program;
  diagnostics: ParseDiagnostic[];
}

/** Assignment operators, CGPL.md #Opers (letOp). */
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '|=', '&=']);

// Binary operator precedence, lowest binding first, per CGPL.md #Exprs:
// mult > add > comparison > logical. Ternary is handled separately and binds
// loosest of all.
const PRECEDENCE: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['and', 'or', 'xor', 'and then', 'or else', '&', '|', '^', '&&', '||']),
  new Set(['<', '<=', '==', '!=', '>=', '>']),
  new Set(['+', '-']),
  new Set(['*', '/', '%']),
];

/** Keywords that can begin a statement - used as resync points. */
const STATEMENT_STARTERS = new Set([
  'if', 'while', 'for', 'loop', 'return', 'stop', 'var', 'const', 'null', 'exitif',
]);

const SECTION_STARTERS = new Set(['entry', 'procedure', 'function']);

class Parser {
  private tokens: Token[];
  private index = 0;
  readonly diagnostics: ParseDiagnostic[] = [];

  constructor(private readonly source: string) {
    const lex = tokenize(source);
    this.tokens = lex.tokens;
    for (const d of lex.diagnostics) {
      this.diagnostics.push({ ...d, severity: 'error' });
    }
  }

  // --- token helpers --------------------------------------------------------

  private peek(offset = 0): Token {
    const i = this.index + offset;
    return this.tokens[i < this.tokens.length ? i : this.tokens.length - 1];
  }

  private get current(): Token {
    return this.peek();
  }

  private atEnd(): boolean {
    return this.current.kind === TokenKind.EndOfFile;
  }

  private next(): Token {
    const t = this.current;
    if (!this.atEnd()) this.index++;
    return t;
  }

  private isKeyword(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === TokenKind.Keyword && t.lower === word;
  }

  private isOp(op: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === TokenKind.Operator && t.text === op;
  }

  private isPunct(p: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === TokenKind.Punctuation && t.text === p;
  }

  private eatKeyword(word: string): boolean {
    if (this.isKeyword(word)) {
      this.index++;
      return true;
    }
    return false;
  }

  private eatPunct(p: string): boolean {
    if (this.isPunct(p)) {
      this.index++;
      return true;
    }
    return false;
  }

  private eatOp(op: string): boolean {
    if (this.isOp(op)) {
      this.index++;
      return true;
    }
    return false;
  }

  private error(message: string, token: Token = this.current): void {
    // Collapse repeats at the same position: one confusing token should not
    // produce a wall of squiggles.
    const last = this.diagnostics[this.diagnostics.length - 1];
    if (last && last.start === token.start && last.message === message) return;
    this.diagnostics.push({
      message,
      start: token.start,
      end: Math.max(token.end, token.start + 1),
      severity: 'error',
    });
  }

  private expectPunct(p: string, context: string): boolean {
    if (this.eatPunct(p)) return true;
    this.error(`Expected '${p}' ${context}`);
    return false;
  }

  // --- entry point ----------------------------------------------------------

  parseProgram(): ast.Program {
    const body: ast.TopLevel[] = [];
    while (!this.atEnd()) {
      const before = this.index;
      const item = this.parseTopLevel();
      if (item) body.push(item);
      // Guarantee forward progress even if a sub-parser consumed nothing.
      if (this.index === before) {
        this.error(`Unexpected ${this.describe(this.current)} at top level`);
        this.next();
        this.resyncToSection();
      }
    }
    return {
      kind: 'Program',
      start: 0,
      end: this.source.length,
      body,
    };
  }

  private describe(t: Token): string {
    if (t.kind === TokenKind.EndOfFile) return 'end of file';
    return `'${t.text}'`;
  }

  private parseTopLevel(): ast.TopLevel | undefined {
    if (this.isKeyword('entry') || this.isKeyword('procedure') || this.isKeyword('function')) {
      return this.parseCodeSection();
    }
    if (this.isKeyword('var')) return this.parseVarDeclaration(true);
    if (this.isKeyword('const')) return this.parseConstDeclaration();
    // A stray semicolon between sections is harmless.
    if (this.eatPunct(';')) return undefined;
    return undefined;
  }

  private resyncToSection(): void {
    while (!this.atEnd()) {
      if (this.current.kind === TokenKind.Keyword && SECTION_STARTERS.has(this.current.lower)) return;
      this.next();
    }
  }

  // --- code sections --------------------------------------------------------

  private parseCodeSection(): ast.CodeSection {
    const startTok = this.next(); // entry | procedure | function
    const sectionKind = startTok.lower as ast.SectionKind;

    const name = this.parseCodeName();
    const params: ast.Identifier[] = [];

    // Only procedures and functions take a parameter list; `entry` never does.
    if (sectionKind !== 'entry' && this.isPunct('(')) {
      this.next();
      if (!this.isPunct(')')) {
        do {
          const p = this.parseIdentifier('parameter name');
          if (p) params.push(p);
          else break;
        } while (this.eatPunct(','));
      }
      this.expectPunct(')', 'after the parameter list');
    }

    let bodyKind: ast.SectionBody = 'definition';
    let body: ast.Statement[] = [];

    if (this.eatKeyword('forward')) {
      bodyKind = 'forward';
      this.expectPunct(';', "after 'forward'");
    } else if (this.eatKeyword('external')) {
      bodyKind = 'external';
      this.expectPunct(';', "after 'external'");
    } else if (this.eatKeyword('is')) {
      body = this.parseStatementsUntil((p) => p.isKeyword('end'));
      if (this.eatKeyword('end')) {
        // `end` may be followed by the section keyword, then a semicolon.
        if (this.current.kind === TokenKind.Keyword && SECTION_STARTERS.has(this.current.lower)) {
          this.next();
        }
        this.expectPunct(';', "after 'end'");
      } else {
        this.error(`Expected 'end' to close ${sectionKind} '${name.name.name}'`);
      }
    } else if (this.isPunct('{')) {
      this.next();
      body = this.parseStatementsUntil((p) => p.isPunct('}'));
      this.expectPunct('}', `to close ${sectionKind} '${name.name.name}'`);
    } else {
      this.error(`Expected 'is', '{', 'forward' or 'external' in ${sectionKind} '${name.name.name}'`);
      this.resyncToSection();
    }

    return {
      kind: 'CodeSection',
      sectionKind,
      name,
      params,
      bodyKind,
      body,
      start: startTok.start,
      end: this.previousEnd(),
      nameStart: name.start,
      nameEnd: name.end,
    };
  }

  private previousEnd(): number {
    const prev = this.tokens[Math.max(0, this.index - 1)];
    return prev ? prev.end : 0;
  }

  private parseCodeName(): ast.CodeName {
    const first = this.parseIdentifier('a name');
    if (!first) {
      const t = this.current;
      const placeholder: ast.Identifier = {
        kind: 'Identifier', name: '', lower: '', start: t.start, end: t.start,
      };
      return {
        kind: 'CodeName', name: placeholder, qualified: '', start: t.start, end: t.start,
      };
    }
    if (this.isOp('::')) {
      this.next();
      const second = this.parseIdentifier('a name after ::');
      if (second) {
        return {
          kind: 'CodeName',
          module: first,
          name: second,
          qualified: `${first.lower}::${second.lower}`,
          start: first.start,
          end: second.end,
        };
      }
    }
    return {
      kind: 'CodeName', name: first, qualified: first.lower, start: first.start, end: first.end,
    };
  }

  private parseIdentifier(what: string): ast.Identifier | undefined {
    const t = this.current;
    if (t.kind !== TokenKind.Identifier) {
      this.error(`Expected ${what}, found ${this.describe(t)}`);
      return undefined;
    }
    this.next();
    return { kind: 'Identifier', name: t.text, lower: t.lower, start: t.start, end: t.end };
  }

  // --- statements -----------------------------------------------------------

  private parseStatementsUntil(stop: (p: Parser) => boolean): ast.Statement[] {
    const out: ast.Statement[] = [];
    while (!this.atEnd() && !stop(this)) {
      // Never run past the start of the next section: a missing `end` should
      // cost one diagnostic, not every following section.
      if (this.current.kind === TokenKind.Keyword && SECTION_STARTERS.has(this.current.lower)) break;
      const before = this.index;
      const stmt = this.parseStatement();
      if (stmt) out.push(stmt);
      if (this.index === before) {
        this.error(`Unexpected ${this.describe(this.current)}`);
        this.next();
        this.resyncStatement();
      }
    }
    return out;
  }

  /** Skip to just past the next `;`, or to a token that clearly starts something new. */
  private resyncStatement(): void {
    while (!this.atEnd()) {
      if (this.isPunct(';')) {
        this.next();
        return;
      }
      if (this.isPunct('}')) return;
      if (this.current.kind === TokenKind.Keyword) {
        const w = this.current.lower;
        if (STATEMENT_STARTERS.has(w) || SECTION_STARTERS.has(w) || w === 'end' || w === 'elif' || w === 'else') {
          return;
        }
      }
      this.next();
    }
  }

  private parseStatement(): ast.Statement | undefined {
    const t = this.current;

    if (this.isPunct(';')) {
      this.next();
      return { kind: 'EmptyStatement', start: t.start, end: t.end };
    }

    if (t.kind === TokenKind.Keyword) {
      switch (t.lower) {
        case 'null': {
          // `null;` is the documented no-op statement, but `null` is also a
          // literal - only treat it as a statement when a `;` follows.
          if (this.isPunct(';', 1)) {
            this.next();
            const semi = this.next();
            return { kind: 'NullStatement', start: t.start, end: semi.end };
          }
          break;
        }
        case 'stop': {
          this.next();
          this.expectSemicolon("after 'stop'");
          return { kind: 'StopStatement', start: t.start, end: this.previousEnd() };
        }
        case 'return': {
          this.next();
          let argument: ast.Expression | undefined;
          if (!this.isPunct(';')) argument = this.parseExpression();
          this.expectSemicolon("after 'return'");
          return { kind: 'ReturnStatement', argument, start: t.start, end: this.previousEnd() };
        }
        case 'var':
          return this.parseVarDeclaration(false);
        case 'const':
          return this.parseConstDeclaration();
        case 'if':
          return this.parseIfStatement();
        case 'while':
        case 'for':
        case 'loop':
          return this.parseLoopStatement();
        default:
          break;
      }
    }

    // Everything else is an expression statement or an assignment.
    return this.parseExpressionOrAssignment();
  }

  private expectSemicolon(context: string): void {
    if (this.eatPunct(';')) return;
    // A closing brace or `end` right after a statement means the author simply
    // omitted the final `;`, which the language does not require before them
    // in the brace dialect. Do not report those.
    if (this.isPunct('}') || this.isKeyword('end')) return;
    this.error(`Expected ';' ${context}`);
  }

  private parseExpressionOrAssignment(): ast.Statement {
    const start = this.current.start;
    const expr = this.parseExpression();

    if (this.current.kind === TokenKind.Operator && ASSIGN_OPS.has(this.current.text)) {
      const op = this.next().text;
      const value = this.parseExpression();
      this.expectSemicolon('after an assignment');
      return {
        kind: 'AssignmentStatement',
        operator: op,
        target: expr,
        value,
        start,
        end: this.previousEnd(),
      };
    }

    this.expectSemicolon('after a statement');
    return { kind: 'ExpressionStatement', expression: expr, start, end: this.previousEnd() };
  }

  private parseVarDeclaration(topLevel: boolean): ast.VarDeclaration {
    const kw = this.next(); // var
    const declarators = this.parseDeclarators(!topLevel);
    this.expectSemicolon("after a 'var' declaration");
    return {
      kind: 'VarDeclaration',
      declarators,
      taskScoped: topLevel,
      start: kw.start,
      end: this.previousEnd(),
    };
  }

  private parseConstDeclaration(): ast.ConstDeclaration {
    const kw = this.next(); // const
    const declarators = this.parseDeclarators(true);
    this.expectSemicolon("after a 'const' declaration");
    return {
      kind: 'ConstDeclaration',
      declarators,
      start: kw.start,
      end: this.previousEnd(),
    };
  }

  private parseDeclarators(allowInit: boolean): ast.Declarator[] {
    const out: ast.Declarator[] = [];
    do {
      const name = this.parseIdentifier('a variable name');
      if (!name) break;
      let init: ast.Expression | undefined;
      if (this.isOp('=')) {
        this.next();
        init = this.parseExpression();
        if (!allowInit) {
          // Task variables are documented as not taking initializers. Flag it
          // as a warning rather than an error: it parses fine and the server
          // should not block on a rule the author may know better than us.
          this.diagnostics.push({
            message: 'Task variables (declared outside a code section) should not have an initial value',
            start: init.start,
            end: init.end,
            severity: 'warning',
          });
        }
      }
      out.push({ name, init });
    } while (this.eatPunct(','));
    return out;
  }

  private parseIfStatement(): ast.IfStatement {
    const start = this.next().start; // if
    const clauses: ast.IfClause[] = [];
    let alternate: ast.Statement[] | undefined;
    let alternateStart: number | undefined;
    let alternateEnd: number | undefined;

    const test = this.parseExpression();

    if (this.eatKeyword('then')) {
      // `is/end` dialect
      clauses.push(this.parseIfClause(test, (p) => p.isEndOfIfPart()));
      while (this.isKeyword('elif')) {
        this.next();
        const elifTest = this.parseExpression();
        this.eatKeyword('then');
        clauses.push(this.parseIfClause(elifTest, (p) => p.isEndOfIfPart()));
      }
      if (this.eatKeyword('else')) {
        alternateStart = this.previousEnd();
        alternate = this.parseStatementsUntil((p) => p.isKeyword('end'));
        alternateEnd = this.current.start;
      }
      if (this.eatKeyword('end')) {
        this.eatKeyword('if');
        this.expectSemicolon("after 'end if'");
      } else {
        this.error("Expected 'end' to close 'if'");
      }
    } else if (this.isPunct('{')) {
      // brace dialect
      this.next();
      clauses.push(this.parseIfClause(test, (p) => p.isPunct('}')));
      this.expectPunct('}', "to close the 'if' body");
      while (this.isKeyword('elif')) {
        this.next();
        const elifTest = this.parseExpression();
        this.expectPunct('{', "after an 'elif' condition");
        clauses.push(this.parseIfClause(elifTest, (p) => p.isPunct('}')));
        this.expectPunct('}', "to close the 'elif' body");
      }
      if (this.eatKeyword('else')) {
        // `else if` chains are written as `elif` in CG/PL, but tolerate the
        // brace-dialect `else { ... }`.
        this.expectPunct('{', "after 'else'");
        alternateStart = this.previousEnd();
        alternate = this.parseStatementsUntil((p) => p.isPunct('}'));
        alternateEnd = this.current.start;
        this.expectPunct('}', "to close the 'else' body");
      }
    } else {
      this.error("Expected 'then' or '{' after an 'if' condition");
      this.resyncStatement();
    }

    return {
      kind: 'IfStatement',
      clauses,
      alternate,
      alternateStart,
      alternateEnd,
      start,
      end: this.previousEnd(),
    };
  }

  /**
   * A branch body plus its source range. The range runs from just past the
   * `then`/`{` that opened it to the start of the token that closes it, so it
   * covers the trailing blank lines a reader is likely to be typing on - the
   * scope of a `var` declared in this branch (CGPL.md #Variables).
   */
  private parseIfClause(test: ast.Expression, stop: (p: Parser) => boolean): ast.IfClause {
    const start = this.previousEnd();
    const body = this.parseStatementsUntil(stop);
    return { test, body, start, end: this.current.start };
  }

  private isEndOfIfPart(): boolean {
    return this.isKeyword('elif') || this.isKeyword('else') || this.isKeyword('end');
  }

  private parseLoopStatement(): ast.LoopStatement {
    const startTok = this.current;
    let form: 'loop' | 'while' | 'for' = 'loop';
    let init: ast.Statement | undefined;
    let test: ast.Expression | undefined;
    let step: ast.Statement | undefined;
    let braceForm = false;

    if (this.isKeyword('while')) {
      this.next();
      form = 'while';
      test = this.parseExpression();
      braceForm = this.isPunct('{');
    } else if (this.isKeyword('for')) {
      this.next();
      form = 'for';
      if (this.isPunct('(')) {
        // Alternative form: for ( [init] ; [test] ; [step] ) { ... }
        braceForm = true;
        this.next();
        if (!this.isPunct(';')) init = this.parseLoopInit();
        this.expectPunct(';', "in the 'for' header");
        if (!this.isPunct(';')) test = this.parseExpression();
        this.expectPunct(';', "in the 'for' header");
        if (!this.isPunct(')')) step = this.parseLoopStep();
        this.expectPunct(')', "to close the 'for' header");
      } else {
        // Documented form: for [init] [while expr] [by step] loop ... end loop;
        if (!this.isKeyword('while') && !this.isKeyword('by') && !this.isKeyword('loop')) {
          init = this.parseLoopInit();
        }
        if (this.eatKeyword('while')) test = this.parseExpression();
        if (this.eatKeyword('by')) step = this.parseLoopStep();
      }
    }

    const body: ast.Statement[] = [];
    const exitIfs: ast.ExitIfClause[] = [];

    if (braceForm || (form === 'while' && this.isPunct('{'))) {
      this.expectPunct('{', 'to open the loop body');
      body.push(...this.parseStatementsUntil((p) => p.isPunct('}') || p.isKeyword('exitif')));
      this.parseExitIfs(exitIfs, (p) => p.isPunct('}'));
      this.expectPunct('}', 'to close the loop body');
    } else if (this.eatKeyword('loop')) {
      body.push(...this.parseStatementsUntil((p) => p.isKeyword('end') || p.isKeyword('exitif')));
      this.parseExitIfs(exitIfs, (p) => p.isKeyword('end'));
      if (this.eatKeyword('end')) {
        this.eatKeyword('loop');
        this.expectSemicolon("after 'end loop'");
      } else {
        this.error("Expected 'end' to close the loop");
      }
    } else if (this.isPunct('{')) {
      this.next();
      body.push(...this.parseStatementsUntil((p) => p.isPunct('}') || p.isKeyword('exitif')));
      this.parseExitIfs(exitIfs, (p) => p.isPunct('}'));
      this.expectPunct('}', 'to close the loop body');
    } else {
      this.error("Expected 'loop' or '{' to open the loop body");
      this.resyncStatement();
    }

    return {
      kind: 'LoopStatement',
      form,
      init,
      test,
      step,
      body,
      exitIfs,
      start: startTok.start,
      end: this.previousEnd(),
    };
  }

  private parseExitIfs(out: ast.ExitIfClause[], stop: (p: Parser) => boolean): void {
    while (this.isKeyword('exitif')) {
      this.next();
      const test = this.parseExpression();
      this.expectSemicolon("after an 'exitif' condition");
      const body = this.parseStatementsUntil((p) => stop(p) || p.isKeyword('exitif'));
      out.push({ test, body });
    }
  }

  /** `var x = 1` or `x = 1` inside a loop header (no trailing semicolon). */
  private parseLoopInit(): ast.Statement {
    if (this.isKeyword('var')) {
      const kw = this.next();
      const declarators = this.parseDeclarators(true);
      return {
        kind: 'VarDeclaration',
        declarators,
        taskScoped: false,
        start: kw.start,
        end: this.previousEnd(),
      };
    }
    return this.parseLoopStep();
  }

  /** An assignment without a trailing semicolon, as used in `for` headers. */
  private parseLoopStep(): ast.Statement {
    const start = this.current.start;
    const target = this.parseExpression();
    if (this.current.kind === TokenKind.Operator && ASSIGN_OPS.has(this.current.text)) {
      const op = this.next().text;
      const value = this.parseExpression();
      return {
        kind: 'AssignmentStatement', operator: op, target, value, start, end: this.previousEnd(),
      };
    }
    return { kind: 'ExpressionStatement', expression: target, start, end: this.previousEnd() };
  }

  // --- expressions ----------------------------------------------------------

  parseExpression(): ast.Expression {
    return this.parseConditional();
  }

  private parseConditional(): ast.Expression {
    const test = this.parseBinary(0);
    if (this.isOp('?')) {
      this.next();
      const consequent = this.parseBinary(0);
      if (!this.eatOp(':')) this.error("Expected ':' in a conditional expression");
      const alternate = this.parseConditional();
      return {
        kind: 'ConditionalExpression',
        test,
        consequent,
        alternate,
        start: test.start,
        end: alternate.end,
      };
    }
    return test;
  }

  /** Reads the operator at the cursor, folding the two-word forms. */
  private currentBinaryOperator(): { text: string; width: number } | undefined {
    const t = this.current;
    if (t.kind === TokenKind.Keyword) {
      if (t.lower === 'and' && this.isKeyword('then', 1)) return { text: 'and then', width: 2 };
      if (t.lower === 'or' && this.isKeyword('else', 1)) return { text: 'or else', width: 2 };
      if (t.lower === 'and' || t.lower === 'or' || t.lower === 'xor') return { text: t.lower, width: 1 };
      return undefined;
    }
    if (t.kind === TokenKind.Operator) {
      for (const level of PRECEDENCE) {
        if (level.has(t.text)) return { text: t.text, width: 1 };
      }
    }
    return undefined;
  }

  private parseBinary(level: number): ast.Expression {
    if (level >= PRECEDENCE.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (;;) {
      const op = this.currentBinaryOperator();
      if (!op || !PRECEDENCE[level].has(op.text)) break;
      this.index += op.width;
      const right = this.parseBinary(level + 1);
      left = {
        kind: 'BinaryExpression',
        operator: op.text,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private parseUnary(): ast.Expression {
    const t = this.current;
    if (this.isOp('-') || this.isOp('+') || this.isOp('!') || this.isKeyword('not')) {
      this.next();
      const argument = this.parseUnary();
      return {
        kind: 'UnaryExpression',
        operator: t.kind === TokenKind.Keyword ? 'not' : t.text,
        argument,
        start: t.start,
        end: argument.end,
      };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ast.Expression {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.isPunct('.')) {
        // `.name`, `.name(args)` (method call) or `.(expr)` (computed key)
        if (this.isPunct('(', 1)) {
          this.next();
          this.next();
          const key = this.parseExpression();
          this.expectPunct(')', 'to close a computed key');
          expr = {
            kind: 'ComputedMemberExpression', object: expr, key, start: expr.start, end: this.previousEnd(),
          };
          continue;
        }
        this.next();
        const prop = this.parseIdentifier('a property name');
        if (!prop) break;
        // The method form of a call may name a module explicitly, as in
        // `xmlData.chatUtils::getFormFieldValue(...)`.
        if (this.isOp('::')) {
          this.next();
          const qualified = this.parseIdentifier('a name after ::');
          if (qualified) {
            const args = this.isPunct('(') ? this.parseArguments() : [];
            expr = {
              kind: 'MethodCallExpression',
              object: expr,
              module: prop,
              method: qualified,
              args,
              start: expr.start,
              end: this.previousEnd(),
            };
            continue;
          }
          break;
        }
        if (this.isPunct('(')) {
          const args = this.parseArguments();
          expr = {
            kind: 'MethodCallExpression',
            object: expr,
            method: prop,
            args,
            start: expr.start,
            end: this.previousEnd(),
          };
        } else {
          expr = {
            kind: 'MemberExpression', object: expr, property: prop, start: expr.start, end: prop.end,
          };
        }
        continue;
      }
      if (this.isPunct('[')) {
        this.next();
        const index = this.parseExpression();
        this.expectPunct(']', 'to close an index');
        expr = {
          kind: 'IndexExpression', object: expr, index, start: expr.start, end: this.previousEnd(),
        };
        continue;
      }
      break;
    }
    return expr;
  }

  private parseArguments(): ast.Expression[] {
    const args: ast.Expression[] = [];
    this.expectPunct('(', 'to open an argument list');
    if (!this.isPunct(')')) {
      do {
        args.push(this.parseExpression());
      } while (this.eatPunct(','));
    }
    this.expectPunct(')', 'to close an argument list');
    return args;
  }

  private parsePrimary(): ast.Expression {
    const t = this.current;

    if (t.kind === TokenKind.Number) {
      this.next();
      return { kind: 'Literal', literalKind: 'number', raw: t.text, start: t.start, end: t.end };
    }
    if (t.kind === TokenKind.String) {
      this.next();
      // Data.md #String: "a string can be represented as two or more
      // consecutive strings with zero or more white spaces between them" -
      // adjacent literals concatenate with no operator. Stock code uses this
      // to break long base64 blobs across several lines.
      let raw = t.text;
      let end = t.end;
      while (this.current.kind === TokenKind.String) {
        raw += this.current.text;
        end = this.current.end;
        this.next();
      }
      return { kind: 'Literal', literalKind: 'string', raw, start: t.start, end };
    }
    if (t.kind === TokenKind.Keyword) {
      if (t.lower === 'null' || t.lower === 'true' || t.lower === 'false') {
        this.next();
        return { kind: 'Literal', literalKind: t.lower, raw: t.text, start: t.start, end: t.end };
      }
      if (t.lower === 'spawn') {
        this.next();
        const target = this.parseIdentifier('a code section name after spawn');
        let argument: ast.Expression | undefined;
        if (this.isPunct('(')) {
          this.next();
          if (!this.isPunct(')')) argument = this.parseExpression();
          this.expectPunct(')', 'to close the spawn argument');
        }
        const name: ast.Identifier =
          target ?? { kind: 'Identifier', name: '', lower: '', start: t.end, end: t.end };
        return {
          kind: 'SpawnExpression', target: name, argument, start: t.start, end: this.previousEnd(),
        };
      }
    }
    if (this.isPunct('(')) {
      this.next();
      const inner = this.parseExpression();
      this.expectPunct(')', 'to close a parenthesized expression');
      return { kind: 'ParenExpression', expression: inner, start: t.start, end: this.previousEnd() };
    }
    if (t.kind === TokenKind.Identifier) {
      // `name`, `name(...)`, `module::name`, `module::name(...)`
      if (this.isOp('::', 1) || this.isPunct('(', 1)) {
        const callee = this.parseCodeName();
        if (this.isPunct('(')) {
          const args = this.parseArguments();
          return {
            kind: 'CallExpression', callee, args, start: callee.start, end: this.previousEnd(),
          };
        }
        // A qualified name that is not called is still a reference.
        return callee.module
          ? { kind: 'CallExpression', callee, args: [], start: callee.start, end: callee.end }
          : callee.name;
      }
      this.next();
      return { kind: 'Identifier', name: t.text, lower: t.lower, start: t.start, end: t.end };
    }

    this.error(`Expected an expression, found ${this.describe(t)}`);
    return { kind: 'ErrorExpression', start: t.start, end: t.start };
  }
}

export function parse(source: string): ParseResult {
  const parser = new Parser(source);
  const program = parser.parseProgram();
  return { program, diagnostics: parser.diagnostics };
}

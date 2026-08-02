// AST for CG/PL, shaped after the Formal Syntax table in CGPL.md #Syntax.
//
// Every node carries absolute source offsets so the server can turn any node
// into an LSP range without re-lexing.

export interface Node {
  kind: string;
  start: number;
  end: number;
}

export interface Identifier extends Node {
  kind: 'Identifier';
  name: string;
  /** Lower-cased; CG/PL names are case-insensitive. */
  lower: string;
}

/** `name` or `module::name` (CGPL.md #Modules). */
export interface CodeName extends Node {
  kind: 'CodeName';
  module?: Identifier;
  name: Identifier;
  /** `module::name` lower-cased, or just the name when unqualified. */
  qualified: string;
}

// --- expressions ------------------------------------------------------------

export type Expression =
  | Literal
  | Identifier
  | UnaryExpression
  | BinaryExpression
  | ConditionalExpression
  | CallExpression
  | MethodCallExpression
  | MemberExpression
  | ComputedMemberExpression
  | IndexExpression
  | SpawnExpression
  | ParenExpression
  | ErrorExpression;

export interface Literal extends Node {
  kind: 'Literal';
  /** 'number' | 'string' | 'null' | 'true' | 'false' */
  literalKind: 'number' | 'string' | 'null' | 'true' | 'false';
  raw: string;
}

export interface UnaryExpression extends Node {
  kind: 'UnaryExpression';
  operator: string;
  argument: Expression;
}

export interface BinaryExpression extends Node {
  kind: 'BinaryExpression';
  /** Normalized: `and then` / `or else` keep their two-word spelling. */
  operator: string;
  left: Expression;
  right: Expression;
}

export interface ConditionalExpression extends Node {
  kind: 'ConditionalExpression';
  test: Expression;
  consequent: Expression;
  alternate: Expression;
}

/** `name(args)` or `module::name(args)` */
export interface CallExpression extends Node {
  kind: 'CallExpression';
  callee: CodeName;
  args: Expression[];
}

/**
 * `expr.name(args)` - the method form of a procedure/function call
 * (CGPL.md #Opers). The method name may itself be module-qualified,
 * as in `xmlData.chatUtils::getFormFieldValue("FORM_TYPE")`.
 */
export interface MethodCallExpression extends Node {
  kind: 'MethodCallExpression';
  object: Expression;
  module?: Identifier;
  method: Identifier;
  args: Expression[];
}

/** `expr.name` */
export interface MemberExpression extends Node {
  kind: 'MemberExpression';
  object: Expression;
  property: Identifier;
}

/** `expr.(expr)` - dictionary access by computed key. */
export interface ComputedMemberExpression extends Node {
  kind: 'ComputedMemberExpression';
  object: Expression;
  key: Expression;
}

/** `expr[expr]` */
export interface IndexExpression extends Node {
  kind: 'IndexExpression';
  object: Expression;
  index: Expression;
}

export interface SpawnExpression extends Node {
  kind: 'SpawnExpression';
  target: Identifier;
  argument?: Expression;
}

export interface ParenExpression extends Node {
  kind: 'ParenExpression';
  expression: Expression;
}

/** Emitted where an expression was required but could not be parsed. */
export interface ErrorExpression extends Node {
  kind: 'ErrorExpression';
}

// --- statements -------------------------------------------------------------

export type Statement =
  | EmptyStatement
  | NullStatement
  | StopStatement
  | ReturnStatement
  | ExpressionStatement
  | AssignmentStatement
  | IfStatement
  | LoopStatement
  | VarDeclaration
  | ConstDeclaration
  | ErrorStatement;

export interface EmptyStatement extends Node {
  kind: 'EmptyStatement';
}

export interface NullStatement extends Node {
  kind: 'NullStatement';
}

export interface StopStatement extends Node {
  kind: 'StopStatement';
}

export interface ReturnStatement extends Node {
  kind: 'ReturnStatement';
  argument?: Expression;
}

/** A bare procedure call used as a statement. */
export interface ExpressionStatement extends Node {
  kind: 'ExpressionStatement';
  expression: Expression;
}

export interface AssignmentStatement extends Node {
  kind: 'AssignmentStatement';
  operator: string;
  target: Expression;
  value: Expression;
}

/**
 * One `if`/`elif` branch. It carries the source range of its *body* rather than
 * of the whole branch, because a variable declared inside a block operator
 * exists only in that block (CGPL.md #Variables), and each branch is a separate
 * block: a `var` in the `then` part is not in scope in the `else` part.
 */
export interface IfClause {
  test: Expression;
  body: Statement[];
  /** Just past `then` or `{`. */
  start: number;
  /** At the token that closes the branch - `elif`, `else`, `end` or `}`. */
  end: number;
}

export interface IfStatement extends Node {
  kind: 'IfStatement';
  clauses: IfClause[];
  alternate?: Statement[];
  /** Source range of the `else` body, on the same terms as IfClause. */
  alternateStart?: number;
  alternateEnd?: number;
}

export interface ExitIfClause {
  test: Expression;
  body: Statement[];
}

export interface LoopStatement extends Node {
  kind: 'LoopStatement';
  /** `loop` | `while` | `for` */
  form: 'loop' | 'while' | 'for';
  init?: Statement;
  test?: Expression;
  step?: Statement;
  body: Statement[];
  exitIfs: ExitIfClause[];
}

export interface Declarator {
  name: Identifier;
  init?: Expression;
}

export interface VarDeclaration extends Node {
  kind: 'VarDeclaration';
  declarators: Declarator[];
  /** True when declared outside any code section (a Task variable). */
  taskScoped: boolean;
}

export interface ConstDeclaration extends Node {
  kind: 'ConstDeclaration';
  declarators: Declarator[];
}

export interface ErrorStatement extends Node {
  kind: 'ErrorStatement';
}

// --- top level --------------------------------------------------------------

export type SectionKind = 'entry' | 'procedure' | 'function';
export type SectionBody = 'definition' | 'forward' | 'external';

export interface CodeSection extends Node {
  kind: 'CodeSection';
  sectionKind: SectionKind;
  name: CodeName;
  params: Identifier[];
  bodyKind: SectionBody;
  body: Statement[];
  /** Range covering just the name, for go-to-definition targets. */
  nameStart: number;
  nameEnd: number;
}

export type TopLevel = CodeSection | VarDeclaration | ConstDeclaration | ErrorStatement;

export interface Program extends Node {
  kind: 'Program';
  body: TopLevel[];
}

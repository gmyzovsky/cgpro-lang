// CG/PL lexer. Follows CGPL.md #Lexemes / #Literals.
//
// Design rule for the whole front end: this is a tool that runs over working
// production code, so it must never cry wolf. Where the documentation is
// ambiguous the lexer takes the permissive reading and records the oddity
// rather than rejecting input.

export const enum TokenKind {
  Identifier = 'identifier',
  Keyword = 'keyword',
  Number = 'number',
  String = 'string',
  Operator = 'operator',
  Punctuation = 'punctuation',
  Comment = 'comment',
  EndOfFile = 'eof',
  Unknown = 'unknown',
}

export interface Token {
  kind: TokenKind;
  /** Source text exactly as written (original casing). */
  text: string;
  /** Lower-cased text; keywords and names are case-insensitive in CG/PL. */
  lower: string;
  start: number;
  end: number;
  line: number;
  character: number;
}

export interface LexDiagnostic {
  message: string;
  start: number;
  end: number;
}

export interface LexResult {
  /** Comments are excluded; the parser never needs them. */
  tokens: Token[];
  comments: Token[];
  diagnostics: LexDiagnostic[];
}

// CGPL.md #Lexemes lists the keywords. `const` is missing from that list but
// is documented as a keyword in #Const and is used in real code, so it is
// included here.
export const KEYWORDS: ReadonlySet<string> = new Set([
  'and', 'by', 'const', 'elif', 'else', 'end', 'entry', 'exitif', 'external',
  'false', 'for', 'forward', 'function', 'if', 'is', 'not', 'loop', 'null',
  'or', 'procedure', 'return', 'spawn', 'stop', 'then', 'true', 'var', 'xor',
  'while',
]);

// Longest first: the scanner tries these in order, so `<=` must be attempted
// before `<`, `::` before `:`, and so on.
const OPERATORS: readonly string[] = [
  '+=', '-=', '*=', '/=', '%=', '|=', '&=', '==', '!=', '<=', '>=', '&&', '||',
  '::',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '?', ':',
];

const PUNCTUATION: readonly string[] = ['(', ')', '[', ']', '{', '}', ';', ',', '.'];

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

// CGPL.md: "names - sequences starting with alpha-symbols and optionally
// followed by alpha-symbols, digits, and/or underscore symbols." Real code
// also starts names with `_`, so that is accepted too.
function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

export function tokenize(text: string): LexResult {
  const tokens: Token[] = [];
  const comments: Token[] = [];
  const diagnostics: LexDiagnostic[] = [];

  let pos = 0;
  let line = 0;
  let lineStart = 0;

  const push = (kind: TokenKind, start: number, end: number, tokLine: number, tokChar: number) => {
    const raw = text.slice(start, end);
    const token: Token = {
      kind,
      text: raw,
      lower: raw.toLowerCase(),
      start,
      end,
      line: tokLine,
      character: tokChar,
    };
    if (kind === TokenKind.Comment) comments.push(token);
    else tokens.push(token);
  };

  // Data.md #Syntax: an EOL is "CR and/or LF". Files using lone CR line
  // endings occur in real CG/PL files, so CR alone must terminate a line -
  // otherwise a single line comment swallows the rest of the file.
  const isEol = (i: number) => {
    const c = text.charCodeAt(i);
    return c === 10 || c === 13;
  };

  const advanceLines = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const c = text.charCodeAt(i);
      if (c === 13 && text.charCodeAt(i + 1) === 10) continue; // CRLF counts once, on the LF
      if (c === 10 || c === 13) {
        line++;
        lineStart = i + 1;
      }
    }
  };

  while (pos < text.length) {
    const ch = text[pos];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line++;
        lineStart = pos;
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        line++;
        lineStart = pos + 1;
      }
      pos++;
      continue;
    }

    const tokLine = line;
    const tokChar = pos - lineStart;
    const start = pos;

    // Comments. CGPL.md #Lexemes lists `//` among the signs *and* defines it
    // as the line-comment marker; no operator section ever describes a `//`
    // operation, and treating it as a comment parses the entire stock and
    // production corpus, so comment always wins.
    if (ch === '/' && text[pos + 1] === '/') {
      while (pos < text.length && !isEol(pos)) pos++;
      push(TokenKind.Comment, start, pos, tokLine, tokChar);
      continue;
    }
    if (ch === '/' && text[pos + 1] === '*') {
      pos += 2;
      let closed = false;
      while (pos < text.length) {
        if (text[pos] === '*' && text[pos + 1] === '/') {
          pos += 2;
          closed = true;
          break;
        }
        pos++;
      }
      advanceLines(start, pos);
      if (!closed) diagnostics.push({ message: 'Unterminated block comment', start, end: pos });
      push(TokenKind.Comment, start, pos, tokLine, tokChar);
      continue;
    }

    // Strings
    if (ch === '"') {
      pos++;
      let closed = false;
      while (pos < text.length) {
        const c = text[pos];
        if (c === '\\') {
          // Escapes per Data.md #String: \\ \" \r \n \e \t \NNN \u'XXXX'
          pos += 2;
          continue;
        }
        if (c === '"') {
          pos++;
          closed = true;
          break;
        }
        // A raw line break inside a string is almost certainly a missing
        // closing quote; stop there so one bad line doesn't swallow the file.
        if (c === '\n' || c === '\r') break;
        pos++;
      }
      advanceLines(start, pos);
      if (!closed) diagnostics.push({ message: 'Unterminated string literal', start, end: pos });
      push(TokenKind.String, start, pos, tokLine, tokChar);
      continue;
    }

    // Numbers. CGPL.md #Literals defines a number lexeme as a sequence of
    // digits (values are 64-bit integers). A fractional form is accepted
    // anyway - rejecting it would turn a merely unusual literal into a
    // cascade of parse errors, which is exactly the failure mode to avoid.
    if (isDigit(ch)) {
      while (pos < text.length && isDigit(text[pos])) pos++;
      if (text[pos] === '.' && isDigit(text[pos + 1])) {
        pos++;
        while (pos < text.length && isDigit(text[pos])) pos++;
      }
      push(TokenKind.Number, start, pos, tokLine, tokChar);
      continue;
    }

    // Identifiers and keywords
    if (isIdentStart(ch)) {
      while (pos < text.length && isIdentPart(text[pos])) pos++;
      const word = text.slice(start, pos).toLowerCase();
      push(KEYWORDS.has(word) ? TokenKind.Keyword : TokenKind.Identifier, start, pos, tokLine, tokChar);
      continue;
    }

    // Operators
    let matched = false;
    for (const op of OPERATORS) {
      if (text.startsWith(op, pos)) {
        pos += op.length;
        push(TokenKind.Operator, start, pos, tokLine, tokChar);
        matched = true;
        break;
      }
    }
    if (matched) continue;

    if (PUNCTUATION.includes(ch)) {
      pos++;
      push(TokenKind.Punctuation, start, pos, tokLine, tokChar);
      continue;
    }

    // Anything else (a stray backtick, a non-ASCII symbol outside a string).
    pos++;
    diagnostics.push({ message: `Unexpected character ${JSON.stringify(ch)}`, start, end: pos });
    push(TokenKind.Unknown, start, pos, tokLine, tokChar);
  }

  tokens.push({
    kind: TokenKind.EndOfFile,
    text: '',
    lower: '',
    start: text.length,
    end: text.length,
    line,
    character: text.length - lineStart,
  });

  return { tokens, comments, diagnostics };
}

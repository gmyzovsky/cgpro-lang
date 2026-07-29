// Loads the docs-derived built-in database produced by
// tools/extract-builtins.mjs. Nothing here is hand-maintained: when
// documentation gains a function, re-running the extractor is the whole
// update. See README "How the grammars are built".

import { readFileSync } from 'fs';
import * as path from 'path';

export interface Builtin {
  name: string;
  signatures: string[];
  params: string[];
  doc: string;
  anchor: string | null;
  /** Which environment provides it - shown in hover, drives completion order. */
  category: BuiltinCategory;
  /**
   * Argument counts. Absent for entries known only from prose, where no
   * reliable arity exists - those are never arity-checked.
   */
  minArgs?: number;
  maxArgs?: number;
  /** True for functions (return a value), false for procedures. */
  isFunction?: boolean;
  /** Where the entry came from: the documentation, the registry, or both. */
  source?: 'docs' | 'registry' | 'both';
}

export type BuiltinCategory = 'cgpl' | 'pbxapp' | 'webapp';

const CATEGORY_LABEL: Record<BuiltinCategory, string> = {
  cgpl: 'CG/PL built-in',
  pbxapp: 'Real-Time (PBXApp) built-in',
  webapp: 'Web Application built-in',
};

// The published developer documentation.
const DOC_URL: Record<BuiltinCategory, string> = {
  cgpl: 'https://doc.communigatepro.ru/development/CGPL.html',
  pbxapp: 'https://doc.communigatepro.ru/development/PBXApp.html',
  webapp: 'https://doc.communigatepro.ru/development/WebApp.html',
};

interface RawEntry {
  name: string;
  signatures: string[];
  params?: string[];
  doc?: string;
  anchor?: string | null;
  minArgs?: number;
  maxArgs?: number;
  isFunction?: boolean;
  source?: 'docs' | 'registry' | 'both';
}

let byLowerName: Map<string, Builtin> | undefined;

function load(): Map<string, Builtin> {
  if (byLowerName) return byLowerName;
  const map = new Map<string, Builtin>();
  // out/ sits one level below server/, and tools/ is a sibling of server/.
  const file = path.resolve(__dirname, '../../tools/builtins.json');
  let raw: Record<string, RawEntry[]>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    byLowerName = map;
    return map;
  }
  for (const category of ['cgpl', 'pbxapp', 'webapp'] as BuiltinCategory[]) {
    for (const entry of raw[category] ?? []) {
      // CG/PL names are case-insensitive, so the index is keyed lower-cased.
      // First category wins on the rare cross-environment duplicate.
      const key = entry.name.toLowerCase();
      if (map.has(key)) continue;
      map.set(key, {
        name: entry.name,
        signatures: entry.signatures ?? [],
        params: entry.params ?? [],
        doc: entry.doc ?? '',
        anchor: entry.anchor ?? null,
        category,
        minArgs: entry.minArgs,
        maxArgs: entry.maxArgs,
        isFunction: entry.isFunction,
        source: entry.source,
      });
    }
  }
  byLowerName = map;
  return map;
}

export function lookupBuiltin(name: string): Builtin | undefined {
  return load().get(name.toLowerCase());
}

export function allBuiltins(): Builtin[] {
  return [...load().values()];
}

/** Markdown for a hover popup. */
export function builtinHover(b: Builtin): string {
  const signature = b.signatures[0] ?? `${b.name}()`;
  const overloads = b.signatures.slice(1);
  const kind = b.isFunction === false ? 'procedure' : 'function';
  const lines = [
    '```cgpl',
    signature,
    ...overloads,
    '```',
    '',
    `*${CATEGORY_LABEL[b.category]} ${kind}*`,
  ];
  if (b.minArgs !== undefined && b.maxArgs !== undefined) {
    const arity =
      b.minArgs === b.maxArgs
        ? `${b.minArgs} argument${b.minArgs === 1 ? '' : 's'}`
        : `${b.minArgs}–${b.maxArgs} arguments`;
    lines.push('', `Takes ${arity}.`);
  }
  if (b.doc) lines.push('', b.doc);
  if (b.source === 'registry') {
    // Be explicit rather than silently presenting a bare name as if it were
    // documented.
    lines.push('', '*Not covered by the published CommuniGate Pro documentation.*');
  } else {
    const anchor = b.anchor ? `#${b.anchor}` : '';
    lines.push('', `[Documentation](${DOC_URL[b.category]}${anchor})`);
  }
  return lines.join('\n');
}

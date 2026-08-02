#!/usr/bin/env node
// Drives the language server over a real stdio LSP connection and checks the
// responses. Compiling is not evidence that a server works; this is the
// closest thing to opening the editor that can run headless.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, '../server/out/server.js');

const SAMPLE = `// sample used by the smoke test
var taskWide;

procedure helper(a, b) is
  SysLog(a);
end procedure;

entry main is
  var local1 = 1, local2;
  helper(local1, 2);
  SysLog("hello");
  local2 = Substring("abcdef", 1, 2);
  BogusFunctionName(1);
  SysLog();
end entry;
`;

// The module fixtures live beside the sample on purpose: an external-declaration
// resolves to a sibling file, and bridgedloophash.sppi is deliberately spelled
// in lower case while the function is not, which is how stock CommuniGate Pro
// scripts are written and the case a constructed file name gets wrong on Linux.
const MODULE = `function bridgedLoopHash(peerLeg, finishTime) {
  return peerLeg;
}
`;

const QUALIFIED_MODULE = `function sharedTools::formatLeg(leg) is
  return String(leg);
end function;
`;

const CALLER = `function bridgedLoopHash(peerLeg, finishTime) external;
function sharedTools::formatLeg(leg) external;
function noSuchModule(x) external;

entry dispatch is
  Void(bridgedLoopHash("leg", null));
  Void(sharedTools::formatLeg("leg"));
  Void(noSuchModule(1));
end entry;
`;

// Same module name in two environments. A .wcgp caller has to reach the .wcgi
// half of the pair: that is the only file its Skin would actually load, and
// picking the .sppi would be answering with another application's code.
const WEB_CALLER = `function sharedThing(x) external;

entry main {
  Void(sharedThing(1));
}
`;
const WEB_MODULE = `function sharedThing(x) {
  return x;
}
`;
const RTA_MODULE = `function sharedThing(x) is
  return null;
end function;
`;

// Lexical scope. CGPL.md #Variables: a variable declared inside a "block
// operator" (if, loop) is declared only inside that block, and variables are
// used after they are declared. Both dialects, both branches, and a name
// shadowed by an inner declaration.
const SCOPES = `var taskWide;

procedure branches(arg) is
  var shadowed = "outer";
  for var index = 0 while index < 10 by index += 1 loop
    var inLoop = index;
    SysLog(inLoop);
  end loop;
  if arg == null then
    var shadowed = "inner";
    SysLog(shadowed);
  else
    var inElse = 1;
    SysLog(inElse);
  end if;
  SysLog(shadowed);
  var declaredLast = 1;
end procedure;

procedure braced(p) {
  if (p) {
    var inBrace = 1;
    SysLog(inBrace);
  }
}
`;

const dir = mkdtempSync(path.join(tmpdir(), 'cgpl-smoke-'));
const toUri = (f) => `file://${f.split('/').map(encodeURIComponent).join('/')}`;

const file = path.join(dir, 'sample.sppr');
writeFileSync(file, SAMPLE);
const uri = toUri(file);

const modulePath = path.join(dir, 'bridgedloophash.sppi');
const qualifiedModulePath = path.join(dir, 'sharedtools.sppi');
const callerPath = path.join(dir, 'servicedispatcher.sppi');
writeFileSync(modulePath, MODULE);
writeFileSync(qualifiedModulePath, QUALIFIED_MODULE);
writeFileSync(callerPath, CALLER);
const callerUri = toUri(callerPath);

const webCallerPath = path.join(dir, 'webcaller.wcgp');
const webModulePath = path.join(dir, 'sharedthing.wcgi');
writeFileSync(webCallerPath, WEB_CALLER);
writeFileSync(webModulePath, WEB_MODULE);
writeFileSync(path.join(dir, 'sharedthing.sppi'), RTA_MODULE);
const webCallerUri = toUri(webCallerPath);

// Synchronous scripts are the third pair, .scgp/.scgi, and the one whose
// include extension the project used to leave out entirely.
const scriptCallerPath = path.join(dir, 'runner.scgp');
const scriptModulePath = path.join(dir, 'scripthelper.scgi');
writeFileSync(scriptCallerPath, 'function scriptHelper(x) external;\n\nentry main {\n  Void(scriptHelper(1));\n}\n');
writeFileSync(scriptModulePath, 'function scriptHelper(x) {\n  return x;\n}\n');
const scriptCallerUri = toUri(scriptCallerPath);

const scopesPath = path.join(dir, 'scopes.sppr');
writeFileSync(scopesPath, SCOPES);
const scopesUri = toUri(scopesPath);

const child = spawn(process.execPath, [serverPath, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = Buffer.alloc(0);
const pending = new Map();
const notifications = [];
const waiters = [];
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString('ascii');
    const m = /Content-Length: (\d+)/i.exec(header);
    if (!m) return;
    const length = Number(m[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = JSON.parse(buffer.slice(bodyStart, bodyStart + length).toString('utf8'));
    buffer = buffer.slice(bodyStart + length);
    if (body.id !== undefined && pending.has(body.id)) {
      pending.get(body.id)(body.result);
      pending.delete(body.id);
    } else if (body.method) {
      notifications.push(body);
      for (const [predicate, resolve] of [...waiters]) {
        if (predicate(body)) {
          waiters.splice(waiters.indexOf([predicate, resolve]), 1);
          resolve(body);
        }
      }
    }
  }
});

child.stderr.on('data', (d) => process.stderr.write(`[server stderr] ${d}`));

function send(message) {
  const json = JSON.stringify({ jsonrpc: '2.0', ...message });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method, params });
  });
}

function notify(method, params) {
  send({ method, params });
}

function waitForNotification(method, timeoutMs = 5000) {
  const existing = notifications.find((n) => n.method === method);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const predicate = (n) => n.method === method;
    const entry = [predicate, resolve];
    waiters.push(entry);
    setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
  });
}

/** Offset of `needle` in `text`, as an LSP position. */
function positionIn(text, needle, occurrence = 1) {
  let index = -1;
  for (let i = 0; i < occurrence; i++) index = text.indexOf(needle, index + 1);
  const before = text.slice(0, index);
  const line = before.split('\n').length - 1;
  return { line, character: index - (before.lastIndexOf('\n') + 1) };
}

const positionOf = (needle, occurrence = 1) => positionIn(SAMPLE, needle, occurrence);

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
    failures++;
  }
};

try {
  const init = await request('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
  console.log('initialize:');
  check('declares documentSymbolProvider', init.capabilities.documentSymbolProvider === true);
  check('declares definitionProvider', init.capabilities.definitionProvider === true);
  check('declares hoverProvider', init.capabilities.hoverProvider === true);
  check('declares completionProvider', !!init.capabilities.completionProvider);
  check('declares signatureHelpProvider', !!init.capabilities.signatureHelpProvider);
  notify('initialized', {});

  notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'cgpl', version: 1, text: SAMPLE },
  });

  console.log('\ndiagnostics:');
  const diagNote = await waitForNotification('textDocument/publishDiagnostics');
  const diags = diagNote.params.diagnostics;
  const messages = diags.map((d) => d.message);
  check('reports the unknown call', messages.some((m) => m.includes('BogusFunctionName')), messages.join(' | '));
  check('reports the arity error', messages.some((m) => m.includes('SysLog takes 1 argument')), messages.join(' | '));
  check('reports nothing else', diags.length === 2, `${diags.length} diagnostics: ${messages.join(' | ')}`);

  console.log('\ndocument symbols:');
  const symbols = await request('textDocument/documentSymbol', { textDocument: { uri } });
  const names = symbols.map((s) => s.name);
  check('lists the task variable', names.includes('taskWide'), names.join(', '));
  check('lists the procedure', names.includes('helper'), names.join(', '));
  check('lists the entry', names.includes('main'), names.join(', '));
  const mainSym = symbols.find((s) => s.name === 'main');
  const childNames = (mainSym?.children ?? []).map((c) => c.name);
  check('nests locals under the entry', childNames.includes('local1') && childNames.includes('local2'),
    childNames.join(', '));
  const helperSym = symbols.find((s) => s.name === 'helper');
  check('nests parameters under the procedure',
    (helperSym?.children ?? []).map((c) => c.name).join(',') .includes('a'),
    (helperSym?.children ?? []).map((c) => c.name).join(', '));

  console.log('\ngo to definition:');
  const def = await request('textDocument/definition', {
    textDocument: { uri },
    position: positionOf('helper(local1', 1),
  });
  check('jumps to the procedure declaration', def && def.range.start.line === positionOf('procedure helper').line,
    JSON.stringify(def?.range));

  const varDef = await request('textDocument/definition', {
    textDocument: { uri },
    position: positionOf('local1, 2', 1),
  });
  check('jumps to a local variable', varDef && varDef.range.start.line === positionOf('var local1').line,
    JSON.stringify(varDef?.range));

  console.log('\nexternal modules:');
  notify('textDocument/didOpen', {
    textDocument: { uri: callerUri, languageId: 'cgpl', version: 1, text: CALLER },
  });

  // The unqualified form: the module name IS the section name, so the call
  // has to leave this file for bridgedloophash.sppi.
  const externalDef = await request('textDocument/definition', {
    textDocument: { uri: callerUri },
    position: positionIn(CALLER, 'bridgedLoopHash("leg"'),
  });
  check('follows an unqualified external to its module', externalDef?.uri === toUri(modulePath),
    JSON.stringify(externalDef));
  check('lands on the definition, not the declaration',
    externalDef?.range.start.line === positionIn(MODULE, 'bridgedLoopHash').line,
    JSON.stringify(externalDef?.range));

  // Standing on the declaration itself has to do the same thing; jumping to
  // the line under the cursor would be no answer at all.
  const fromDeclaration = await request('textDocument/definition', {
    textDocument: { uri: callerUri },
    position: positionIn(CALLER, 'bridgedLoopHash(peerLeg'),
  });
  check('follows it from the declaration too', fromDeclaration?.uri === toUri(modulePath),
    JSON.stringify(fromDeclaration));

  const qualifiedDef = await request('textDocument/definition', {
    textDocument: { uri: callerUri },
    position: positionIn(CALLER, 'sharedTools::formatLeg("leg")'),
  });
  check('follows a qualified external to its module', qualifiedDef?.uri === toUri(qualifiedModulePath),
    JSON.stringify(qualifiedDef));

  // No module on disk is the normal state of a half-written application. The
  // declaration is still a useful answer, and it must not be a crash.
  const missingDef = await request('textDocument/definition', {
    textDocument: { uri: callerUri },
    position: positionIn(CALLER, 'noSuchModule(1)'),
  });
  check('falls back to the declaration when the module is missing',
    missingDef?.uri === callerUri && missingDef?.range.start.line === positionIn(CALLER, 'noSuchModule(x)').line,
    JSON.stringify(missingDef));

  const callerDiags = notifications
    .filter((n) => n.method === 'textDocument/publishDiagnostics' && n.params.uri === callerUri)
    .pop();
  check('does not call an external declaration an unknown call',
    (callerDiags?.params.diagnostics ?? []).length === 0,
    JSON.stringify(callerDiags?.params.diagnostics));

  notify('textDocument/didOpen', {
    textDocument: { uri: webCallerUri, languageId: 'cgpl', version: 1, text: WEB_CALLER },
  });
  const webDef = await request('textDocument/definition', {
    textDocument: { uri: webCallerUri },
    position: positionIn(WEB_CALLER, 'sharedThing(1)'),
  });
  check('prefers the module extension of the calling environment', webDef?.uri === toUri(webModulePath),
    JSON.stringify(webDef));

  const scriptText = 'function scriptHelper(x) external;\n\nentry main {\n  Void(scriptHelper(1));\n}\n';
  notify('textDocument/didOpen', {
    textDocument: { uri: scriptCallerUri, languageId: 'cgpl', version: 1, text: scriptText },
  });
  const scriptDef = await request('textDocument/definition', {
    textDocument: { uri: scriptCallerUri },
    position: positionIn(scriptText, 'scriptHelper(1)'),
  });
  check('resolves a synchronous script module (.scgi)', scriptDef?.uri === toUri(scriptModulePath),
    JSON.stringify(scriptDef));

  console.log('\nhover:');
  const hover = await request('textDocument/hover', {
    textDocument: { uri },
    position: positionOf('Substring('),
  });
  const hoverText = hover?.contents?.value ?? '';
  check('describes a built-in', hoverText.includes('Substring'), hoverText.slice(0, 80));
  check('includes the documentation prose', /substring of the/i.test(hoverText), hoverText.slice(0, 200));
  check('states the argument count', /Takes 3 arguments/.test(hoverText), hoverText.slice(0, 200));

  const hoverLocal = await request('textDocument/hover', {
    textDocument: { uri },
    position: positionOf('helper(local1', 1),
  });
  check('describes a local procedure', (hoverLocal?.contents?.value ?? '').includes('procedure helper(a, b)'),
    hoverLocal?.contents?.value);

  console.log('\ncompletion:');
  const completion = await request('textDocument/completion', {
    textDocument: { uri },
    position: positionOf('SysLog("hello")'),
  });
  const items = completion.items ?? completion;
  const labels = items.map((i) => i.label);
  check('offers built-ins', labels.includes('SysLog'), `${labels.length} items`);
  check('offers local sections', labels.includes('helper'), `${labels.length} items`);
  check('offers task variables', labels.includes('taskWide'), `${labels.length} items`);
  check('offers undocumented built-ins too', labels.includes('TextToObject'), `${labels.length} items`);
  check('sorts locals above built-ins',
    (items.find((i) => i.label === 'helper')?.sortText ?? 'z') <
      (items.find((i) => i.label === 'SysLog')?.sortText ?? 'a'));

  // A qualified name is one name written in two halves. Every handler has to
  // put them back together: the section table is keyed on `module::name`, so
  // looking a section up by whichever half the cursor is on finds nothing.
  console.log('\nqualified names:');
  const qualifiedHover = await request('textDocument/hover', {
    textDocument: { uri: callerUri },
    position: positionIn(CALLER, 'formatLeg(leg) external'),
  });
  check('hovers a qualified declaration',
    (qualifiedHover?.contents?.value ?? '').includes('sharedTools::formatLeg(leg)'),
    JSON.stringify(qualifiedHover));

  const qualifiedModuleHalfHover = await request('textDocument/hover', {
    textDocument: { uri: callerUri },
    position: positionIn(CALLER, 'sharedTools::formatLeg(leg)'),
  });
  check('hovers it from the module half too',
    (qualifiedModuleHalfHover?.contents?.value ?? '').includes('sharedTools::formatLeg(leg)'),
    JSON.stringify(qualifiedModuleHalfHover));

  const qualifiedFromDeclaration = await request('textDocument/definition', {
    textDocument: { uri: callerUri },
    position: positionIn(CALLER, 'formatLeg(leg) external'),
  });
  check('follows a qualified external from its declaration',
    qualifiedFromDeclaration?.uri === toUri(qualifiedModulePath),
    JSON.stringify(qualifiedFromDeclaration));

  const qualifiedCallPosition = positionIn(CALLER, 'sharedTools::formatLeg("leg")');
  const qualifiedSig = await request('textDocument/signatureHelp', {
    textDocument: { uri: callerUri },
    position: {
      line: qualifiedCallPosition.line,
      character: qualifiedCallPosition.character + 'sharedTools::formatLeg('.length,
    },
  });
  check('gives signature help at a qualified call',
    (qualifiedSig?.signatures?.[0]?.label ?? '') === 'sharedTools::formatLeg(leg)',
    JSON.stringify(qualifiedSig));

  // CGPL.md #Variables. Nothing here is a diagnostic - out-of-scope names are
  // hidden from completion and left unresolved, never reported as errors.
  console.log('\nblock scope:');
  notify('textDocument/didOpen', {
    textDocument: { uri: scopesUri, languageId: 'cgpl', version: 1, text: SCOPES },
  });
  const scopePosition = (needle, occurrence = 1) => positionIn(SCOPES, needle, occurrence);
  const scopeDefinition = (needle, occurrence = 1) =>
    request('textDocument/definition', {
      textDocument: { uri: scopesUri },
      position: scopePosition(needle, occurrence),
    });

  const inThenBranch = await request('textDocument/completion', {
    textDocument: { uri: scopesUri },
    position: scopePosition('SysLog(shadowed)', 1),
  });
  const inThenLabels = (inThenBranch.items ?? inThenBranch).map((i) => i.label);
  check('offers the branch-local variable', inThenLabels.includes('shadowed'), inThenLabels.length + ' items');
  check('offers the parameter', inThenLabels.includes('arg'));
  check('offers the task variable', inThenLabels.includes('taskWide'));
  check('hides the other branch', !inThenLabels.includes('inElse'), inThenLabels.join(', '));
  check('hides a variable local to the loop', !inThenLabels.includes('inLoop'));
  check('hides a variable declared further down', !inThenLabels.includes('declaredLast'));
  check('still offers built-ins', inThenLabels.includes('SysLog'));

  const innerShadow = await scopeDefinition('shadowed);', 1);
  check('resolves a shadowed name to the inner declaration',
    innerShadow?.range.start.line === scopePosition('shadowed = "inner"').line,
    JSON.stringify(innerShadow?.range));
  const outerShadow = await scopeDefinition('shadowed);', 2);
  check('resolves it to the outer declaration once the branch has closed',
    outerShadow?.range.start.line === scopePosition('shadowed = "outer"').line,
    JSON.stringify(outerShadow?.range));

  const loopLocal = await scopeDefinition('inLoop);');
  check('resolves a loop-body variable inside the loop',
    loopLocal?.range.start.line === scopePosition('inLoop = index').line, JSON.stringify(loopLocal?.range));
  const loopHeaderVar = await scopeDefinition('index;');
  check('resolves the loop header variable in the body',
    loopHeaderVar?.range.start.line === scopePosition('index = 0').line, JSON.stringify(loopHeaderVar?.range));
  const braceLocal = await scopeDefinition('inBrace);');
  check('resolves a variable declared in a brace-dialect block',
    braceLocal?.range.start.line === scopePosition('inBrace = 1').line, JSON.stringify(braceLocal?.range));

  const scopeDiagnostics = notifications
    .filter((n) => n.method === 'textDocument/publishDiagnostics' && n.params.uri === scopesUri)
    .pop();
  check('reports no diagnostics on any of it',
    (scopeDiagnostics?.params.diagnostics ?? []).length === 0,
    JSON.stringify(scopeDiagnostics?.params.diagnostics));

  console.log('\nsignature help:');
  const sig = await request('textDocument/signatureHelp', {
    textDocument: { uri },
    position: { line: positionOf('Substring("abcdef", 1, 2)').line, character: positionOf('Substring("abcdef", 1, 2)').character + 'Substring("abcdef", '.length },
  });
  check('returns a signature', (sig?.signatures?.length ?? 0) > 0, JSON.stringify(sig));
  check('labels it correctly', (sig?.signatures?.[0]?.label ?? '').startsWith('Substring('),
    sig?.signatures?.[0]?.label);
  check('tracks the active parameter', sig?.activeParameter === 1, `activeParameter=${sig?.activeParameter}`);

  await request('shutdown', null);
  notify('exit', null);
} catch (err) {
  console.error('smoke test error:', err);
  failures++;
} finally {
  child.kill();
}

console.log(failures === 0 ? '\nall LSP smoke checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);

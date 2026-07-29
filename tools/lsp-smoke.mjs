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

const dir = mkdtempSync(path.join(tmpdir(), 'cgpl-smoke-'));
const file = path.join(dir, 'sample.sppr');
writeFileSync(file, SAMPLE);
const uri = `file://${file.split('/').map(encodeURIComponent).join('/')}`;

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

/** Offset of `needle` in SAMPLE, as an LSP position. */
function positionOf(needle, occurrence = 1) {
  let index = -1;
  for (let i = 0; i < occurrence; i++) index = SAMPLE.indexOf(needle, index + 1);
  const before = SAMPLE.slice(0, index);
  const line = before.split('\n').length - 1;
  return { line, character: index - (before.lastIndexOf('\n') + 1) };
}

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

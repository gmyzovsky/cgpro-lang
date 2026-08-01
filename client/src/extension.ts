// VSCode client: starts the CG/PL language server and connects it to the
// cgpl language. The extension has no other behaviour - syntax highlighting
// comes from the TextMate grammar declared in package.json, and everything
// interactive comes from the server.

import * as path from 'path';
import { ExtensionContext, workspace } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
  const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'cgpl' }],
    synchronize: {
      configurationSection: 'cgpl',
      fileEvents: workspace.createFileSystemWatcher('**/*.{sppi,sppr,wcgp,wcgi,scgp,scgi}'),
    },
  };

  client = new LanguageClient('cgpl', 'CommuniGate Pro CG/PL', serverOptions, clientOptions);
  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

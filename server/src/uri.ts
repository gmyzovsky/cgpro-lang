// Minimal file: URI handling. The full vscode-uri package would work too, but
// go-to-definition across module files is the only place the server touches
// the file system, and this keeps the dependency list to the LSP libraries.

import * as path from 'path';

export const URI = {
  /** file:///a/b%20c.sppi -> /a/b c.sppi */
  toFsPath(uri: string): string {
    if (!uri.startsWith('file://')) return uri;
    const withoutScheme = uri.slice('file://'.length);
    // On POSIX the authority is empty, so the path starts at the first slash.
    const decoded = decodeURIComponent(withoutScheme);
    return path.normalize(decoded);
  },

  /** /a/b c.sppi -> file:///a/b%20c.sppi */
  fromFsPath(fsPath: string): string {
    const normalized = fsPath.replace(/\\/g, '/');
    const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
    // Encode each segment so spaces and non-ASCII survive, but keep the
    // separators intact.
    const encoded = withLeadingSlash.split('/').map(encodeURIComponent).join('/');
    return `file://${encoded}`;
  },
};

# cgpro-lang

Syntax highlighting for [CommuniGate Pro](https://www.communigate.com)'s procedural languages:

- **CG/PL** — the core scripting language (`.wcgp`, `.wcgi`, `.sppr`, `.sppi`, `.scgp`), including its PBXApp
  (Real-Time Application) and WebApp built-in function extensions
- **WSSP** — the web template language (`.wssp`, `.wssi`)
- **CGPro Data** — the `{key = value;}` literal format used by `.data`/`.settings` files

Highlighting is shipped as both a VSCode extension and a JetBrains IDE plugin, built from a single shared
grammar source. On top of that, VSCode also gets a language server: syntax diagnostics, an outline,
go-to-definition, completion, hover and signature help.

## Install

### VSCode

This repository's root *is* the VSCode extension. It bundles the language server, which runs locally as a
child process and talks to the editor over stdio - no network access, no telemetry. Package and install it:

```sh
npm install
npm run build          # regenerate grammars, then compile the server and client
npx @vscode/vsce package
code --install-extension cgpro-lang-0.1.0.vsix
```

### JetBrains IDEs (IntelliJ IDEA, CLion, WebStorm, PyCharm, ...)

Requires two plugins: the bundled **TextMate** one, enabled by default everywhere, and
[**LSP4IJ**](https://plugins.jetbrains.com/plugin/23257-lsp4ij) from the Marketplace, which the language server
runs behind. Install LSP4IJ first, or the IDE will refuse to load this plugin.

The server itself is Node, and the plugin ships it but not a runtime, so **Node.js 18 or newer** has to be
installed for anything beyond highlighting. It is looked up on `PATH` first, then in the usual Homebrew, nvm,
fnm, Volta and asdf locations. If yours is somewhere else, name it in `Help -> Edit Custom VM Options`:

```properties
-Dcgpro.lang.nodePath=/path/to/node
```

Build the plugin against the compiled server:

```sh
npm install && npm run build          # produces the server the plugin ships
cd jetbrains-plugin
JAVA_HOME=<path to a JDK 21 install> ./gradlew buildPlugin
```

Then in your IDE: `Settings -> Plugins -> ⚙ -> Install Plugin from Disk...` and pick
`jetbrains-plugin/build/distributions/cgpro-lang-0.1.0.zip`.

To check the server came up, open `LSP Consoles` in the tool window bar - LSP4IJ lists **CommuniGate Pro CG/PL**
there with its traffic, and any startup failure is reported in that console rather than silently.

> `.data`/`.settings` are generic extensions other plugins may also claim. If highlighting doesn't kick in for
> those specifically, check `Settings -> Editor -> File Types` for a conflicting association.

#### Built-in functions look unhighlighted in JetBrains? Set one color.

JetBrains IDEs do not let a TextMate grammar carry its own colors: the platform maps scopes to IDE color keys
through a hardcoded table (`TextMateDefaultColorsProvider`), and `textmate.bundleProvider` is the only extension
point - a plugin cannot extend that table. The relevant entries are:

| grammar scope | used for | IDE color key | Darcula default |
| --- | --- | --- | --- |
| `entity.name.function` | the name in `entry X`, `procedure X(...)`, `function X(...)` | Function declaration | yellow |
| `support.function` | every call site, whether built-in or your own | Function call | **no color - plain text** |

That split mirrors what the IDE already does for C++, where a definition and a call are coloured differently.
The consequence is that out of the box in Darcula every call renders as plain text - again exactly like C++.
Fix it once in `Settings -> Editor -> Color Scheme -> Language Defaults -> Identifiers -> Function call` (tick
Foreground, pick a colour), and calls light up in CG/PL and in every other language that leaves the key alone.

## How the grammars are built

The source of truth for built-in function names is the published developer documentation at
[doc.communigatepro.ru/development](https://doc.communigatepro.ru/development/) - specifically
[CGPL](https://doc.communigatepro.ru/development/CGPL.html),
[PBXApp](https://doc.communigatepro.ru/development/PBXApp.html),
[WebApp](https://doc.communigatepro.ru/development/WebApp.html),
[WSSP](https://doc.communigatepro.ru/development/WSSP.html) and
[Data](https://doc.communigatepro.ru/development/Data.html). Nothing is hand-copied, and the whole chain runs
from those public pages - a network connection is the only prerequisite:

```sh
npm run fetch:docs                # download the pages above into ./docs
npm run extract:builtins          # docs -> tools/builtins.json
npm run build:grammars            # builtins.json + hand-authored grammar shape -> syntaxes/*.tmLanguage.json
```

`tools/builtins.json` is checked in, so building the extension, the server or the JetBrains plugin needs no
documentation at all; fetching and extracting is only needed to refresh it. The extractor accepts either the
published HTML or a local Markdown copy of the same pages - set `CGPRO_DOCS_ROOT` to point at either.

`tools/builtins-registry.json` is the full roster of built-ins the server provides - every one of them, not
just the obscure ones - recording each function's argument counts and whether it is a function or a procedure.
It exists because the documentation states argument counts nowhere, and because a number of built-ins are not
described on any page. The extractor merges it with the documentation: the roster supplies existence and arity,
the pages supply the descriptions. Entries the documentation does not cover are labelled as undocumented in
their hover rather than posing as documented, and no documentation link is offered for them.

Some built-ins are two names for the same thing - the `ReadSiteFile` / `ReadStorageFile` family and its
neighbours - where only one name of the pair is documented. The roster records the pairing in an `aliasOf`
field, and the alias then borrows its twin's parameters, description and documentation link instead of
showing nothing. The two names always agree on argument count, which is what makes the pairing checkable.

Names in the roster follow the documentation's spelling wherever a page describes the function; CG/PL is
case-insensitive, so this is cosmetic, but mixed spellings for neighbouring functions read like a defect. The
few that stay upper-cased are the ones no page describes, where there is no spelling to follow.

The grammar *shape* itself (keywords, both CG/PL syntax dialects, operator precedence, string/number/comment
lexemes, the WSSP `%%...%%`/`<!--%%...-->` injection structure) is hand-authored in `tools/build-grammars.mjs`
from the Formal Syntax section of the CG/PL page and the Formal Syntax Rules of the Data page - only the
function-name lists are generated. When the documentation gains or renames a built-in, re-running both scripts
picks it up; nothing else needs touching.

`syntaxes/*.tmLanguage.json` is the **only** grammar artifact - both the VSCode extension (via `package.json`'s
`contributes.grammars`) and the JetBrains plugin (via `TextMateBundleProvider`, copied into a `.tmbundle` layout
at Gradle build time) load the exact same files. There is no separate JetBrains-flavored grammar to keep in sync.

## Validation

The grammars and the parser are both checked against a corpus of real CG/PL rather than against hand-written
samples. Point `CGPRO_CORPUS` at a directory of genuine `.wcgp`/`.sppr`/`.wssp`/… files - the scripts that ship
with a CommuniGate Pro installation work well, as does any body of working application code.

`tools/validate.mjs` tokenizes every file in the corpus with the real oniguruma-backed `vscode-textmate` engine -
the same engine VSCode uses - and reports tokenizer exceptions plus lines that end up completely unscoped (a
heuristic for "the grammar doesn't recognize this construct"). On a corpus of ~830 files / ~100k lines it reports
0 exceptions and 0.03% unscoped lines, all of them plain HTML prose unrelated to CG/PL or WSSP syntax.

`tools/parse-corpus.mjs <dir>...` runs the parser over the same material. The bar there is absolute: working code
must produce **zero** diagnostics, so every diagnostic is a parser bug until proven otherwise. A language tool
that flags correct code is worse than no tool, because people learn to ignore it.

`tools/parser-sanity.mjs` guards the opposite failure - a parser so permissive it reports zero errors because it
accepts anything - by asserting that the AST comes out populated, that deliberately broken code is still
rejected, and that both syntax dialects parse.

```sh
CGPRO_CORPUS=/path/to/scripts npm run validate
CGPRO_CORPUS=/path/to/scripts npm run validate:parser
node tools/parse-corpus.mjs /path/to/scripts
```

`tools/dump-tokens.mjs <scopeName> '<line>'` is a quick way to spot-check what scopes a specific line resolves
to, e.g. `node tools/dump-tokens.mjs source.cgpl 'if AcceptCall() != null then stop; end if;'`.

`tools/vendor/text.html.basic.tmLanguage.json` is a vendored copy of VSCode's HTML grammar
([microsoft/vscode](https://github.com/microsoft/vscode), MIT, itself derived from `textmate/html.tmbundle`) -
used only so the WSSP grammar's `text.html.basic` include resolves during standalone validation. It is not shipped
in the extension or plugin; real VSCode/JetBrains installs already provide an HTML grammar.

## Repository layout

```
package.json                    VSCode extension manifest (also the npm package.json)
language-configuration/         comments/brackets/autoclose per language
syntaxes/                       generated TextMate grammars (shared by both editors)
server/                         the CG/PL language server: lexer, parser, analyzer, LSP wiring
client/                         VSCode client that launches the server
tools/                          extractors, grammar generator, validation harnesses
examples/                       sample sources, including a file exercising every scope
jetbrains-plugin/               Gradle IntelliJ Platform plugin: syntaxes/ via TextMate, server/ via LSP4IJ
```

## What the language server checks

- **Syntax**, from a recursive-descent parser that follows the published Formal Syntax and accepts both
  documented dialects (`is ... end` and braces) in the same file. It recovers from errors rather than giving
  up, so an edit in progress at the top of a file does not blank out the outline below it.
- **Argument counts** on built-in calls, where the count is known.
- **Unknown calls** - a name that is neither a built-in nor defined or declared in the file. Reported as a
  warning, since CG/PL resolves external modules at run time.

Both semantic checks stay quiet while a file has syntax errors, and either can be switched off in settings.

Analysis is otherwise per-file, with one exception: go-to-definition follows an external-declaration into the
module that defines it. Which module that is depends on the form, and the unqualified one reads as if no module
were named at all - it names the section instead ([CGPL, Modules](https://doc.communigatepro.ru/development/CGPL.html#Modules)):

| declaration | module loaded | section called |
| --- | --- | --- |
| `function myName(p) external;` | `myName` | `myName` |
| `function myModule::myName(p) external;` | `myModule` | `myName` |

The module is looked up among sibling files with a CG/PL extension, matched case-insensitively because CG/PL
names are - so `bridgedLoopHash` finds `bridgedloophash.sppi`. When no such file exists, the jump lands on the
declaration.

## Roadmap

- **Done** - syntax highlighting from generated grammars, in VSCode and JetBrains IDEs.
- **Done** - the language server: parser with error recovery, diagnostics, outline, go-to-definition,
  completion, hover and signature help.
- **Done** - JetBrains via [LSP4IJ](https://github.com/redhat-developer/lsp4ij), running the same server
  binary the VSCode extension does, so there is exactly one language implementation behind both editors.

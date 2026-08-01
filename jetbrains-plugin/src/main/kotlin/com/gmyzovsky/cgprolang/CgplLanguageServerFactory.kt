package com.gmyzovsky.cgprolang

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.application.PluginPathManager
import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.LanguageServerFactory
import com.redhat.devtools.lsp4ij.server.CannotStartProcessException
import com.redhat.devtools.lsp4ij.server.OSProcessStreamConnectionProvider
import com.redhat.devtools.lsp4ij.server.StreamConnectionProvider
import java.io.File
import java.nio.charset.StandardCharsets

/**
 * Runs the CG/PL language server - the same Node process the VSCode extension
 * launches, from the same compiled sources - behind LSP4IJ. Diagnostics, the
 * outline, go-to-definition, completion, hover and signature help all come from
 * there, so the two editors cannot drift apart.
 *
 * Highlighting is deliberately not part of this. It stays with the TextMate
 * bundles wired up in plugin.xml, because the grammars are shared with VSCode
 * too and the server publishes no semantic tokens.
 */
class CgplLanguageServerFactory : LanguageServerFactory {
    override fun createConnectionProvider(project: Project): StreamConnectionProvider = CgplLanguageServer()
}

class CgplLanguageServer : OSProcessStreamConnectionProvider() {

    /**
     * Built here rather than in a constructor so that a missing interpreter
     * surfaces as a start failure in the LSP console, where it is attributed to
     * this server and readable, instead of an exception thrown while LSP4IJ is
     * still instantiating the factory.
     */
    override fun start() {
        if (commandLine == null) {
            commandLine = buildCommandLine()
        }
        super.start()
    }

    private fun buildCommandLine(): GeneralCommandLine {
        val payload = payloadDirectory()
        val script = payload.resolve("server/out/server.js")
        if (!script.isFile) {
            throw CannotStartProcessException(
                "The CG/PL language server is missing from the plugin: expected $script.",
            )
        }

        val node = NodeInterpreter.locate() ?: throw CannotStartProcessException(
            "Node.js is required to run the CG/PL language server but was not found on PATH " +
                "or in any of the usual install locations. Install Node.js 18 or newer, or point " +
                "the IDE at an existing interpreter by adding " +
                "-D${NodeInterpreter.OVERRIDE_PROPERTY}=/path/to/node to Help | Edit Custom VM Options. " +
                "Syntax highlighting keeps working without it.",
        )

        // --stdio because LSP4IJ speaks to the process over its standard
        // streams; the VSCode client uses Node IPC instead, and the server
        // picks its transport from this argument.
        return GeneralCommandLine(node.absolutePath, script.absolutePath, "--stdio")
            .withWorkDirectory(payload)
            .withCharset(StandardCharsets.UTF_8)
    }

    /**
     * The lsp/ tree copied into the plugin directory by the copyLanguageServer
     * Gradle task. Same mechanism as the TextMate bundles: loose files under the
     * installed plugin, not classpath resources, because Node has to read them.
     */
    private fun payloadDirectory(): File =
        PluginPathManager.getPluginResource(javaClass, "lsp")
            ?: throw CannotStartProcessException(
                "Could not locate the lsp directory inside the CommuniGate Pro Languages plugin.",
            )
}

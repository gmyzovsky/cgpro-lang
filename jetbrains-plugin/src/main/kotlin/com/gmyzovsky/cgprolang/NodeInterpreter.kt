package com.gmyzovsky.cgprolang

import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.openapi.util.SystemInfo
import java.io.File

/**
 * Finds a Node.js interpreter to run the CG/PL language server with.
 *
 * The plugin ships the server but not a Node runtime - bundling one would mean
 * a per-platform distribution roughly fifty times the size of everything else
 * here. IntelliJ's own Node.js support lives in the JavaScript plugin, which
 * Community editions do not have, so the lookup is done by hand.
 *
 * PATH comes first and answers for almost everyone: on macOS and Linux the IDE
 * loads the login shell's environment at startup, so version managers that work
 * in a terminal work here too. The hardcoded list behind it covers the case
 * that lookup misses - a desktop-launched IDE that inherited a bare PATH.
 */
object NodeInterpreter {

    /** Escape hatch for an interpreter in none of the usual places. */
    const val OVERRIDE_PROPERTY = "cgpro.lang.nodePath"

    private val executableName = if (SystemInfo.isWindows) "node.exe" else "node"

    /** Lexicographic over the numeric components; a missing or non-numeric one sorts lowest. */
    private val versionOrder = Comparator<List<Int>> { left, right ->
        for (i in 0 until maxOf(left.size, right.size)) {
            val comparison = (left.getOrNull(i) ?: -1).compareTo(right.getOrNull(i) ?: -1)
            if (comparison != 0) return@Comparator comparison
        }
        0
    }

    fun locate(): File? = candidates().firstOrNull { it.isFile && it.canExecute() }

    private fun candidates(): Sequence<File> = sequence {
        System.getProperty(OVERRIDE_PROPERTY)?.takeIf { it.isNotBlank() }?.let { yield(File(it)) }
        PathEnvironmentVariableUtil.findInPath(executableName)?.let { yield(it) }
        yieldAll(wellKnownInstalls())
    }

    private fun wellKnownInstalls(): Sequence<File> = sequence {
        val home = File(System.getProperty("user.home"))
        if (SystemInfo.isWindows) {
            yield(File(System.getenv("ProgramFiles") ?: "C:\\Program Files", "nodejs\\node.exe"))
            yield(File(home, "AppData\\Roaming\\npm\\node.exe"))
        } else {
            // Apple Silicon Homebrew, Intel Homebrew, distribution packages.
            yield(File("/opt/homebrew/bin/node"))
            yield(File("/usr/local/bin/node"))
            yield(File("/usr/bin/node"))
        }
        yield(File(home, ".volta/bin/$executableName"))
        yield(File(home, ".asdf/shims/$executableName"))
        yieldAll(versionedInstalls(File(home, ".nvm/versions/node"), "bin"))
        yieldAll(versionedInstalls(File(home, ".local/share/fnm/node-versions"), "installation/bin"))
    }

    /**
     * Version managers keep every installed release side by side. Prefer the
     * newest, comparing numerically so that 20 sorts above 9 - which a plain
     * string sort gets backwards, and that is the difference between a working
     * server and one too old to run it.
     */
    private fun versionedInstalls(root: File, suffix: String): Sequence<File> =
        (root.listFiles() ?: emptyArray())
            .filter { it.isDirectory }
            .sortedWith(compareByDescending(versionOrder) { versionKey(it.name) })
            .asSequence()
            .map { it.resolve("$suffix/$executableName") }

    private fun versionKey(name: String): List<Int> =
        name.removePrefix("v").split('.', '-').map { it.toIntOrNull() ?: -1 }
}

package com.gmyzovsky.cgprolang

import com.intellij.openapi.application.PluginPathManager
import com.intellij.openapi.diagnostic.thisLogger
import org.jetbrains.plugins.textmate.api.TextMateBundleProvider
import java.io.File

/**
 * Points the bundled TextMate plugin at the cgpl/wssp/cgpro-data bundles
 * shipped as plugin resources under bundles/. Their tmLanguage grammar
 * files are copied at build time (see build.gradle.kts's copyGrammars task)
 * straight from the repo-root syntaxes directory that the VSCode extension
 * also ships - same grammar source, both IDEs.
 */
class CgproTextMateBundleProvider : TextMateBundleProvider {
    override fun getBundles(): MutableList<TextMateBundleProvider.PluginBundle> {
        val bundleNames = listOf("cgpl", "wssp", "cgpro-data")
        val result = mutableListOf<TextMateBundleProvider.PluginBundle>()
        for (name in bundleNames) {
            val dir: File? = PluginPathManager.getPluginResource(this.javaClass, "bundles/$name.tmbundle")
            if (dir == null) {
                thisLogger().warn("Could not find the $name TextMate bundle")
                continue
            }
            result.add(TextMateBundleProvider.PluginBundle(name, dir.toPath()))
        }
        return result
    }
}

package com.gmyzovsky.cgprolang

import com.intellij.lang.Language
import com.intellij.openapi.fileTypes.LanguageFileType
import javax.swing.Icon

// No custom icon for now - null falls back to the platform's generic file
// icon. Worth revisiting once the plugin has real marketplace presence.

object CgplLanguage : Language("CGPL") {
    private fun readResolve(): Any = CgplLanguage
}

class CgplFileType : LanguageFileType(CgplLanguage) {
    companion object {
        @JvmField
        val INSTANCE = CgplFileType()
    }

    override fun getName() = "CGPL"
    override fun getDescription() = "CommuniGate Pro CG/PL file"
    override fun getDefaultExtension() = "wcgp"
    override fun getIcon(): Icon? = null
}

object WsspLanguage : Language("WSSP") {
    private fun readResolve(): Any = WsspLanguage
}

class WsspFileType : LanguageFileType(WsspLanguage) {
    companion object {
        @JvmField
        val INSTANCE = WsspFileType()
    }

    override fun getName() = "WSSP"
    override fun getDescription() = "CommuniGate Pro WSSP file"
    override fun getDefaultExtension() = "wssp"
    override fun getIcon(): Icon? = null
}

object CgproDataLanguage : Language("CGProData") {
    private fun readResolve(): Any = CgproDataLanguage
}

class CgproDataFileType : LanguageFileType(CgproDataLanguage) {
    companion object {
        @JvmField
        val INSTANCE = CgproDataFileType()
    }

    override fun getName() = "CGProData"
    override fun getDescription() = "CommuniGate Pro Data literal file"
    override fun getDefaultExtension() = "data"
    override fun getIcon(): Icon? = null
}

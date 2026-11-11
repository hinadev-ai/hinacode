package dev.hinacode.composereditor

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ComposerEditorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ComposerEditor")

    View(ComposerEditorView::class) {
      Events(
        "onEditorChange",
        "onEditorSelection",
        "onEditorFocus",
        "onEditorBlur",
        "onEditorContentSize",
        "onEditorFormat",
        "onEditorPasteImages",
      )

      Prop("document") { view: ComposerEditorView, json: String -> view.setDocument(json) }
      Prop("icons") { view: ComposerEditorView, json: String -> view.setIcons(json) }
      Prop("theme") { view: ComposerEditorView, json: String -> view.setTheme(json) }
      Prop("placeholder") { view: ComposerEditorView, text: String -> view.editor.hint = text }
      Prop("fontSize") { view: ComposerEditorView, size: Float -> view.setFontSize(size) }
      Prop("lineHeight") { view: ComposerEditorView, height: Float -> view.setLineHeight(height) }
      Prop("paddingHorizontal") { view: ComposerEditorView, padding: Float -> view.setPadding(horizontal = padding) }
      Prop("paddingVertical") { view: ComposerEditorView, padding: Float -> view.setPadding(vertical = padding) }
      Prop("formatActions") { view: ComposerEditorView, json: String -> view.setFormatActions(json) }
      Prop("editable") { view: ComposerEditorView, editable: Boolean -> view.setEditable(editable) }

      AsyncFunction("focus") { view: ComposerEditorView -> view.focus() }
      AsyncFunction("blur") { view: ComposerEditorView -> view.blur() }
    }
  }
}

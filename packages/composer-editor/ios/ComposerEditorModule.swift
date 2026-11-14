import ExpoModulesCore

public class ComposerEditorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ComposerEditor")

    View(ComposerEditorView.self) {
      Events("onEditorChange", "onEditorSelection", "onEditorFocus", "onEditorBlur", "onEditorContentSize", "onEditorFormat", "onEditorPasteImages")

      Prop("document") { (view: ComposerEditorView, json: String) in view.setDocument(json) }
      Prop("icons") { (view: ComposerEditorView, json: String) in view.setIcons(json) }
      Prop("theme") { (view: ComposerEditorView, json: String) in view.setTheme(json) }
      Prop("placeholder") { (view: ComposerEditorView, text: String) in view.setPlaceholder(text) }
      Prop("fontSize") { (view: ComposerEditorView, size: Double) in view.setFontSize(CGFloat(size)) }
      Prop("lineHeight") { (view: ComposerEditorView, height: Double) in view.setLineHeight(CGFloat(height)) }
      Prop("paddingHorizontal") { (view: ComposerEditorView, padding: Double) in view.setPadding(horizontal: CGFloat(padding)) }
      Prop("paddingVertical") { (view: ComposerEditorView, padding: Double) in view.setPadding(vertical: CGFloat(padding)) }
      Prop("formatActions") { (view: ComposerEditorView, json: String) in view.setFormatActions(json) }
      Prop("editable") { (view: ComposerEditorView, editable: Bool) in view.textView.isEditable = editable }

      AsyncFunction("focus") { (view: ComposerEditorView) in view.textView.becomeFirstResponder() }.runOnQueue(.main)
      AsyncFunction("blur") { (view: ComposerEditorView) in view.textView.resignFirstResponder() }.runOnQueue(.main)
    }
  }
}

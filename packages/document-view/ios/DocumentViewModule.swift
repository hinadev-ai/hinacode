import ExpoModulesCore

public class DocumentViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name(DocumentProtocol.nativeView)

    View(DocumentBlocksView.self) {
      Events("onDocumentEvent")

      Prop("theme") { (view: DocumentBlocksView, json: String) in view.setTheme(json) }
      Prop("editable") { (view: DocumentBlocksView, editable: Bool) in view.setEditable(editable) }
      Prop("formatActions") { (view: DocumentBlocksView, json: String) in view.setFormatActions(json) }
      Prop("contentInsetTop") { (view: DocumentBlocksView, top: Double) in view.setContentInset(top: CGFloat(top)) }
      Prop("contentInsetBottom") { (view: DocumentBlocksView, bottom: Double) in
        view.setContentInset(bottom: CGFloat(bottom))
      }

      AsyncFunction("applyPatch") { (view: DocumentBlocksView, json: String) in view.applyPatch(json) }.runOnQueue(.main)
      AsyncFunction("scrollToBlock") { (view: DocumentBlocksView, index: Int) in view.scrollToBlock(index) }
        .runOnQueue(.main)
      AsyncFunction("provideImage") { (view: DocumentBlocksView, src: String, dataUrl: String) in
        view.provideImage(src: src, dataUrl: dataUrl)
      }.runOnQueue(.main)
      AsyncFunction("focus") { (view: DocumentBlocksView) in view.focusDocument() }.runOnQueue(.main)
      AsyncFunction("blur") { (view: DocumentBlocksView) in view.blurDocument() }.runOnQueue(.main)
    }
  }
}

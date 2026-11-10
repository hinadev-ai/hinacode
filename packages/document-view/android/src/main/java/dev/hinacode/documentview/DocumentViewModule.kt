package dev.hinacode.documentview

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DocumentViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name(DocumentProtocol.NATIVE_VIEW)

    View(DocumentView::class) {
      Events("onDocumentEvent")

      OnViewDestroys { view: DocumentView -> view.release() }

      Prop("theme") { view: DocumentView, json: String -> view.setTheme(json) }
      Prop("editable") { view: DocumentView, editable: Boolean -> view.editable = editable }
      Prop("contentInsetTop") { view: DocumentView, inset: Float -> view.setContentInset(top = inset) }
      Prop("contentInsetBottom") { view: DocumentView, inset: Float -> view.setContentInset(bottom = inset) }

      AsyncFunction("applyPatch") { view: DocumentView, json: String -> view.applyPatch(json) }.runOnQueue(Queues.MAIN)
      AsyncFunction("scrollToBlock") { view: DocumentView, index: Int -> view.scrollToBlock(index) }.runOnQueue(Queues.MAIN)
      AsyncFunction("provideImage") { view: DocumentView, src: String, dataUrl: String ->
        view.provideImage(src, dataUrl)
      }.runOnQueue(Queues.MAIN)
    }
  }
}

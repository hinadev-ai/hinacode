import Foundation
import HinaCodeKit
import Testing

@MainActor
@Suite("DraftsStore")
struct DraftsStoreTests {
    @Test("keeps unsent drafts and their workspaces across launches")
    func persists() {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let drafts = DraftsStore(defaults: defaults)
        drafts.setText("Fix the login test", threadId: "t1")
        drafts.setText("sent already", threadId: "t2")
        _ = drafts.take(threadId: "t2")
        drafts.setWorkspace(.init(mode: .worktree, ref: "#12"), threadId: "t1")

        let relaunched = DraftsStore(defaults: defaults)
        #expect(relaunched.texts == ["t1": "Fix the login test"])
        #expect(relaunched.workspaces == ["t1": .init(mode: .worktree, ref: "#12")])
    }
}

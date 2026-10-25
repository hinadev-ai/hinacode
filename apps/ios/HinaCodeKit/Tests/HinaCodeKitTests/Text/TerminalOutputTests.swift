import HinaCodeKit
import Testing

private let reset = TerminalOutput.reset

@Suite struct TerminalOutputTests {
    @Test("holds a push that skips output until the missing range is attached")
    func holdsSkippingPush() {
        var output = TerminalOutput()
        let first = output.beginAttach()
        output.attached(first, offset: 0, data: "abc")
        #expect(output.receive("gh", offset: 6) == "")
        #expect(output.needsAttach)
        let attach = output.beginAttach()
        #expect(attach.since == 3)
        #expect(output.attached(attach, offset: 3, data: "defgh") == "defgh")
        #expect(!output.needsAttach)
    }

    @Test("detects a gap in pushes held during an attach")
    func gapInHeldPushes() {
        var output = TerminalOutput()
        let first = output.beginAttach()
        output.receive("gh", offset: 6)
        #expect(output.attached(first, offset: 0, data: "abc") == reset + "abc")
        #expect(output.needsAttach)
        let next = output.beginAttach()
        #expect(next.since == 3)
        #expect(output.attached(next, offset: 3, data: "defgh") == "defgh")
    }

    @Test("repaints from the scrollback on the first attach and trims pushes it already covered")
    func firstAttachRepaints() {
        var output = TerminalOutput()
        let attach = output.beginAttach()
        #expect(attach.since == nil)
        #expect(output.receive("abc", offset: 0) == "")
        #expect(output.receive("def", offset: 3) == "")
        #expect(output.receive("ghi", offset: 6) == "")
        #expect(output.attached(attach, offset: 0, data: "abcdefg") == reset + "abcdefghi")
        #expect(output.receive("j", offset: 9) == "j")
    }

    @Test("appends only what is new when attaching since the last shown offset")
    func appendsOnlyNew() {
        var output = TerminalOutput()
        let first = output.beginAttach()
        output.attached(first, offset: 0, data: "hello")
        let attach = output.beginAttach()
        #expect(attach.since == 5)
        #expect(output.attached(attach, offset: 2, data: "llo world") == " world")
    }

    @Test("clears the screen when the desktop dropped output past the last shown offset")
    func clearsAfterDroppedOutput() {
        var output = TerminalOutput()
        let first = output.beginAttach()
        output.attached(first, offset: 0, data: "12345")
        let attach = output.beginAttach()
        #expect(output.attached(attach, offset: 100, data: "tail") == reset + "tail")
        #expect(output.receive("tail!", offset: 100) == "!")
    }

    @Test("ignores an attach answer superseded by a newer attach")
    func supersededAttach() {
        var output = TerminalOutput()
        let first = output.beginAttach()
        let second = output.beginAttach()
        #expect(output.attached(first, offset: 0, data: "old") == nil)
        #expect(output.attachFailed(first) == nil)
        #expect(output.attached(second, offset: 0, data: "new") == reset + "new")
    }

    @Test("releases held output when an attach fails")
    func failedAttachReleases() {
        var output = TerminalOutput()
        let attach = output.beginAttach()
        output.receive("ab", offset: 0)
        #expect(output.attachFailed(attach) == "ab")
        #expect(output.receive("bc", offset: 1) == "c")
    }

    @Test("repaints on the next attach after output could not be shown")
    func repaintsAfterLost() {
        var output = TerminalOutput()
        let first = output.beginAttach()
        output.attached(first, offset: 0, data: "abc")
        output.lost()
        let attach = output.beginAttach()
        #expect(attach.since == nil)
        #expect(output.attached(attach, offset: 0, data: "abcdef") == reset + "abcdef")
    }

    @Test("writes pushes from an older desktop as they come")
    func olderDesktop() {
        var output = TerminalOutput()
        #expect(output.receive("x", offset: nil) == "x")
        #expect(output.receive("x", offset: nil) == "x")
    }

    @Test("counts offsets in UTF-16 code units, as the desktop does")
    func utf16Offsets() {
        var output = TerminalOutput()
        let attach = output.beginAttach()
        output.attached(attach, offset: 0, data: "a😀b")
        #expect(output.receive("😀bc", offset: 1) == "c")
        #expect(output.beginAttach().since == 5)
    }
}

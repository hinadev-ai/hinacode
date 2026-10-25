import XCTest

final class ScreenshotTests: XCTestCase {
    @MainActor
    func testLaunch() throws {
        XCUIApplication().launch()
    }
}

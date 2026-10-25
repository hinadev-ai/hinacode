import XCTest

/// Walks the whole app against a real `hinacode serve` (mock agent, mock Linear): pair, add a project, send a
/// prompt, read the reply, browse files, use the terminal, look at pull requests, the overview and Settings.
/// Screenshots attach at every step. Needs HINACODE_PAIRING_URL and HINACODE_PROJECT_ROOT in the environment,
/// e.g. `TEST_RUNNER_HINACODE_PAIRING_URL=... xcodebuild test`.
final class WalkTests: XCTestCase {
    @MainActor
    func testWalkTheApp() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let pairingURL = environment["HINACODE_PAIRING_URL"], !pairingURL.isEmpty else {
            throw XCTSkip("HINACODE_PAIRING_URL is not set; start a hinacode serve and pass its pairing URL")
        }
        let projectRoot = environment["HINACODE_PROJECT_ROOT"] ?? "/tmp/hinacode-ios-walk-project"

        let app = XCUIApplication()
        app.launchArguments = ["-HinaCodeResetState", "YES", "-AppleLanguages", "(en)"]
        app.launch()

        // Pair with the pasted URL.
        let urlField = app.descendants(matching: .any)["pairing-url"].firstMatch
        XCTAssertTrue(urlField.waitForExistence(timeout: 20), "pairing screen")
        shot("01-pairing")
        urlField.tap()
        urlField.typeText(pairingURL)
        let connect = app.buttons["pairing-connect"]
        XCTAssertTrue(connect.waitForExistence(timeout: 5))
        if !connect.isHittable { app.swipeUp() }
        connect.tap()

        // A fresh desktop seeds only its Chats project. Add this repository through the new thread sheet so
        // there are files to browse.
        // The app asks for notification permission right after the first pairing (only while undetermined).
        // Allow it through SpringBoard before touching the list.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons.element(boundBy: 1)
        if allow.waitForExistence(timeout: 6) { allow.tap() }
        let newThread = app.buttons["sidebar-new-thread"]
        XCTAssertTrue(newThread.waitForExistence(timeout: 30), "thread list after pairing")
        shot("02-home")
        newThread.tap()
        let addProject = app.buttons["add-project"]
        XCTAssertTrue(addProject.waitForExistence(timeout: 10), "new thread sheet")
        // A rerun against the same desktop finds the project already added; start the thread in it directly.
        let folderName = (projectRoot as NSString).lastPathComponent
        let existing = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH 'new-thread-project-' AND label CONTAINS %@", folderName)
        ).firstMatch
        if existing.exists {
            existing.tap()
        } else {
            addProject.tap()
            let source = app.descendants(matching: .any)["project-source"].firstMatch
            XCTAssertTrue(source.waitForExistence(timeout: 10), "add project form")
            source.tap()
            source.typeText(projectRoot)
            shot("03-add-project")
            app.buttons["project-submit"].tap()
        }

        // Adding a project opens its first thread. Send a prompt and read the Markdown reply.
        let composer = app.descendants(matching: .any)["composer-field"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 30), "thread open with composer")
        shot("04-thread-empty")
        composer.tap()
        composer.typeText("Show me some markdown")
        app.buttons["composer-send"].tap()
        let heading = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Heading 1")).firstMatch
        XCTAssertTrue(heading.waitForExistence(timeout: 30), "mock reply rendered")
        sleep(3)
        shot("05-chat-reply")
        app.swipeDown()
        shot("06-chat-scrolled")
        // Back to the latest message for the next steps.
        app.swipeUp()

        // Files: the repository root, then its README.
        segment(app, "Files")
        let files = app.descendants(matching: .any)["files-list"].firstMatch
        XCTAssertTrue(files.waitForExistence(timeout: 20), "files list")
        sleep(2)
        shot("07-files")
        // Folders sort first, so find the README through search.
        let fileSearch = app.searchFields.firstMatch
        if fileSearch.waitForExistence(timeout: 5) {
            fileSearch.tap()
            fileSearch.typeText("README")
            let readme = app.staticTexts["README.md"].firstMatch
            if readme.waitForExistence(timeout: 10) {
                readme.tap()
                sleep(3)
                shot("08-file-readme")
                goBack(app)
            }
            let closeSearch = app.buttons["close"]
            if closeSearch.exists { closeSearch.tap() }
        }

        // Terminal: a real shell in the workspace.
        segment(app, "Terminal")
        let terminal = app.descendants(matching: .any)["terminal-view"].firstMatch
        XCTAssertTrue(terminal.waitForExistence(timeout: 20), "terminal")
        // The opening cover lifts once the shell is up; only then can the terminal take focus.
        let opening = app.staticTexts["Opening a shell"].firstMatch
        if opening.exists {
            let gone = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == false"), object: opening)
            _ = XCTWaiter().wait(for: [gone], timeout: 20)
        }
        terminal.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 5) {
            terminal.tap()
        }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "terminal keyboard")
        app.typeText("echo hello-from-walk\n")
        sleep(3)
        shot("09-terminal")

        // Pull requests: none linked yet.
        segment(app, "PRs")
        sleep(3)
        shot("10-pull-requests")

        // Overview from the sidebar.
        showSidebar(app)
        let overview = app.descendants(matching: .any)["sidebar-overview"].firstMatch
        XCTAssertTrue(overview.waitForExistence(timeout: 10), "overview row")
        overview.tap()
        sleep(4)
        shot("11-overview")

        // Settings.
        showSidebar(app)
        let settings = app.buttons["sidebar-settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10), "settings button")
        settings.tap()
        let done = app.buttons["settings-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 10), "settings sheet")
        sleep(2)
        shot("12-settings")
        app.swipeUp()
        shot("13-settings-scrolled")
        done.tap()
    }

    @MainActor
    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    private func segment(_ app: XCUIApplication, _ label: String) {
        // On iPad the sidebar's own segmented control is also on screen; scope to the thread's picker.
        let button = app.segmentedControls["thread-views"].buttons[label]
        XCTAssertTrue(button.waitForExistence(timeout: 10), "segment \(label)")
        button.tap()
    }

    @MainActor
    private func goBack(_ app: XCUIApplication) {
        let back = app.navigationBars.buttons.firstMatch
        if back.exists { back.tap() }
    }

    /// On iPhone the list is behind the open thread; on iPad it is already beside it.
    @MainActor
    private func showSidebar(_ app: XCUIApplication) {
        let overview = app.descendants(matching: .any)["sidebar-overview"].firstMatch
        if overview.exists && overview.isHittable { return }
        goBack(app)
    }
}

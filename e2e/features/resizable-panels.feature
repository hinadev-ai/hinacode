@desktop
Feature: Resizable panels
  The sidebar and the thread details panel take the width the developer gives them, and keep it.

  Background:
    Given a project "demo" for my repository
    And the project "demo" has a thread "Resize"
    When I open the thread "Resize" from the sidebar

  Scenario: Dragging the thread details edge widens it and the width survives a reload
    When I drag "Resize thread details" 120 pixels to the left
    Then the thread details panel is 120 pixels wider than it started
    When I reload the app and open the thread "Resize"
    Then the thread details panel is 120 pixels wider than it started

  Scenario: Releasing the thread details edge away from the last move keeps the release width
    When I release "Resize thread details" 120 pixels to the left without a final move
    Then the thread details panel is 120 pixels wider than it started
    When I reload the app and open the thread "Resize"
    Then the thread details panel is 120 pixels wider than it started

  Scenario: The keyboard resizes the thread details panel
    When I press "ArrowLeft" on "Resize thread details"
    Then the thread details panel is 16 pixels wider than it started
    When I press "Home" on "Resize thread details"
    Then the thread details panel is 280 pixels wide

  Scenario: Double-clicking the edge restores the default width
    When I drag "Resize thread details" 120 pixels to the left
    And I double-click "Resize thread details"
    Then the thread details panel is 0 pixels wider than it started

  Scenario: Dragging the sidebar edge still resizes the sidebar
    When I drag "Resize sidebar" 100 pixels to the right
    Then the sidebar is 356 pixels wide

  # Unmounting a captured splitter used to leave cursor and selection styles on the entire document.
  Scenario: A responsive layout change releases an active resize drag
    When I start dragging "Resize thread details"
    And I use a 1000 by 820 viewport with 16 pixel text
    Then no resize drag is active

  # A 50vw cap ignored the docked sidebar, reducing the message field to 20 pixels.
  Scenario: Enlarged panels leave room to compose at the docking breakpoint
    When I use a 1152 by 820 viewport with 16 pixel text
    And I press "End" on "Resize sidebar"
    And I press "End" on "Resize thread details"
    And I compose a long draft
    Then the message field and Send action fit inside the window
    And the resize maximum matches the displayed panel width

  Scenario: Repeated arrow presses each resize by one step
    When I press "Home" on "Resize thread details"
    Then the thread details panel is 280 pixels wide
    When I press ArrowLeft 5 times on "Resize thread details"
    Then the thread details panel is 360 pixels wide

  Scenario: Files keep a separate wide width when their viewer opens and closes
    When I press "Home" on "Resize thread details"
    And I press ArrowLeft 5 times on "Resize thread details"
    And I open Files in the activity bar
    And I click "README.md" in the file tree
    Then the file viewer shows "README.md" with "e2e"
    When I press "Home" on "Resize thread details"
    And I press ArrowLeft 10 times on "Resize thread details"
    Then the thread details panel is 440 pixels wide
    When I press Escape in the file tree
    Then the thread details panel is 360 pixels wide
    When I click "README.md" in the file tree
    Then the thread details panel is 440 pixels wide
    When I show the "Details" side panel view
    Then the thread details panel is 360 pixels wide
    When I show the "Files" side panel view
    Then the thread details panel is 440 pixels wide
    When I reload the app and open the thread "Resize"
    And I show the "Browser" side panel view
    Then the thread details panel is 440 pixels wide

  Scenario: Opening and closing a commit diff switches panel size
    When I press "Home" on "Resize thread details"
    And I press ArrowLeft 5 times on "Resize thread details"
    And I show the "Git" side panel view
    Then the thread details panel is 360 pixels wide
    When I open the commit "init" in the graph
    And I press "Home" on "Resize thread details"
    And I press ArrowLeft 10 times on "Resize thread details"
    Then the thread details panel is 440 pixels wide
    When I press Enter in the commit graph
    Then the thread details panel is 360 pixels wide
    When I press Enter in the commit graph
    Then the thread details panel is 440 pixels wide

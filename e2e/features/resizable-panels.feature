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

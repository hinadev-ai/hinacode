Feature: Back and forward navigation
  The app keeps a history of where you have been, like a browser, and Escape leaves settings.

  Background:
    Given a project "demo" for my repository
    And the project "demo" has a thread "Fix login redirect"
    And the project "demo" has a thread "Add palette"

  Scenario: Going back and forward walks the threads you opened
    When I open the thread "Fix login redirect" from the sidebar
    And I open the thread "Add palette" from the sidebar
    And I press "ControlOrMeta+BracketLeft"
    Then the thread "Fix login redirect" is open
    When I press "ControlOrMeta+BracketRight"
    Then the thread "Add palette" is open

  Scenario: Escape leaves settings for the thread you came from
    When I open the thread "Add palette" from the sidebar
    And I open settings
    And I press "Escape"
    Then the thread "Add palette" is open

  Scenario: Escape that closes the sidebar overlay stays in settings
    Given the window is too narrow to dock the sidebar
    When I open settings
    And I open the sidebar overlay
    And focus leaves the sidebar overlay
    And I press "Escape"
    Then the sidebar overlay is closed
    And the settings heading reads "Settings"

  Scenario: A restart reopens the thread you were on
    When I open the thread "Add palette" from the sidebar
    And the app restarts
    Then the thread "Add palette" is open

  Scenario: A restart reopens settings
    When I open settings
    And the app restarts
    Then the settings heading reads "Settings"

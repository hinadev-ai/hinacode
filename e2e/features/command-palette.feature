Feature: Command palette
  One shortcut reaches any thread, project, file in the open thread's workspace, or command.

  Background:
    Given a project "demo" for my repository
    And the project "demo" has a thread "Fix login redirect"
    And the project "demo" has a thread "Add palette"

  Scenario: Filtering by a thread's name and pressing Enter opens it
    When I press "ControlOrMeta+p"
    And I type the name of the thread "Fix login redirect" into the palette
    Then the first palette result is "Fix login redirect"
    When I press "Enter"
    Then the thread "Fix login redirect" is open
    And the palette is closed

  Scenario: Choosing a file shows it in the file viewer
    When I open the thread "Add palette" from the sidebar
    And I press "ControlOrMeta+p"
    And I type "readme" into the palette
    Then the first palette result reads "README.md"
    When I press "Enter"
    Then the file viewer shows "README.md" with "e2e"

  Scenario: The commands mode runs a command
    When I press "ControlOrMeta+Shift+p"
    And I type "sidebar" into the palette
    Then the first palette result reads "Show or hide sidebar"
    When I press "Enter"
    Then the sidebar is hidden

  Scenario: The new thread shortcut offers the open thread's project first
    Given another project "tools" has a thread "Bump deps"
    When I open the thread "Bump deps" from the sidebar
    And I press "ControlOrMeta+n"
    Then the first palette result is "tools"
    When I press "Enter"
    Then a new thread is open with the composer focused
    And the open thread belongs to the project "tools"

  Scenario: A number chord in the new thread picker starts a thread in that project
    When I press "ControlOrMeta+n"
    Then the new thread picker lists the projects
    When I press "ControlOrMeta+1"
    Then a new thread is open with the composer focused
    And the open thread belongs to the first project

  Scenario: Escape closes the palette
    When I press "ControlOrMeta+p"
    And I press "Escape"
    Then the palette is closed

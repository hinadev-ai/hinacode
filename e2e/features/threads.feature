Feature: Threads
  A thread is one agent conversation inside a project. The sidebar groups threads under their
  project and lets the user filter, reorder, rename, archive and delete them.

  Background:
    Given a project "demo" for my repository

  Scenario: Starting a thread opens it at once, ready for the first message
    When I start a new thread in "demo"
    Then a new thread is open with the composer focused
    And the sidebar lists the open thread

  Scenario: Opening a thread from the sidebar shows its title
    Given the project "demo" has a thread "One"
    And the project "demo" has a thread "Two"
    When I open the thread "Two" from the sidebar
    Then the thread "Two" is open

  Scenario: Switching between threads replaces the open thread instead of stacking it
    Given the project "demo" has a thread "One"
    And the project "demo" has a thread "Two"
    When I open the thread "One" from the sidebar
    And I open the thread "Two" from the sidebar
    And I open the thread "One" from the sidebar
    Then the thread "One" is open

  Scenario: A project group collapses and expands its threads
    Given the project "demo" has a thread "One"
    When I collapse the threads of "demo"
    Then the sidebar does not list the thread "One"
    When I expand the threads of "demo"
    Then the sidebar lists the thread "One"

  Scenario: A thread moves within its project by keyboard and the order is saved
    Given the project "demo" has a thread "One"
    And the project "demo" has a thread "Two"
    When I move the thread "Two" up with the keyboard
    Then the sidebar lists the threads "Two, One" in that order
    When the app restarts
    Then the sidebar lists the threads "Two, One" in that order

  Scenario: A thread is renamed inline from its row menu
    Given the project "demo" has a thread "Draft"
    When I rename the thread "Draft" to "Final"
    Then the sidebar lists the thread "Final"
    And the sidebar does not list the thread "Draft"

  Scenario: An archived thread moves to the Archived tab and can be brought back
    Given the project "demo" has a thread "Done"
    When I archive the thread "Done" from its menu
    Then the sidebar does not list the thread "Done"
    And the thread "Done" is stored as "archived"
    When I open the sidebar tab "Archived"
    Then the sidebar lists the thread "Done"
    When I unarchive the thread "Done"
    Then the sidebar does not list the thread "Done"
    When I open the sidebar tab "Threads"
    Then the sidebar lists the thread "Done"
    And the thread "Done" is stored as "idle"

  Scenario: The sidebar filter matches thread titles and project names
    Given the project "demo" has a thread "Fix login"
    And the project "demo" has a thread "Write docs"
    And another project "tools" has a thread "Bump deps"
    When I filter the sidebar by "login"
    Then the sidebar lists the thread "Fix login"
    And the sidebar does not list the thread "Write docs"
    And the sidebar does not list the thread "Bump deps"
    When I filter the sidebar by the name of the project "tools"
    Then the sidebar lists the thread "Bump deps"
    And the sidebar does not list the thread "Fix login"

  Scenario: The project filter shows only the chosen projects, after a restart too
    Given the project "demo" has a thread "Fix login"
    And another project "tools" has a thread "Bump deps"
    When I show only the project "tools" in the sidebar
    Then the sidebar lists the thread "Bump deps"
    And the sidebar does not list the thread "Fix login"
    When the app restarts
    Then the sidebar lists the thread "Bump deps"
    And the sidebar does not list the thread "Fix login"

  Scenario: A thread is deleted after confirmation
    Given the project "demo" has a thread "Gone"
    When I delete the thread "Gone" from its menu
    Then the thread "Gone" no longer exists

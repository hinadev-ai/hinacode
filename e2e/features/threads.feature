Feature: Threads
  A thread is one agent conversation inside a project. The sidebar groups threads under their
  project and lets the user reorder, rename, settle and delete them.

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

  Scenario: A thread is settled from its row menu
    Given the project "demo" has a thread "Done"
    When I settle the thread "Done" from its menu
    Then the thread "Done" is marked settled

  Scenario: A thread is deleted after confirmation
    Given the project "demo" has a thread "Gone"
    When I delete the thread "Gone" from its menu
    Then the thread "Gone" no longer exists

Feature: Threads
  A thread is one agent conversation inside a project.

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

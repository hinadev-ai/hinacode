Feature: Threads
  A thread is one agent conversation inside a project.

  Background:
    Given a project "demo" for my repository

  Scenario: Creating a thread opens it and lists it under its project
    When I create a thread titled "Write tests" in "demo"
    Then the thread "Write tests" is open
    And the sidebar lists the thread "Write tests"

  Scenario: Opening a thread from the sidebar shows its title
    Given the project "demo" has a thread "One"
    And the project "demo" has a thread "Two"
    When I open the thread "Two" from the sidebar
    Then the thread "Two" is open

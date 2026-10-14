Feature: Unseen results
  A thread that finishes or fails while the developer looks elsewhere stays marked in the sidebar
  until they open it, so a finished thread does not read like every other idle one.

  Background:
    Given a project "demo" for my repository
    And the project "demo" has a thread "Background"
    And the project "demo" has a thread "Foreground"
    When I open the thread "Foreground" from the sidebar

  Scenario Outline: A thread that ends out of sight stays marked until it is opened
    When the agent in "Background" emits "<event>"
    Then the sidebar marks "Background" as "<mark>"
    When the app restarts
    Then the sidebar marks "Background" as "<mark>"
    When I open the thread "Background" from the sidebar
    Then the sidebar does not mark "Background"

    Examples:
      | event          | mark                     |
      | turn_completed | Finished, not yet opened |
      | turn_failed    | Failed, not yet opened   |

  Scenario: The thread in front of the developer is not marked
    Given the window has focus
    When the agent in "Foreground" emits "turn_completed"
    And the agent in "Background" emits "turn_completed"
    Then the sidebar marks "Background" as "Finished, not yet opened"
    And the sidebar does not mark "Foreground"

  Scenario: The open thread is marked while the window is in the background
    Given the window does not have focus
    When the agent in "Foreground" emits "turn_completed"
    Then the sidebar marks "Foreground" as "Finished, not yet opened"
    When the window regains focus
    Then the sidebar does not mark "Foreground"

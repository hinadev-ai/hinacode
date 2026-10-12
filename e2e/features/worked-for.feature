Feature: Worked for
  Completed responses keep their answer visible and disclose the work with its elapsed time.

  Background:
    Given a project "demo" for my repository
    And the project "demo" has a thread "Timed response"

  Scenario Outline: Completed work expands with the keyboard in either appearance
    Given worked-for uses the "<appearance>" appearance
    And the thread "Timed response" has a finished response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    Then the worked-for row shows "08:05" with its work collapsed
    And the finished answer stays visible
    When I toggle the worked-for row with "Enter"
    Then the response progress and tool are visible
    When I inspect the timed command
    Then the timed command output is visible
    When I toggle the worked-for row with "Space"
    Then the worked-for row shows "08:05" with its work collapsed
    And the finished answer stays visible

    Examples:
      | appearance |
      | dark       |
      | light      |

  Scenario: Elapsed time and the answer survive restart
    Given the thread "Timed response" has a finished response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    And I toggle the worked-for row with "Enter"
    And the app restarts
    And I open the thread "Timed response" from the sidebar
    Then the worked-for row shows "08:05" with its work collapsed
    And the finished answer stays visible

  Scenario: Find in thread reveals matching collapsed progress
    Given the thread "Timed response" has a finished response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    And I find "Checking the repository" in the timed response
    Then the response progress and tool are visible
    And the timed progress contains the current find match

  Scenario: Activity stays visible until the response completes
    Given the thread "Timed response" has a running response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    Then the response progress and tool are visible
    And the response has no worked-for row
    When the timed response completes
    Then the worked-for row shows "08:05" with its work collapsed
    And the finished answer stays visible

  Scenario: Text-only answers show elapsed time without a disclosure
    Given the thread "Timed response" has a text-only response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    Then the elapsed time shows "08:05" without a disclosure
    And the finished answer stays visible

Feature: Worked for
  Completed responses show elapsed time while keeping their activity and answer visible.

  Background:
    Given a project "demo" for my repository
    And the project "demo" has a thread "Timed response"

  Scenario Outline: Completed activity stays visible in either appearance
    Given worked-for uses the "<appearance>" appearance
    And the thread "Timed response" has a finished response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    Then the worked-for row shows "08:05" without a collapse control
    And the response progress and tool are visible
    And the finished answer stays visible
    When I inspect the timed command
    Then the timed command output is visible
    And the finished answer stays visible

    Examples:
      | appearance |
      | dark       |
      | light      |

  Scenario: Elapsed time and the answer survive restart
    Given the thread "Timed response" has a finished response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    And the app restarts
    And I open the thread "Timed response" from the sidebar
    Then the worked-for row shows "08:05" without a collapse control
    And the response progress and tool are visible
    And the finished answer stays visible

  Scenario: Find in thread marks visible progress
    Given the thread "Timed response" has a finished response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    And I find "Checking the repository" in the timed response
    Then the response progress and tool are visible
    And the timed progress contains the current find match

  Scenario: Activity stays visible when the response completes
    Given the thread "Timed response" has a running response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    Then the response progress and tool are visible
    And the response has no worked-for row
    When the timed response completes
    Then the worked-for row shows "08:05" without a collapse control
    And the response progress and tool are visible
    And the finished answer stays visible

  Scenario: Closing Find keeps progress visible
    Given the thread "Timed response" has a finished response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    And I find "Checking the repository" in the timed response
    Then the response progress and tool are visible
    When I close Find
    Then the response progress and tool are visible
    Then the worked-for row shows "08:05" without a collapse control
    And the finished answer stays visible

  Scenario: Text-only answers show elapsed time without a disclosure
    Given the thread "Timed response" has a text-only response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    Then the worked-for row shows "08:05" without a collapse control
    And the finished answer stays visible

Feature: Worked for
  Completed responses show elapsed time and fold their tool activity and progress notes behind it, keeping the answer visible.

  Background:
    Given a project "demo" for my repository
    And the project "demo" has a thread "Timed response"

  Scenario Outline: Completed activity toggles with the keyboard in either appearance
    Given worked-for uses the "<appearance>" appearance
    And the thread "Timed response" has a finished response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    Then the worked-for row shows "08:05" with its activity hidden
    And the finished answer stays visible
    When I toggle the worked-for row with "Enter"
    Then the response progress and tool are visible
    When I inspect the timed command
    Then the timed command output is visible
    When I toggle the worked-for row with "Space"
    Then the worked-for row shows "08:05" with its activity hidden
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
    Then the worked-for row shows "08:05" with its activity hidden
    And the finished answer stays visible

  Scenario: Find in thread reveals matching hidden activity
    Given the thread "Timed response" has a finished response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    And I find "pwd" in the timed response
    Then the response progress and tool are visible
    And the timed command contains the current find match

  Scenario: Activity stays visible until the response completes
    Given the thread "Timed response" has a running response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    Then the response progress and tool are visible
    And the response has no worked-for row
    When the timed response completes
    Then the worked-for row shows "08:05" with its activity hidden
    And the finished answer stays visible

  Scenario: Activity revealed by Find stays available after closing Find
    Given the thread "Timed response" has a finished response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    And I find "pwd" in the timed response
    Then the response progress and tool are visible
    When I close Find
    Then the response progress and tool are visible
    When I toggle the worked-for row with "Enter"
    Then the worked-for row shows "08:05" with its activity hidden
    And the finished answer stays visible

  Scenario: Text-only answers show elapsed time without a disclosure
    Given the thread "Timed response" has a text-only response that took 485 seconds
    When I open the thread "Timed response" from the sidebar
    Then the worked-for row shows "08:05" without a collapse control
    And the finished answer stays visible

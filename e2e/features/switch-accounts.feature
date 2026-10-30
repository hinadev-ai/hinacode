Feature: Switch accounts
  A thread can move to another account of its agent when its own account runs out of plan.

  Scenario Outline: A limited thread continues on another account with room
    Given a Claude thread on "Personal" with a spent 5-hour window and an added "Work" account in the "<theme>" theme
    Then the thread warns that the 5-hour limit is reached on "Personal" and offers to switch to "Work"
    When I send a message to the account-limited thread
    Then the account-limited thread offers to continue on "Work"
    When I continue the account-limited thread on "Work"
    Then the thread runs the original prompt again on "Work" and becomes idle
    And the account picker shows "Personal" spent and "Work" with room

    Examples:
      | theme   |
      | default |

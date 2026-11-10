Feature: Routines
  A routine runs a prompt in a project on a schedule, from its webhook, or on demand. Every run
  starts a new thread and lands in the routine's run history.

  Background:
    Given a project "demo" for my repository
    And I open settings
    And I create a routine named "standup" in "demo" that runs every day at "09:30"

  Scenario: A new routine shows its schedule and next run
    Then the routine "standup" runs "Every day at 9:30 AM"
    And the routine "standup" has a next run

  Scenario: A disabled routine has no next run
    When I disable the routine "standup"
    Then the routine "standup" has no next run

  Scenario: Run now starts a thread
    When I run the routine "standup" now
    Then the run history of "standup" links to the thread it started

  Scenario: The webhook accepts the secret as a bearer token and rejects a wrong one
    When I get a new webhook secret for "standup"
    And a delivery for "standup" with the secret as a bearer token arrives
    Then the delivery is accepted
    When a delivery for "standup" with the wrong secret arrives
    Then the delivery is rejected with 401

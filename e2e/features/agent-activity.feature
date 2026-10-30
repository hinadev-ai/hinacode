Feature: Agent activity above the composer
  The agent's plan, its sub-agents and its background tasks share one tray docked on the composer.
  Background tasks, such as shells Claude starts with run_in_background, outlive the turn and each
  has a stop button. The simulated agent plans tasks, runs a sub-agent and starts two shells, so
  no real agent turn is needed to cover it.

  Scenario: Background shells show with the plan and sub-agent, and stop one at a time
    Given an isolated thread with a simulated agent that starts background shells
    When I send a message to the activity thread
    Then the activity tray shows the plan, the sub-agent and the shells "Start the dev server" and "Watch the unit tests"
    When I stop the background task "Start the dev server"
    Then only the background task "Watch the unit tests" is left
    When I stop the turn
    Then the background task "Watch the unit tests" is still running
    And the sidebar shows the thread working in the background

  Scenario: The commands list opens over the tray
    Given an isolated thread with a simulated agent that starts background shells
    When I send a message to the activity thread
    Then the activity tray shows the plan, the sub-agent and the shells "Start the dev server" and "Watch the unit tests"
    When I type "/" in the activity thread's message
    Then the commands list covers the activity tray

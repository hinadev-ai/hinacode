@mode:serial
Feature: Scenario isolation
  Every scenario on a worker starts from the same settings, whatever the scenario before it changed.

  Scenario: A scenario points Claude Code at its own binary and turns on the pull request guide
    Given the Claude Code CLI is installed
    And the pull request guide is turned on

  Scenario: The next scenario starts from the default settings
    Then the Claude Code binary and the pull request guide are at their defaults

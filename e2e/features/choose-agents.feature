@choose-agents
Feature: Choosing agents
  On first start HinaCode asks which coding agents to use. Only the chosen agents show up in the
  pickers afterwards, and Settings can turn the others back on.

  Scenario: First start asks which agents to use
    Given HinaCode has not asked which agents to use
    When the app reloads
    Then HinaCode asks which agents to use
    And Start is disabled until an agent is on
    When I turn on only "opencode" and "Claude Code"
    And I press Start
    Then the app opens
    And the enabled agents are "claude, opencode"

  Scenario: Settings turns an agent back on
    Given only "Claude Code" is enabled
    When I open settings
    And I open the settings section "Providers"
    Then the agent "Claude Code" cannot be turned off
    When I turn on the agent "Cursor"
    Then the enabled agents are "claude, cursor"

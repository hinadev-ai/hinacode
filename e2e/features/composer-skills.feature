Feature: Skill chips in the composer
  A skill at the start of a message shows as a chip before the text, so the developer sees which
  skill the agent will run. The simulated agent lists one skill and one of Claude Code's own
  commands, so no real agent turn is needed.

  Background:
    Given an isolated thread with a simulated agent that has a skill

  Scenario: The commands list says what each entry is and where a skill comes from
    When I type "/" in the message
    Then the commands list labels "/triage-issue" as "Project skill"
    And the commands list labels "/compact" as "Command"

  Scenario: A picked skill shows as a chip and starts the sent message
    When I type "/tri" in the message
    And I pick "/triage-issue" from the commands
    Then the message starts with the skill chip "triage-issue"
    When I type "the login test fails on CI" in the message
    And I send the message with its skill
    Then my message "/triage-issue the login test fails on CI" is in the thread

  Scenario: Backspace before the text removes the chip
    When I type "/triage-issue the login test" in the message
    Then the message starts with the skill chip "triage-issue"
    When I press Backspace at the start of the message
    Then the message has no skill chip and reads "the login test"

  Scenario: Claude Code's own commands stay plain text
    When I type "/compact keep the plan" in the message
    Then the message has no skill chip and reads "/compact keep the plan"

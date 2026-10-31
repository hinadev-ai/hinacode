Feature: Skill chips in the composer
  Every skill and command in a message shows as a chip, so the developer sees what the agent
  will get. The simulated agent lists two skills and one of Claude Code's own commands, so no real
  agent turn is needed.

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

  Scenario: Every skill in the message is a chip, before and after sending
    When I type "/triage-issue the login test, then /code-review。Again /triage-issue now" in the message
    Then the message shows the chips "/triage-issue", "/code-review" and "/triage-issue"
    When I send the message with its skill
    Then my sent message shows the chips "/triage-issue", "/code-review" and "/triage-issue"

  Scenario: Backspace after a chip removes it
    When I type "/triage-issue the login test" in the message
    Then the message starts with the skill chip "triage-issue"
    When I press Backspace right after the chip
    Then the message has no skill chip and reads "the login test"

  Scenario: Claude Code's own commands are chips too
    When I type "/compact keep the plan" in the message
    Then the message shows the chip "/compact"

Feature: Agent accounts
  The developer can see which account each agent bills to without opening a terminal.

  Scenario: The models tab shows who Claude Code is signed in as
    When I open the models settings with the simulated Claude Code account
    Then the models settings show "Signed in as dev@example.com" on "Claude Max" for "Example Org"

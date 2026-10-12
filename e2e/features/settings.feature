Feature: Settings
  Language, default models, keyboard shortcuts and integration secrets are chosen once and apply
  on every start.

  Scenario: Switching the language re-renders the app in Traditional Chinese
    When I open settings
    And I choose the language "繁體中文"
    Then the settings heading reads "設定"
    And the language "zh-TW" is saved

  Scenario: The saved language is applied at startup
    Given the saved language is "zh-TW"
    When the app restarts
    Then the sidebar is labelled "專案與討論串"

  Scenario: A default model preselects in the new thread composer
    Given a project "demo" for my repository
    When I open settings
    And I open the settings section "Models"
    And I choose the default model "Sonnet 5.5" for "Claude Code"
    Then the new thread composer for "demo" preselects the model "Sonnet 5.5"

  Scenario: The sidebar shortcut hides and shows the sidebar
    When I press "ControlOrMeta+b"
    Then the sidebar is hidden
    When I press "ControlOrMeta+b"
    Then the sidebar is shown

  Scenario: Recording a shortcut on the keybindings page rebinds the command
    When I open settings
    And I record the shortcut "ControlOrMeta+Shift+k" for "Show or hide sidebar"
    Then the shortcut "Mod+Shift+[KeyK]" is stored for "Show or hide sidebar"
    When I press "ControlOrMeta+Shift+k"
    Then the sidebar is hidden

  Scenario: Escape cancels a recording without changing the shortcut
    When I open settings
    And I open the settings section "Keybindings"
    And I start recording a shortcut for "New thread"
    Then the shortcut row for "New thread" reads "Press a shortcut…"
    When I press "Escape"
    Then the shortcut row for "New thread" does not read "Press a shortcut…"
    And no shortcut override is stored for "New thread"

  Scenario: Reusing a chord warns about the conflict and reset clears the override
    When I open settings
    And I record the shortcut "ControlOrMeta+b" for "New thread"
    Then the shortcut row for "New thread" reads "Also bound to Show or hide sidebar. Only one of them will run."
    When I reset the shortcut for "New thread"
    Then the shortcut row for "New thread" does not read "Also bound to"
    And no shortcut override is stored for "New thread"

  Scenario: A saved shortcut replaces the default after a restart
    Given the shortcut for "Show or hide sidebar" is saved as "mod+shift+k"
    When the app restarts
    And I press "ControlOrMeta+Shift+k"
    Then the sidebar is hidden
    And pressing "ControlOrMeta+b" leaves the sidebar hidden

  Scenario: A Linear API key is stored without ever being shown again, and can be cleared
    When I open settings
    And I open the settings section "Integrations"
    And I save the Linear API key "lin_api_test_not_real"
    Then the Linear API key status reads "A key is stored."
    And the secret "linear.apiKey" is stored
    When I clear the Linear API key
    Then the Linear API key status reads "No key stored."
    And the secret "linear.apiKey" is not stored

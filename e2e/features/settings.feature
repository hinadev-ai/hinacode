Feature: Settings
  Language and keyboard shortcuts are chosen once and apply on every start.

  Scenario: Switching the language re-renders the app in Traditional Chinese
    When I open settings
    And I choose the language "繁體中文"
    Then the settings heading reads "設定"
    And the language "zh-TW" is saved

  Scenario: The saved language is applied at startup
    Given the saved language is "zh-TW"
    When the app restarts
    Then the sidebar is labelled "專案與討論串"

  Scenario: The sidebar shortcut hides and shows the sidebar
    When I press "Control+b"
    Then the sidebar is hidden
    When I press "Control+b"
    Then the sidebar is shown

  Scenario: Recording a shortcut on the keybindings page rebinds the command
    When I open settings
    And I record the shortcut "Control+Shift+k" for "Show or hide sidebar"
    Then the shortcut "mod+shift+k" is stored for "Show or hide sidebar"
    When I press "Control+Shift+k"
    Then the sidebar is hidden

  Scenario: A saved shortcut replaces the default after a restart
    Given the shortcut for "Show or hide sidebar" is saved as "mod+shift+k"
    When the app restarts
    And I press "Control+Shift+k"
    Then the sidebar is hidden
    And pressing "Control+b" leaves the sidebar hidden

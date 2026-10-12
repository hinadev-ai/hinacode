Feature: Appearance
  System appearance follows the desktop, while explicit themes and fonts survive a restart.

  Scenario: System follows appearance changes while the app is open
    When I open settings
    And I open appearance settings
    And I choose the theme "System"
    And the system appearance changes to "light"
    Then the app uses the "light" appearance
    When the system appearance changes to "dark"
    Then the app uses the "dark" appearance
    When the system appearance changes to "light"
    Then the app uses the "light" appearance

  Scenario Outline: Explicit appearance survives restart and ignores the system
    When I open settings
    And I open appearance settings
    And I choose the theme "<theme>"
    Then the theme "<id>" is saved
    When the system appearance changes to "<opposite>"
    Then the app uses the "<scheme>" appearance
    When the app restarts
    Then the app uses the "<scheme>" appearance
    And the theme "<id>" is saved

    Examples:
      | theme | id      | scheme | opposite |
      | Light | light   | light  | dark     |
      | Dark  | default | dark   | light    |

  Scenario: Existing named themes and fonts are preserved
    Given an existing named theme and font preference
    When the app restarts
    Then the app uses the "light" appearance
    And the existing named theme and font preference is preserved

  Scenario Outline: Default appearances keep text and keyboard focus readable
    When I open settings
    And I open appearance settings
    And I choose the theme "<theme>"
    Then text and keyboard focus meet contrast requirements

    Examples:
      | theme |
      | Light |
      | Dark  |

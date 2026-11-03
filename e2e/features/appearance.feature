Feature: Appearance
  System appearance follows the desktop, while explicit themes and fonts survive a restart.

  Scenario: System follows appearance changes while the app is open
    When I open settings
    And I open appearance settings
    And I choose the theme "System"
    And the system appearance changes to "light"
    Then the app uses the "light" appearance
    And the app paints the "hina-light" theme
    When the system appearance changes to "dark"
    Then the app uses the "dark" appearance
    And the app paints the "hina-dark" theme
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
      | theme         | id      | scheme | opposite |
      | Neutral Light | light   | light  | dark     |
      | Neutral Dark  | default | dark   | light    |

  Scenario: Existing named themes and fonts are preserved
    Given an existing named theme and font preference
    When the app restarts
    Then the app uses the "light" appearance
    And the existing named theme and font preference is preserved

  Scenario Outline: Hina and neutral themes keep text and keyboard focus readable at every contrast
    When I open settings
    And I open appearance settings
    And I choose the theme "<theme>"
    And I move the contrast slider to "<contrast>"
    Then text and keyboard focus meet contrast requirements

    Examples:
      | theme         | contrast |
      | Hina Light    | Standard |
      | Hina Light    | Lowest   |
      | Hina Light    | Highest  |
      | Hina Dark     | Standard |
      | Hina Dark     | Lowest   |
      | Hina Dark     | Highest  |
      | Neutral Light | Standard |
      | Neutral Light | Lowest   |
      | Neutral Light | Highest  |
      | Neutral Dark  | Standard |
      | Neutral Dark  | Lowest   |
      | Neutral Dark  | Highest  |

  Scenario: Higher contrast brightens text and survives restart
    When I open settings
    And I open appearance settings
    And I choose the theme "Neutral Dark"
    And I move the contrast slider to "Highest"
    Then text reads at higher contrast than the palette
    And the contrast 100 is saved
    When the app restarts
    Then text reads at higher contrast than the palette

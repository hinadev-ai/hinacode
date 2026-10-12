Feature: Appearance startup
  A saved appearance is ready when the native window opens and at its first contentful paint.

  # Waiting until after startup could hide an incorrect initial palette or an empty visible window.
  Scenario Outline: The window opens with the saved appearance
    Given the saved neutral appearance is "<theme>"
    When the app restarts
    Then the first visible window uses the "<scheme>" appearance
    And the first contentful paint uses the "<scheme>" appearance

    Examples:
      | theme   | scheme |
      | light   | light  |
      | default | dark   |

Feature: Focus after a shortcut overlay closes
  A palette or picker opened by a shortcut has no trigger to hand focus back to. Escape puts focus back where it was,
  or in the open thread's message box, never on a button an earlier popover was opened from.

  Background:
    Given a project "demo" for my repository
    And the project "demo" has a thread "Add palette"
    When I open the thread "Add palette" from the sidebar
    And I open and close the machine resources popover

  Scenario Outline: Escape returns focus to the message box it came from
    When I click the message box
    And I press "<keys>"
    And I press "Escape"
    Then the message box is focused

    Examples:
      | keys                   |
      | ControlOrMeta+p        |
      | ControlOrMeta+Shift+s  |
      | ControlOrMeta+Shift+n  |

  Scenario Outline: Escape focuses the message box when nothing had focus
    When nothing has focus
    And I press "<keys>"
    And I press "Escape"
    Then the message box is focused

    Examples:
      | keys                   |
      | ControlOrMeta+p        |
      | ControlOrMeta+Shift+s  |
      | ControlOrMeta+Shift+n  |
      | ControlOrMeta+Alt+.    |

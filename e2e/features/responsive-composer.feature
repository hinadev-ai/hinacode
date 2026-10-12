@responsive-composer
Feature: Responsive composer
  Secondary panels give the conversation room at the minimum window size and enlarged text.

  Scenario Outline: Composing keeps message actions inside the window
    Given a project "demo" for my repository
    And the project "demo" has an <status> responsive thread "Compose"
    When I open the thread "Compose" from the sidebar
    And I use a <width> by <height> viewport with <fontSize> pixel text
    And I compose a long draft
    Then the message field and <action> action fit inside the window

    Examples:
      | width | height | fontSize | status  | action |
      | 720   | 480    | 16       | idle    | Send   |
      | 720   | 480    | 16       | running | Stop   |
      | 720   | 480    | 32       | idle    | Send   |
      | 720   | 480    | 32       | running | Stop   |
      | 320   | 480    | 16       | idle    | Send   |
      | 320   | 480    | 16       | running | Stop   |
      | 360   | 240    | 16       | idle    | Send   |
      | 360   | 240    | 16       | running | Stop   |

  Scenario: Compact secondary panels can be opened and dismissed with the keyboard
    Given a project "demo" for my repository
    And the project "demo" has an idle responsive thread "Compose"
    When I open the thread "Compose" from the sidebar
    And I use a 320 by 480 viewport with 16 pixel text
    Then I can open and dismiss both secondary panels with the keyboard

  Scenario: App zoom keeps composing usable at the minimum window size
    Given a project "demo" for my repository
    And the project "demo" has an idle responsive thread "Compose"
    When I open the thread "Compose" from the sidebar
    And I enlarge the minimum window to 200 percent
    And I compose a long draft
    Then the message field and Send action fit inside the window

  Scenario: Image attachments leave room to edit and send an enlarged draft
    Given a project "demo" for my repository
    And the project "demo" has an idle responsive thread "Compose"
    When I open the thread "Compose" from the sidebar
    And I enlarge the minimum window to 200 percent
    And I paste 8 images into the message
    And I compose a long draft
    Then the message field and Send action fit inside the window

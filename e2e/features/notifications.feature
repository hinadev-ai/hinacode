Feature: Notifications
  A thread the developer is not looking at pulls them back when it finishes, fails or waits on them.

  Background:
    Given a project "demo" for my repository
    And the project "demo" has a thread "Background"
    And the project "demo" has a thread "Foreground"
    And every notification kind is turned on
    And desktop notifications are captured
    When I open the thread "Foreground" from the sidebar

  Scenario Outline: A thread that is not open notifies when its turn changes
    When the agent in "Background" emits "<event>"
    Then the only notification is for "Background" and reads "<body>"

    Examples:
      | event              | body                         |
      | turn_completed     | Finished                     |
      | approval_requested | Waiting for your approval    |
      | secret_requested   | Waiting for a secret         |
      | turn_failed        | Failed: Turn interrupted     |
      | turn_limited       | Stopped at the usage limit   |

  Scenario: The open thread stays quiet while the window has focus
    Given the window has focus
    When the agent in "Foreground" emits "turn_completed"
    And the agent in "Background" emits "turn_completed"
    Then the only notification is for "Background" and reads "Finished"

  Scenario: Clicking a notification opens its thread
    When the agent in "Background" emits "turn_completed"
    And I click the notification for "Background"
    Then the thread "Background" is open

  Scenario: A kind turned off in settings stays quiet
    When I open settings
    And I open the settings section "Notifications"
    And I turn off the setting "Finished turns"
    And the agent in "Background" emits "turn_completed"
    And the agent in "Background" emits "turn_failed"
    Then the only notification is for "Background" and reads "Failed: Turn interrupted"

  Scenario: Clicking a notification restores the minimized window
    When the agent in "Background" emits "turn_completed"
    And I minimize the notification window
    And I click the notification for "Background"
    Then the thread "Background" is open
    And the notification window is restored and focused

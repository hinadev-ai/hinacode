Feature: Notifications
  A thread the developer is not looking at pulls them back when it finishes, fails or waits on them:
  with a desktop notification while they are in another app, and a toast while they are in kkcode.

  Background:
    Given a project "demo" for my repository
    And the project "demo" has a thread "Background"
    And the project "demo" has a thread "Foreground"
    And every notification kind is turned on
    And desktop notifications are captured
    When I open the thread "Foreground" from the sidebar

  Scenario Outline: A thread notifies the desktop while the window is in the background
    Given the window does not have focus
    When the agent in "Background" emits "<event>"
    Then the only notification is for "Background" and reads "<body>"

    Examples:
      | event              | body                       |
      | turn_completed     | Finished                   |
      | approval_requested | Waiting for your approval  |
      | secret_requested   | Waiting for a secret       |
      | turn_failed        | Failed: Turn interrupted   |
      | turn_limited       | Stopped at the usage limit |

  Scenario: Clicking a desktop notification opens its thread
    Given the window does not have focus
    When the agent in "Background" emits "turn_completed"
    And I click the notification for "Background"
    Then the thread "Background" is open

  Scenario: A thread that is not open shows a toast while the window has focus
    Given the window has focus
    When the agent in "Foreground" emits "turn_completed"
    And the agent in "Background" emits "approval_requested"
    Then the only toast is for "Background" and reads "Waiting for your approval"
    And no desktop notification was shown

  Scenario: Opening a toast opens its thread
    Given the window has focus
    When the agent in "Background" emits "turn_failed"
    And I open the toast for "Background"
    Then the thread "Background" is open

  Scenario: A kind turned off in settings stays quiet
    Given the window does not have focus
    When I open settings
    And I open the settings section "Notifications"
    And I turn off the setting "Finished turns"
    And the agent in "Background" emits "turn_completed"
    And the agent in "Background" emits "turn_failed"
    Then the only notification is for "Background" and reads "Failed: Turn interrupted"

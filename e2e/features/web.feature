@web
Feature: Web app
  The desktop UI runs in a browser against a machine the relay lists, over the machine's remote socket.

  Scenario: Signing in lists the relay's machines and picking one loads the app
    Given I open the web app
    When I sign in to the relay with the owner token "not-the-token"
    Then the sign-in form says "The relay refused this token. Copy the current one from the desktop."
    When I sign in to the relay with my owner token
    Then the machine picker lists my machine
    When I pick my machine
    Then the app runs against my machine

  Scenario: Reloading goes straight back to the picked machine
    Given I signed in to the web app and picked my machine
    When I reload the web app
    Then the app runs against my machine without asking to sign in

  Scenario: A project added by path talks to the agent on the machine
    Given I signed in to the web app and picked my machine
    When I open the Add project dialog on the web
    Then the dialog has no Browse button
    When I add the project "web" by typing the path of the machine's repository
    And I start a new thread in "web" on the web
    And I send "Show me some Markdown" from the web
    Then the agent's Markdown reply streams into the web thread

  Scenario: An image in the project previews through the service worker
    Given the machine has a project "pics" whose repository holds the image "pixel.png"
    And I signed in to the web app and picked my machine
    When I start a new thread in "pics" on the web
    And I open "pixel.png" from the Files tab on the web
    Then the image "pixel.png" loads in the file viewer

  Scenario: The app shows when the machine drops and comes back
    Given I signed in to the web app and picked my machine
    When the machine stops
    Then the web app says it is reconnecting to my machine
    When the machine starts again
    Then the reconnecting bar goes away

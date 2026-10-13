Feature: Browser
  The thread's Browser view opens the dev server it runs, and an element picked there goes into the
  message as a screenshot with its selector and markup.

  Background:
    Given a project "demo" for my repository
    And the project "demo" has a thread "Shop"
    And I open the thread "Shop" from the sidebar
    And my repository serves a shop page

  Scenario: Clicking an element on a page with a long address adds it to the message
    When I open the shop page with a 2100-character query in the browser
    And I click the Buy now button while selecting an element
    Then the message has the element "button.buy.primary"
    And the shop page did not see the click

  Scenario: Arrow keys and Enter pick an element
    When I open the shop page in the browser
    And I pick the heading with the keyboard
    Then the message has the element "h1"

Feature: Find in thread
  Find reaches every command the agent ran, including back-to-back commands folded into one line.

  Background:
    Given a project "demo" for my repository
    And the project "demo" has a thread "Commands"
    When I open the thread "Commands" from the sidebar

  Scenario: Find reveals a folded command and marks it
    Given the agent finished a turn in "Commands" with
      | kind    | text                            | description  |
      | command | printf kkcode_group_find_unique | Print marker |
      | command | pwd                             |              |
    When I find "kkcode_group_find_unique" in the thread
    Then Find counts "1 of 1"
    And the current match is in the command "printf kkcode_group_find_unique"
    When I toggle the command group "Ran 2 commands"
    Then the command row "printf kkcode_group_find_unique" is hidden
    When I go to the next match
    Then Find counts "1 of 1"
    And the current match is in the command "printf kkcode_group_find_unique"

  Scenario: Find shows a match past the end of a long command's truncated row
    Given the agent finished a turn in "Commands" running a command that prints 500 "x" then "kkcode_tail_find_unique"
    When I find "kkcode_tail_find_unique" in the thread
    Then Find counts "1 of 1"
    And the current match is in a command row that shows the whole command ending in "kkcode_tail_find_unique"

  Scenario: Find shows a long command description in full while its match is current
    Given the agent finished a turn in "Commands" running "printf ready" described by 500 "x" then "kkcode_description_find_unique"
    When I find "kkcode_description_find_unique" in the thread
    Then Find counts "1 of 1"
    And the current match is in a command row that shows its whole label
    When I close Find
    Then the command description ending in "kkcode_description_find_unique" is truncated again

  Scenario: Find steps between a folded command and later reply text
    Given the agent finished a turn in "Commands" with
      | kind    | text                                       | description  |
      | command | printf kkcode_group_find_unique            | Print marker |
      | command | pwd                                        |              |
      | text    | The marker kkcode_group_find_unique printed. |            |
    When I find "kkcode_group_find_unique" in the thread
    Then Find counts "2 of 2"
    And the current match is in the reply "The marker kkcode_group_find_unique printed."
    When I go to the previous match
    Then Find counts "1 of 2"
    And the current match is in the command "printf kkcode_group_find_unique"
    When I go to the next match
    Then Find counts "2 of 2"
    And the current match is in the reply "The marker kkcode_group_find_unique printed."

  Scenario: Find marks a command's description and leaves disclosure to the reader once closed
    Given the agent finished a turn in "Commands" with
      | kind    | text                            | description  |
      | command | printf kkcode_group_find_unique | Print marker |
      | command | pwd                             |              |
    When I find "print marker" in the thread
    Then Find counts "1 of 1"
    And the current match is in the command description "Print marker"
    When I close Find
    Then nothing in the thread is marked
    When I toggle the command group "Ran 2 commands"
    Then the command row "Print marker" is hidden
    When I toggle the command group "Ran 2 commands"
    Then the command row "Print marker" is shown

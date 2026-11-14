Feature: Threads
  A thread is one agent conversation inside a project. The sidebar groups threads under their
  project and lets the user filter, reorder, rename, archive and delete them.

  Background:
    Given a project "demo" for my repository

  Scenario: Starting a thread again in a project brings back its draft as it was left
    Given the project "demo" has a thread "One"
    When I start a new thread in "demo"
    And I type "half a thought" into the composer
    And I open the thread "One" from the sidebar
    And I start a new thread in "demo"
    Then a new thread is open with the composer focused
    And the composer holds "half a thought"

  Scenario: An empty draft stays out of the sidebar, and one with content is listed, after a restart too, until it is emptied
    When I start a new thread in "demo"
    Then the sidebar does not list the open draft
    When I type "a second thought" into the composer
    Then the sidebar lists the unsent thread "a second thought"
    When the app restarts
    Then the sidebar lists the unsent thread "a second thought"
    When I discard the unsent thread "a second thought"
    Then the sidebar does not list the open draft

  Scenario: Writing in a thread marks it as unsent and leaves it in place
    Given the project "demo" has a thread "One"
    And the project "demo" has a thread "Two"
    When I rename the thread "Two" to "Second"
    And I open the sidebar tab "Inbox"
    Then the open tab lists the threads "Second, One" in that order
    When I open the thread "One" from the sidebar
    And I type "half a thought" into the composer
    Then the thread "One" is marked as unsent
    And the open tab lists the threads "Second, One" in that order

  Scenario: A project group collapses and expands its threads
    Given the project "demo" has a thread "One"
    When I collapse the threads of "demo"
    Then the sidebar does not list the thread "One"
    When I expand the threads of "demo"
    Then the sidebar lists the thread "One"

  Scenario: A thread moves within its project by keyboard and the order is saved
    Given the project "demo" has a thread "One"
    And the project "demo" has a thread "Two"
    When I move the thread "Two" up with the keyboard
    Then the sidebar lists the threads "Two, One" in that order
    When the app restarts
    Then the sidebar lists the threads "Two, One" in that order

  Scenario: An archived thread moves under Archived and can be brought back
    Given the project "demo" has a thread "Done"
    When I archive the thread "Done" from its menu
    Then the sidebar does not list the thread "Done"
    And the thread "Done" is stored as "archived"
    When I open the sidebar tab "Inbox"
    And I expand the Archived threads
    Then the sidebar lists the thread "Done"
    When I unarchive the thread "Done"
    And I open the sidebar tab "Threads"
    Then the sidebar lists the thread "Done"
    And the thread "Done" is stored as "idle"

  Scenario: A settled thread stays idle, keeps its place under Settled, and comes back with Undo
    Given the project "demo" has a thread "Oops"
    When I open the sidebar tab "Inbox"
    And I settle the thread "Oops" from its row
    Then the sidebar does not list the thread "Oops"
    And the thread "Oops" is stored as "idle"
    When I expand the Settled threads
    Then the sidebar lists the thread "Oops"
    When I undo from the toast
    Then the sidebar lists the thread "Oops"
    And the thread "Oops" is stored as "idle"

  Scenario: Archiving a thread far down the sidebar keeps the sidebar scrolled there
    Given the project "demo" has 40 threads named "Task"
    When I scroll the sidebar to the thread "Task 40"
    And I archive the thread "Task 40" from its menu
    Then the sidebar does not list the thread "Task 40"
    And the thread "Task 39" is in view in the sidebar

  Scenario: The Archived shelf opens one page of a long history and loads more while scrolling
    Given the project "demo" has 120 archived threads named "Old"
    When I show only the project "demo" in the sidebar
    And I open the sidebar tab "Inbox"
    And I expand the Archived threads
    Then the sidebar lists 50 threads
    And the sidebar lists the thread "Old 120"
    And the sidebar does not list the thread "Old 40"
    When I scroll to the end of the sidebar
    Then the sidebar lists 100 threads
    And the sidebar lists the thread "Old 40"
    When I scroll to the end of the sidebar
    Then the sidebar lists 120 threads

  Scenario: Filtering the Archived shelf finds threads past the first page
    Given the project "demo" has 120 archived threads named "Old"
    When I show only the project "demo" in the sidebar
    And I open the sidebar tab "Inbox"
    And I filter the sidebar by "Old 120"
    And I expand the Archived threads
    Then the sidebar lists 1 thread
    And the sidebar lists the thread "Old 120"

  Scenario: Ready lists every project's read threads, most recently updated first
    Given the project "demo" has a thread "Fix login"
    And another project "tools" has a thread "Bump deps"
    When I rename the thread "Bump deps" to "Bump all deps"
    And I open the sidebar tab "Inbox"
    Then the open tab lists the threads "Bump all deps, Fix login" in that order
    When the app restarts
    Then the open tab lists the threads "Bump all deps, Fix login" in that order

  Scenario: A pinned thread moves above the tabs, after a restart too, until it is unpinned
    Given the project "demo" has a thread "Keep"
    And the project "demo" has a thread "Other"
    When I pin the thread "Keep" from its menu
    Then the pinned threads are "Keep"
    And the open tab does not list the thread "Keep"
    When the app restarts
    Then the pinned threads are "Keep"
    When I unpin the thread "Keep" from its menu
    Then no thread is pinned
    And the open tab lists the threads "Keep, Other" in that order

  Scenario: A thread snoozed until a typed time waits under Snoozed, after a restart too, until it is unsnoozed
    Given the project "demo" has a thread "Later"
    And I open the sidebar tab "Inbox"
    When I snooze the thread "Later" until "monday 8:00" from its menu
    Then the snoozed threads are "Later"
    When the app restarts
    Then the snoozed threads are "Later"
    When I unsnooze the thread "Later" from its menu
    Then no thread is snoozed
    And the open tab lists the thread "Later"

  Scenario: A row's menu opens from a click that lands before the row registers the pointer
    Given the project "demo" has a thread "Moved"
    And I open the sidebar tab "Inbox"
    When I click the menu button of the thread "Moved" with the pointer resting elsewhere
    Then the thread menu offers "Snooze…"

  Scenario Outline: Enter on a time the picker can't use keeps it open, until a preset is picked with the keyboard
    Given the project "demo" has a thread "Later"
    And I open the sidebar tab "Inbox"
    When I type "<time>" into the snooze picker of the thread "Later" and press Enter
    Then the snooze picker is still open and says "<problem>"
    When I pick the next snooze preset with the keyboard
    Then the snoozed threads are "Later"

    Examples:
      | time           | problem              |
      | yesterday 9:00 | That time has passed |

  @desktop
  Scenario: A thread's ID is copied from its row menu, to point another agent at it
    Given the project "demo" has a thread "Handoff"
    When I copy the ID of the thread "Handoff" from its menu
    Then the clipboard holds the ID of the thread "Handoff"

  Scenario: The sidebar filter matches thread titles and project names
    Given the project "demo" has a thread "Fix login"
    And the project "demo" has a thread "Write docs"
    And another project "tools" has a thread "Bump deps"
    When I filter the sidebar by "login"
    Then the sidebar lists the thread "Fix login"
    And the sidebar does not list the thread "Write docs"
    And the sidebar does not list the thread "Bump deps"
    When I filter the sidebar by the name of the project "tools"
    Then the sidebar lists the thread "Bump deps"
    And the sidebar does not list the thread "Fix login"

  Scenario: The project filter shows only the chosen projects, after a restart too
    Given the project "demo" has a thread "Fix login"
    And another project "tools" has a thread "Bump deps"
    When I show only the project "tools" in the sidebar
    Then the sidebar lists the thread "Bump deps"
    And the sidebar does not list the thread "Fix login"
    When the app restarts
    Then the sidebar lists the thread "Bump deps"
    And the sidebar does not list the thread "Fix login"

  Scenario: A thread row outside a git repository keeps its height on hover
    Given another project "notes" has a thread "Jot"
    Then the row of the thread "Jot" keeps its height when hovered

  Scenario: A thread is deleted after confirmation
    Given the project "demo" has a thread "Gone"
    When I delete the thread "Gone" from its menu
    Then the thread "Gone" no longer exists

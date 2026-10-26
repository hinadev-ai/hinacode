# Resizable panels

The sidebar and docked thread details panel resize by pointer or keyboard. Their widths persist in local storage, and so do the terminal drawer height, the Files tree height and the Git graph split. The details panel keeps separate normal and wide preferences, so opening a file or diff does not overwrite the width used for other views. Double-click restores the default for the current size.

The right panel must leave a usable conversation beside the sidebar and activity bar. Its displayed maximum is the smaller of 960 pixels, half the window, and the space left in the main area after the activity bar and a conversation column with a 200-pixel message field plus its padding and borders. At 16-pixel text, that column is 246 pixels wide. When there is not enough room for the 280-pixel panel minimum as well, the panel uses the existing overlay layout.

The display cap does not rewrite a saved width when the window or sidebar changes. A wider saved preference returns when space becomes available. Dragging and keyboard input obey the current displayed bounds, and the separator reports those same bounds to assistive technology.

Tracking writes widths directly, without an animated delay. A drag that loses its panel must release the document cursor and text-selection styles. Normal and wide defaults still transition when the selected view changes, with reduced motion respected.

Verify with the real Electron resizable-panel scenarios: drag and reload, arrows and Home/End, double-click reset, sidebar regression, interrupted drag, and a narrow window with both panels enlarged. Check both themes and restart once to confirm saved preferences.

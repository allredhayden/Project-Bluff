# Silent messages design QA

final result: passed

## Visual target and evidence

The user selected the first displayed mockup's layout and the second displayed mockup's font, sizing, and placement. Both are the source of truth; the later generated combination was not used to override those choices.

- Layout source: `output/text-messages/selected-layout.png`.
- Typography/placement source: `output/text-messages/selected-typography.png`.
- Final browser captures: `output/text-messages/billboard-clear-390.png` and `output/text-messages/conversation-clear-390.png`.
- Full-view comparison after the requested Clear buttons: `output/text-messages/clear-comparison.png`. Original implementation comparison: `output/text-messages/design-comparison.png`.
- Focused Billboard typography/placement comparison: `output/text-messages/billboard-comparison.png`.
- Additional captures: `controller-390.png`, `controller-320.png`, `conversation-320.png`, `billboard-landscape.png`, and `compact-editing.png` in the same directory.

The source images are 1244 × 1264 px concept boards. The layout screen crop is 545 × 1036 px, the typography Conversation crop is 571 × 1077 px, and the typography Billboard crop is 575 × 1077 px. Crops were scaled proportionally to 390 px wide and padded for comparison, never stretched to invent identical viewport proportions. Source boards are illustrative rather than exact CSS dimensions. Implementation screenshots are 390 × 844 px at a 390 × 844 CSS viewport, density 1. Comparison state: displayed Billboard message `Can we talk?`; Conversation at 36 px with the three sample paragraphs and its keyboard dismissed.

## Findings and comparison history

No actionable P0/P1/P2 findings remain.

1. Initial browser review found landscape Billboard confined to the existing controller's 460 px content width. This reduced the available message area (P2). The text sheet now uses the full viewport width with safe-area padding. A new 844 × 390 browser capture confirmed an 828 px message area and automatic refitting without overflow.
2. The source/implementation comparison found Billboard vertically centered despite the selected second mockup's placement beneath the controls (P2). Changed `.billboard-stage` to align content at the top. The final capture and focused comparison show the large, left-aligned message directly below the control rail.
3. Added a compact layout for less than 300 px of visible height, including when a keyboard reduces the usable screen. Conversation's Done action moves into the size rail. At 390 × 240 the editable document retains 136 px of height, and Done, sizing, mode switching, and Escape remain usable.

## Required fidelity surfaces

- **Fonts/typography:** system sans-serif, regular weight and 36 px default for Conversation; bold 800 weight, tight 1.02 line height, and left alignment for Billboard. Conversation size is explicitly adjusted in 4 px steps from 16 to 72 px. Billboard measures real text wrapping and manual line breaks to select the largest fitting size. No viewport-based scaling of UI labels or Conversation text.
- **Spacing/layout:** the first mockup's back row, equal-width mode tabs, control rail, and Conversation footer are retained. Compact mobile padding and square controls match the repository guide. Main text controls are at least 44 px high. Keyboard space uses the compact exception described above.
- **Colors/tokens:** uses the existing charcoal, warm white, muted text, and orange command tokens. Flat surfaces, crisp borders, no gradients, rounded authored controls, shadows, or decorative effects.
- **Image/asset fidelity:** the selected screens contain editable text and controls, with no raster assets to recreate. Existing controller assets remain intact. The back action is a plain text button rather than a newly drawn icon.
- **Copy/content:** Billboard and Conversation keep separate drafts. Conversation is one document, with literal user-entered line breaks and no chat bubbles, speaker labels, send actions, or remote-chat concepts. Sample copy was matched in captures.

## Interaction and regression verification

- Open TEXT from the controller's top header; switch modes; edit Billboard; show fitted text; return to Soundtrack.
- Edit one shared Conversation document, preserve exact paragraphs, adjust size, retain the editing focus and insertion point, and dismiss editing with Done.
- Verify 16/72 px limits disable the corresponding size controls.
- Verify separate drafts and size survive refresh of the same tab; a separate tab starts empty.
- Verify plain paragraphs and manual newlines; fit a multi-line message and an unbroken long word.
- Verify the 320 × 568 header/document layout, 844 × 390 landscape fitting, and 390 × 240 compact editing layout.
- Verify keyboard tab navigation, focus trapping, inert underlying controls, Escape, and focus restoration to TEXT.
- On the isolated static preview with audio muted, start Night, open and close text, and verify Night remains active with its timer continuing. Stop the test cue afterward. No lighting hardware was exercised.
- Browser console checks returned no errors or warnings.
- Python suite: 82 passed, including static serving and existing loopback networking tests.
- Node suites: 34 passed, including three new tests for message isolation from network/shared state, tab-session restoration, and unavailable browser storage.
- JavaScript syntax checks and `git diff --check` passed.

Messages use only the current tab's session storage and in-memory state. The module does not call the shared control API or connect to a network. Serving its static script is supported by both the Flask route whitelist and the offline app shell.

## Test limits and follow-up polish

Browser verification used the Codex in-app browser at phone-sized viewports. Real iPhone Safari keyboard, notch safe areas, and physical screen rotation were not exercised on a connected device; visual viewport events and safe-area CSS support those conditions. The generated reference fonts are unspecified, so native font glyph metrics differ slightly by platform. Neither limitation is presented as exact physical-device validation.

Implementation checklist complete; no remaining design fixes.

## Follow-up: keyboard background and Clear controls

The user reported that the main controller could be seen behind text editing and requested a Clear button for both modes. These changes are explicit additions to the selected visual target.

- While text mode is open, `main.app` is hidden using visibility and has pointer events disabled, preserving its layout and running audio. It remains inert. Capture-phase click, pointer, and keyboard guards also prevent controller activation when native inert support is unavailable.
- Each mode has a square, red Clear control in its top rail. It erases only that mode's draft and saved session text, preserves Conversation size, and keeps an active editor focused for the next message.
- Browser checks confirmed the controller has `visibility: hidden`, `pointer-events: none`, and the inert attribute while editing. Its controls are absent from the visible accessibility snapshot. Closing text mode restores visibility and pointer input and removes inert.
- Clear worked in both editors and the Billboard display. Cleared drafts stayed empty after reload. Conversation retained its chosen font size and editing focus.
- At 320 × 240, both size buttons, Clear, and Done fit within the 304 px top rail; all button targets remain 44 px high. Evidence: `output/text-messages/compact-clear-320.png`.
- The updated source/implementation comparison was opened and reviewed. The added red controls follow the repository's destructive-control tokens; layout and typography otherwise retain the approved design. No new P0/P1/P2 findings.
- All 37 frontend tests, JavaScript syntax checks, and whitespace checks passed. The three new regression tests cover controller input blocking, mode-specific clearing and persistence, and Billboard clearing during editing. Browser console checks were empty.

final result: passed

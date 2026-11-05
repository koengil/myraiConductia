# Ignatious Pitch Deck Template

The output deck MUST be built on the firm's branded template, which ships with this plugin:

`references/Ignatious Powerpoint Template May 2026 for Claude.potx`

This is the May 2026 version. `.potx` is a PowerPoint *template*; save the working deck as a normal `.pptx`.

## Working copy

Never edit the `.potx` in place. At the start of deck population, copy it into the working directory under a clean, space-free name (e.g. `aapl_pitch.pptx`) and build on that copy. Spaces in the original filename break some CLI conversion steps (LibreOffice, `pdftoppm`), and keeping the original pristine preserves a clean baseline.

## Slide map

The template contains six reference slides. Four are reusable layouts you duplicate as needed; two are fixed brand slides you append unchanged.

| # | Slide | Role | Use |
|---|-------|------|-----|
| 1 | Cover | Title + date | One per deck. Replace "Sample Title" with the engagement title; replace "Month XX, XXXX" with the deck date. |
| 2 | Agenda | Numbered sections | One per deck. List the deck's sections; the numbering must match the dividers. |
| 3 | Divider | Section break | **Duplicate — one per section.** Insert before each section's content slides. |
| 4 | Content | Title + subtitle + body | **Duplicate — one per content slide.** The workhorse layout for situation overview, company snapshot, comps, precedents, football field, DCF, LBO, process, etc. |
| 5 | Legal Disclaimer | Fixed | **Always second-to-last. Do not edit.** Finalis / Ignatious regulatory boilerplate. |
| 6 | Back cover | Fixed | **Always last. Do not edit.** Firm tagline + contact details. |

## Assembly order

1. Cover (slide 1)
2. Agenda (slide 2)
3. For each section: Divider (copy of slide 3) → one or more Content slides (copies of slide 4)
4. Legal Disclaimer (slide 5) — always second-to-last
5. Back cover (slide 6) — always last

## Do not touch

Slides 5 and 6 carry regulated disclosure language and firm brand/contact details. Keep them **verbatim** and **always at the end of the deck, in that order**. Securities are offered through Finalis Securities LLC (Member FINRA / SIPC); Ignatious is not a registered broker-dealer — do not alter or contradict this language anywhere in the deck.

---
name: pptx-ignatious-branding-v6
description: "Use this skill any time someone at Ignatious wants to reformat, improve, or convert an existing PowerPoint presentation to match the Ignatious brand. Triggers include: 'make this on-brand', 'reformat this deck', 'apply Ignatious template', 'clean up this presentation', 'make this look professional', 'convert to Ignatious style', or any request involving improving the visual quality or branding of a .pptx or .potx file. Also use when someone says a deck 'doesn't look right', 'looks off-brand', or asks for it to look like it came from a top bank. Always use this skill — do not guess at brand colors or fonts without reading the brand guide."
---

# Ignatious PowerPoint Branding Skill

This skill reformats an existing PowerPoint presentation so it meets Ignatious brand standards — the kind of quality expected from a top-tier investment bank like Goldman Sachs.

**The north star is PREMIUM.** Every decision — fills, lines, labels, spacing — should ask: "Does this look like it came from a top-tier bank, or does it look off-the-shelf?" If something looks generic, flat, or hard-edged, it is wrong. Fix it.

**Before doing anything else**, read the brand guide:
```
references/brand-guide.md
```
It contains the complete color palette, font specs, logo placement rules, slide layout library, and editorial tone. Do not rely on memory for hex codes or layout details — always load it fresh.

---

## Main Output of the Skill

The primary output of this skill is to point out to the user why certain parts/areas/elements of the uploaded slide do not work, and how this skill would make those changes. The purposes of this primary output is to workaround system limitations. A secondary output is the revised PPT file, but make a note on workstreams the skill was not able to carry out.

## Known Limitations — Read Before Starting

This section is critical. Some brand-quality improvements **cannot be verified visually** from the server-side PDF preview and some **cannot be automated at all**. Always communicate these to the user upfront.

### What This Skill CAN Do (via XML editing)
- Replace `solidFill` with `gradFill` on all diagram shapes (pyramid tiers, process boxes, ovals)
- Change fonts from Calibri or any non-Arial font to Arial throughout
- Make titles bold and set correct point sizes
- Adjust line stroke widths (e.g. tier dividers from thick to thin/semi-transparent)
- Add or update drop shadows on callout panels
- Correct bullet colors to `#379E5C`
- Update background fills on callout boxes to gradient versions


---

## Workflow

### Step 1 — Diagnose: Why the File Is Not Premium

**Always run this diagnostic first and show the output to the user before making any changes.** This serves two purposes: it tells the skill what to fix automatically, and it gives the user a clear list of what will and won't be fixed.

```bash
python -m markitdown input.pptx
python scripts/office/soffice.py --headless --convert-to pdf input.pptx --outdir /home/claude/
pdftoppm -jpeg -r 120 input.pdf slide
```

View the slide images, then check against this diagnostic checklist:

#### Non-Premium Diagnostic Checklist

| Signal | What to check | Auto-fixable? |
|---|---|---|
| Flat solid fills on diagram shapes | `solidFill` inside `Tier*`, pyramid, oval, or process shapes | YES — convert to `gradFill` |
| Non-Arial fonts (Calibri etc.) | `typeface="Calibri"` or similar in XML | YES — replace with Arial |
| Title not bold | Missing `b="1"` on title run | YES |
| Thick white tier dividers | `<a:ln w="...">` > 9525 on tier shapes | YES — thin to 6350, semi-transparent |
| Flat solidFill on callout boxes | Solid dark fills on rounded rectangles | YES — convert to gradient |
| Missing drop shadow on callout panels | No `<a:outerShdw>` in effectLst | YES — add soft shadow |
| Centered body text (non-diagram) | `algn="ctr"` in body text paragraphs | RISKY — only fix if clearly body text |
| Text typos or copy errors | All text runs | NO — skill preserves content verbatim |
| Missing Ignatious logo | Logo image rId absent in slide rels | NO — manual insert in PowerPoint |
| Elements overflowing slide edges | `off x` + `ext cx` > 12192000 EMU | NO — requires repositioning |
| Gradient renders flat in PDF preview | Expected on custGeom shapes | NOT A BUG — trust PowerPoint render |

**Present this table to the user** with your findings filled in before proceeding.

### Step 2 — Understand the Input

Ask (or infer from context):
1. What type of document is this? (IC memo, client pitch, deal teaser, internal update)
2. Are there slides that must not be changed? (e.g., a pre-existing financial model screenshot)
3. Is this the full deck, or just select slides?

If the user has uploaded a file, check `/mnt/user-data/uploads/` for the `.pptx` file.

### Step 3 — Plan the Conversion

Map each existing slide to the closest Ignatious layout from the brand guide:
- Cover slide → Layout 1 (Cover)
- Bullet/text slide → Layout 4 (Content) or Layout 7 (Bullet Box Grid)
- Metrics/KPIs → Layout 5 (Donut KPI)
- Process/timeline → Layout 6 (S-Curve) or Layout 8 (Line Chart)
- Section break → Layout 2 (Section Divider)
- Closing → Layout 9 (Closing)

State your plan to the user before executing if there are more than 5 slides or if the mapping is ambiguous.

### Step 4 — Execute the Conversion

**Method: Edit by unpacking XML (preferred for reformatting existing decks)**

```bash
# Unpack
python scripts/office/unpack.py input.pptx unpacked/

# Edit slide XML files in unpacked/ppt/slides/
# Edit theme in unpacked/ppt/theme/theme1.xml
# Edit slide master in unpacked/ppt/slideMasters/slideMaster1.xml

# CRITICAL: Delete any .bak files before repacking — they corrupt the output
find unpacked/ -name "*.bak" -delete

# Repack
python scripts/office/pack.py unpacked/ output.pptx
```

**What to change on every slide:**
- Replace all non-Arial fonts with Arial
- Replace off-brand colors with Ignatious palette (reference brand-guide.md hex values)
- Add/fix footer: Ignatious logo (light version) bottom-left, page number bottom-right, black strip
- Ensure minimum 0.5" margins — push content up if footer is crowding
- Replace generic title formatting with Ignatious title style (bold Arial 28–36pt, black)
- Replace bullet colors with `#379E5C` (Primary Green)
- **Convert all flat/solid shape fills to gradients** (see Gradient Rules — non-negotiable)

**Cover slide specifics:**
- Apply dark gradient background (if unavailable via XML, use solid `#000000` as fallback and note to user)
- Swap to white logo version (`logo-dark-bg.png` from references/)
- Add date pill badge if missing

**Content slide specifics:**
- White background
- Horizontal rule below title in `#E7E6E6`
- Footer bar: solid black rectangle full-width at bottom, ~0.4" tall
- Logo (light version) placed above footer bar, bottom-left
- Page number text box, bottom-right

**Closing slide:**
- Match cover slide format
- Include firm tagline if present: "Delivering Extraordinary M&A and Financial Outcomes."

### Step 5 — QA

```bash
# Check for missing content
python -m markitdown output.pptx

# Check for placeholder text
python -m markitdown output.pptx | grep -iE "\bx{3,}\b|lorem|ipsum|\bTODO|\[insert"

# Visual inspection
python scripts/office/soffice.py --headless --convert-to pdf output.pptx --outdir /home/claude/
rm -f slide-out-*.jpg
pdftoppm -jpeg -r 120 output.pdf slide-out
ls -1 "$PWD"/slide-out-*.jpg
```

View every output slide image. Check for:
- Overlapping text or elements
- Text cut off at box boundaries
- Logo missing or misplaced
- Wrong colors remaining
- Footer missing on any content slide
- Cover/closing missing dark background
- **Any flat/solid fills remaining on diagram shapes** — these must be gradients
- **Any hard, thick, or dark lines** — these must be thinned or removed

#### Gradient Verification Script (use when custGeom shapes are present)

Because LibreOffice cannot render gradients on custom geometry shapes, use this script to verify the XML directly instead of relying on the PDF preview:

```python
import zipfile
from lxml import etree

with zipfile.ZipFile('output.pptx') as z:
    xml = z.read('ppt/slides/slide1.xml').decode('utf-8')

root = etree.fromstring(xml.encode())
ns = {
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
}

for sp in root.findall('.//p:sp', ns):
    cNvPr = sp.find('.//p:cNvPr', ns)
    name = cNvPr.get('name', '') if cNvPr is not None else ''
    if any(t in name for t in ['Tier', 'tier', 'Pyramid', 'pyramid']):
        spPr = sp.find('p:spPr', ns)
        grad = spPr.find('a:gradFill', ns) if spPr is not None else None
        solid = spPr.find('a:solidFill', ns) if spPr is not None else None
        print(f"{name}: gradFill={'OK' if grad is not None else 'MISSING - FIX THIS'}, solidFill={'STILL PRESENT - FIX' if solid is not None else 'clean'}")
```

If all tier/pyramid shapes show `gradFill=OK`, tell the user: **"Gradient XML is correctly embedded. The flat appearance in the PDF preview is a LibreOffice rendering limitation — open in PowerPoint to see the actual gradients."**

Fix issues and re-QA until a full visual pass is clean.

### Step 6 — Deliver and Report

```bash
# Remove any backup files first — stray .bak files corrupt the output zip
find unpacked/ -name "*.bak" -delete
cp output.pptx /mnt/user-data/outputs/[original-filename]-ignatious.pptx
```

Always deliver **two things** to the user:

#### 6a. Automated Changes Summary
List exactly what was changed, e.g.:
- "4 pyramid tier shapes: flat solidFill → gradFill (gradient colors: Forest Green, Primary Green, Teal, Olive)"
- "Calibri → Arial on all tier labels"
- "Title: added bold weight"
- "Bottom callout box: flat solidFill → Deep Forest Green gradient + soft drop shadow"
- "Tier divider lines: 12700 EMU (1pt solid) → 6350 EMU (0.5pt semi-transparent)"

#### 6b. Manual Fixes Still Required

Always produce this section, even if the list is short. Never omit it.

```
## What Still Needs Manual Attention in PowerPoint

**Open the file in PowerPoint and fix the following:**

Content/copy:
- [ ] [List any typos or text errors found in the original, e.g. "Slide 1: 'mut scale' should be 'must scale'"]

Visual — items the skill could not automate:
- [ ] Verify pyramid tier gradients rendered (they appear flat in the preview — this is a preview limitation only)
- [ ] [Any missing logo — if logo not found: "Insert logo-light-bg.png into footer bottom-left"]
- [ ] [Any repositioning needed]
- [ ] Home → Replace Fonts → confirm no non-Arial fonts remain

Why these elements looked non-premium (for reference when editing):
- [Name each flat-fill shape that was fixed]: "Flat solid [color] fill makes this look like a free template — fixed to gradient"
- [Name any shape still needing attention]: "Could not verify [X] — open in PowerPoint and check"
```

---

## The Premium Standard

**Read this before touching any shape.**

The goal is not "on-brand." The goal is **premium** — slides that look like they were produced by a top-tier M&A bank and cost money to make.

### What "Non-Premium" Looks Like (Always Fix)

| Signal | What it means | Fix |
|---|---|---|
| Flat solid fills on diagram shapes | Looks like clip art or a free template | Replace with soft gradients — no exceptions |
| Hard, dark border lines on shapes | Looks boxy and corporate-generic | Remove or replace with 0.5pt muted gray |
| Uniform line weights everywhere | No visual hierarchy | Vary: bold for primary, thin for secondary, none for tertiary |
| Labels crammed inside shapes | Looks busy and rushed | Pull labels outside with thin leader lines |
| All elements the same opacity | Flat, no depth | Use 70–80% opacity on secondary items |
| Centered body text | Looks like a school presentation | Always left-align body text |
| More than 3 font sizes on a slide | Visual chaos | Max 3 sizes: title, body, caption |
| Full-saturation accent colors everywhere | Garish | Use accent colors sparingly; muted tints for fills |
| Thick white divider lines between tiers | Looks cheap and hard | 0.5–1pt semi-transparent, not 2–3pt solid |

### What "Premium" Looks Like (Always Target)

- **Depth via gradients**: Each tier of a pyramid has a gradient that gives it weight and presence — smooth, layered, professional
- **Breathing room**: Content never fills more than 75% of the slide
- **Restrained color**: Mostly black/white, with green accents used exactly where the eye should go
- **Invisible structure**: Elements align without looking rigid
- **Subtle shadow**: Key callout panels have a soft drop shadow (10–15% opacity black)

---

## Gradient Rules (Non-Negotiable)

**Every diagram shape — pyramids, process tiers, ovals, zones — MUST use a gradient fill, not a flat solid color.**

### XML Pattern

```xml
<a:gradFill>
  <a:gsLst>
    <a:gs pos="0">
      <a:srgbClr val="LIGHTER_HEX"/>
    </a:gs>
    <a:gs pos="100000">
      <a:srgbClr val="DARKER_HEX"/>
    </a:gs>
  </a:gsLst>
  <a:lin ang="5400000" scaled="0"/>
</a:gradFill>
```

### Gradient Color Values

| Base color | Top (lighter) | Bottom (darker) |
|---|---|---|
| Primary Green `#379E5C` | `#4DB870` | `#2A7A46` |
| Deep Forest Green `#00513F` | `#006B53` | `#003B2D` |
| Teal `#03A39B` | `#05C4BA` | `#027A74` |
| Olive Green `#9BBB32` | `#B3D63A` | `#799228` |
| Sky Blue `#63C9F9` | `#85D8FF` | `#3AABDC` |
| Dark Charcoal `#202020` | `#333333` | `#141414` |

### Gradient Direction by Shape Type

| Shape | Direction | `ang=` |
|---|---|---|
| Pyramid tier (trapezoid) | Top → bottom | `5400000` |
| Horizontal process box | Left → right | `0` |
| Oval / zone boundary | Top-left → bottom-right | `2700000` |
| Vertical bar | Top → bottom | `5400000` |

### Three-Stop Gradient (apex tier — highest premium)

```xml
<a:gradFill>
  <a:gsLst>
    <a:gs pos="0"><a:srgbClr val="006B53"/></a:gs>
    <a:gs pos="45000"><a:srgbClr val="00513F"/></a:gs>
    <a:gs pos="100000"><a:srgbClr val="003B2D"/></a:gs>
  </a:gsLst>
  <a:lin ang="5400000" scaled="0"/>
</a:gradFill>
```

---

## Common Pitfalls

- **Flat fills on diagram shapes**: Most common failure. Every `<a:solidFill>` in a diagram shape MUST become `<a:gradFill>`. Search the XML for `solidFill` and audit every one.
- **Stray .bak files in output**: If `slide1.xml.bak` is in `unpacked/` when repacking, it gets bundled into the zip and can cause download/open errors. Always run `find unpacked/ -name "*.bak" -delete` before packing.
- **Trusting the PDF preview for custGeom gradients**: LibreOffice renders these flat. Use the XML verification script in Step 5 instead.
- **Gradient backgrounds**: LibreOffice may not render radial gradients. Use solid `#000000` as fallback for cover/closing and note it to the user.
- **Charts**: Don't alter chart data. Only change chart colors and fonts.
- **Preserving content**: Never rewrite or paraphrase slide content.
- **Font substitution**: LibreOffice may substitute fonts. Verify in XML, not the PDF.

---

## Bundled References

| File | Purpose |
|---|---|
| `references/brand-guide.md` | Full brand specs — always read this first |
| `references/logo-dark-bg.png` | White logo for dark/gradient backgrounds |
| `references/logo-light-bg.png` | Dark logo for white/light content slide footers |
| `references/ignatious_template.potx` | Official master template — source of truth for slide layouts |

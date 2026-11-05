# Ignatious Brand Guide — PowerPoint

This reference file contains all brand specifications extracted from the official Ignatious PowerPoint Template (March 2026). Always apply these specs when creating or reformatting slides.

---

## Color Palette

### Theme Colors (use by name when editing XML directly)
| Role | Hex | Theme Token | Usage |
|---|---|---|---|
| Black | `#000000` | `dk1` | Primary text, section header backgrounds |
| White | `#FFFFFF` | `lt1` | Primary text on dark backgrounds |
| Dark Charcoal | `#202020` | `dk2` | Secondary dark elements |
| Light Gray | `#E7E6E6` | `lt2` | Subtle backgrounds, divider lines |
| **Primary Green** | `#379E5C` | `accent1` | Bullets, chart highlights, key accents — PRIMARY brand color |
| Olive Green | `#9BBB32` | `accent2` | Chart series 2, donut segments |
| Teal | `#03A39B` | `accent3` | Process step 3, chart series 3 |
| Deep Forest Green | `#00513F` | `accent4` | Process connectors, chart series 4 |
| Steel Blue | `#0169B8` | `accent5` | Dark process steps, closing elements |
| Sky Blue | `#63C9F9` | `accent6` | Used sparingly for variety |
| Hyperlink Blue | `#0563C1` | `hlink` | Hyperlinks only |

### Cover/Closing Slide Gradient
- Background: radial gradient blending **Black** (`#000000`) → **Deep Teal** (`#03A39B`) → **Forest/Olive Green** (`#379E5C` / `#9BBB32`)
- Applied to: Cover slide (slide 1), section dividers, closing slide

### Practical Color Usage Rules
- **Dominant color**: Black/white (60–70% of slide)
- **Primary accent**: `#379E5C` (green) — bullets, lines, key callouts
- **Secondary accents**: Blues and teals for charts and process diagrams
- Never use accent colors for large background fills on content slides
- Sub-header bars on content slides: solid **Black** (`#000000`) with **White** text

---

## Typography

### Font Stack
| Element | Font | Size | Weight | Notes |
|---|---|---|---|---|
| Slide title (cover) | Arial | 44–52pt | Bold | Left-aligned, white |
| Slide title (content) | Arial | 28pt | Bold | Centered or left-aligned |
| Subtitle / date badge | Arial | 16pt | Regular | Muted gray or white |
| Section sub-header bar | Arial | 18–20pt | Bold | White text on black bar |
| Body / bullet text | Arial | 18pt | Regular | Left-aligned, `#000000` or `#202020` |
| Caption / footnote | Arial | 10–12pt | Regular | Muted gray |
| KPI large number | Arial | 36–48pt | Bold | White on dark circle |

**Rule**: Arial is the firm's only font. Do not introduce any other typeface.

### Text Alignment
- Title slides: left-aligned
- Body text: always left-aligned
- Section sub-header bars: centered
- KPI labels under circles: centered

---

## Logo

### Versions
- **Dark background logo** (`logo-dark-bg.png`): White wordmark + green pixel icon. Use on cover, section dividers, closing slides.
- **Light background logo** (`logo-light-bg.png`): Gray wordmark + green pixel icon. Use in footer of content slides.

### Placement Rules
- **Content slides**: Bottom-left footer, above the black footer bar
- **Cover / closing slides**: Top-left, with generous whitespace below
- **Never** resize the logo below ~15% of slide width
- **Never** place on a background where it loses contrast

---

## Slide Structure

### Slide Dimensions
- Widescreen 16:9 — 33.87cm × 19.05cm (13.33" × 7.5")

### Footer (all content slides)
- Black strip at very bottom of slide (~0.4" height)
- Logo (light version) in bottom-left, above strip
- Page number in bottom-right, above strip

### Title Area (content slides)
- Thin horizontal rule below title (~1pt, light gray `#E7E6E6`)
- Generous whitespace between title and content zone

---

## Slide Layout Library

### 1. Cover Slide
- Full dark gradient background (black → teal → green)
- Logo (white version) top-left
- Large bold white title, left-aligned, vertically centered
- Date in rounded pill badge (outline style, small white text), bottom-left

### 2. Section Divider
- Full gradient background (same as cover) — no text, pure visual break

### 3. Agenda / Numbered List (2-column)
- White background
- Centered bold title at top
- Two equal columns with vertical divider line
- Each item: dark rounded square icon (black, with green "XX" number) + 2-line description text
- Horizontal rule below each item
- Supports 3–4 items per column (6–8 total)

### 4. Content Slide — Text + Chart
- White background, title top-left in bold
- Left column (~40% width): title + body paragraph
- Right column (~60% width): chart or diagram
- Black footer strip + logo

### 5. Closing Slide
- Same as cover slide (dark gradient background)
- Logo (white version) top-left
- Large bold headline (firm tagline or deal close message)
- Contact block bottom-left: icons + website, phone, LinkedIn, email

---

## Tone & Editorial Style (for slide content)

Ignatious is a US-based boutique investment bank focused on tech M&A. Slides should read like Goldman Sachs quality — not like a startup pitch deck.

- **Titles**: Declarative, not questions. State the insight, not the topic. ("Revenue grew 3× post-integration" not "Revenue Analysis")
- **Bullets**: Maximum 3 lines per bullet. Lead with the point, support with data.
- **Numbers**: Always format with commas. Use $Xm / $Xbn shorthand in charts. Spell out fully in titles.
- **Avoid**: Clip art, stock photo backgrounds on content slides, more than 3 font sizes per slide, gradient text, decorative lines under titles.
- **Tables**: Use sparingly. Black header row, light gray lines separating rows with no fill, left-aligned text.

---

## Diagram & Visual Aesthetic Standards

### The Ignatious Visual Feel: "Structured Softness"

Ignatious diagrams should feel **airy, confident, and organized** — not busy or cluttered. The visual language is closer to a McKinsey framework diagram than a startup pitch deck: lots of whitespace, soft fills, clear hierarchy, and no visual noise.

### Shape Fill Philosophy
- **Solid flat fills** → allowed only for footer bars, title banners, and cover slide backgrounds
- **Diagram shapes** (pyramids, ovals, process boxes) → always use **soft gradient fills** or **low-opacity tints** (10–30% opacity of brand colors)
- **Callout panels / info boxes** → white fill + dashed rounded border 
- **Never** use gradient text or outline-only text for body content

### Border & Line Style
| Context | Style |
|---|---|
| Callout / info panels | Dashed, rounded corners (≥8pt radius), `#AAAAAA`, 1–1.5pt |
| Diagram zone boundaries | Dashed oval/rect, 1.5–2pt, muted brand color (e.g., teal `#03A39B`) |
| Annotation / leader lines | Solid, 0.5–0.75pt, `#AAAAAA` — no arrowhead or open only |
| Hard boxes (avoid) | Never solid-border rectangles as callout containers on content slides |

### Whitespace & Density Rules
- **Max 75% content area**: every slide should have visible breathing room
- Labels and text items: max 5 per visual zone
- Competing visual regions per slide: max 2 (primary diagram + one supporting panel)
- Never crowd labels inside shapes — pull them out with leader lines if needed

### Pyramid / Tier Diagram Standards
- Tiers: soft per-layer gradient (same hue, light-to-slightly-darker vertically)
- Labels: placed **outside** the shape, connected with thin gray lines
- Items inside tiers: max 4–5, smaller text at 70–80% opacity for a sense of depth
- Left-side annotations (scale labels): single thin bracket line, not repeated text blocks


✅ Clean white content area with strong typographic hierarchy  
✅ Green accents used intentionally — not everywhere  
✅ Every slide has a single point of emphasis
✅ Consistent footer: logo bottom-left, page number bottom-right, black strip  
✅ Data-driven language — numbers anchor every key claim  
✅ No text overflow, no cramped margins (minimum 0.5" on all sides)  
✅ Dark cover / closing slides sandwich white content slides  

❌ No decorative accent lines under titles  
❌ No centered body text  
❌ No more than 6 bullet points on any slide  
❌ No random color mixing — stick to the palette  
❌ No Arial alternatives  

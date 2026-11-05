## Design System: Conductia B1 Guided Journey

### Pattern
- **Name:** Minimal Single Column
- **Conversion Focus:** Single CTA focus. Large typography. Lots of whitespace. No nav clutter. Mobile-first.
- **CTA Placement:** Center, large CTA button
- **Color Strategy:** Minimalist: Brand + white #FFFFFF + accent. Buttons: High contrast 7:1+. Text: Black/Dark grey
- **Sections:** 1. Hero headline, 2. Short description, 3. Benefit bullets (3 max), 4. CTA, 5. Footer

### Style
- **Name:** Dark Mode (OLED)
- **Keywords:** Dark theme, low light, high contrast, deep black, midnight blue, eye-friendly, OLED, night mode, power efficient
- **Best For:** Night-mode apps, coding platforms, entertainment, eye-strain prevention, OLED devices, low-light
- **Performance:** ⚡ Excellent | **Accessibility:** ✓ WCAG AAA

### Colors
| Role | Hex |
|------|-----|
| Primary | #F59E0B |
| Secondary | #FBBF24 |
| CTA | #8B5CF6 |
| Background | #0F172A |
| Text | #F8FAFC |

*Notes: Gold trust + purple tech*

### Typography
- **Heading:** Newsreader
- **Body:** Roboto
- **Mood:** news, editorial, journalism, trustworthy, readable, informative
- **Best For:** News sites, blogs, magazines, journalism, content-heavy sites
- **Google Fonts:** https://fonts.google.com/share?selection.family=Newsreader:wght@400;500;600;700|Roboto:wght@300;400;500;700
- **CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=Newsreader:wght@400;500;600;700&family=Roboto:wght@300;400;500;700&display=swap');
```

### Key Effects
Minimal glow (text-shadow: 0 0 10px), dark-to-light transitions, low white emission, high readability, visible focus

### Avoid (Anti-patterns)
- Light backgrounds
- No security indicators

### Pre-Delivery Checklist
- [ ] No emojis as icons (use SVG: Heroicons/Lucide)
- [ ] cursor-pointer on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard nav
- [ ] prefers-reduced-motion respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px


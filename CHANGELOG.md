# Changelog

## 81.0.0

- Fixed Steam review histogram bars becoming visually hidden after collapsing and re-expanding the graph.
- Confirmed through DevTools that the graph remained live and interactive; the issue was paint-order occlusion from UltraWide's pinned-header backdrop.
- The backing plate remains behind the frozen review chrome, the native Steam graph paints above it, and pinned review controls paint above the graph.
- Main Store homepage files are unchanged from v80.

## 80.0.0

- Removed a self-triggering `MutationObserver` feedback loop in the pinned review header.
- Pin CSS variables are only written when their value actually changes.
- Theme-generated style mutations on already pinned pieces are ignored.
- The native graph branch remains remembered while Steam temporarily collapses it.
- Replaced destructive mid-animation rediscovery with a short finite height-settling sequence.

## 79.0.0

- Improved graph discovery for graphs that mount at zero size and become visible later.
- Added finite post-mount checks without permanent polling.
- Moved cold-start feedback earlier in the injection lifecycle.

## 78.0.0

- Added recovery for review histograms that mount after UltraWide has already discovered the review header.
- Kept ordinary lazy-loaded review mutations on the cached fast path.

## 77.0.0

- Added left and right mouse gutters around the review viewport.
- Restored natural vertical scroll chaining to the outer Steam page at review-scroll boundaries.

## 76.0.0

- Increased the individual-game review viewport to as much as 2560px on tall ultrawide displays.
- Fixed unused vertical space remaining after Steam's review graph was collapsed.
- Review scroll padding now follows the measured pinned-header height.

## 75.0.0

- Added non-interactive cold-start Store status feedback without changing the known-good homepage feed/layout behavior.

## 74.0.0

- Restored the known-good v71 homepage files exactly.
- Added a hard individual-app URL runtime guard so app-page logic cannot continue operating after navigation to another Store page.

## 73.0.0

- Reworked frozen review chrome to cache multiple native pre-review branches instead of guessing a single header container.
- Added a theme-owned backing plate behind frozen controls.
- Added cold-start status handling to individual app pages.

## 72.0.0

- Added a localization-safe geometry fallback for Steam review controls that are rendered as generated clickable `div` elements rather than semantic form controls.

## 71.0.0

- Added a cold-start readiness gate to the main Store homepage so UltraWide waits for meaningful Steam content before activating its layout.
- Standardized the theme name as **UltraWide**.

## 70.0.0

- Reworked frozen review controls around the actual Steam review-root structure.

## 69.0.0

- First sticky-review-header implementation. Superseded by later review-header work.

## 68.0.0

- Millennium compliance/maintenance pass.
- Removed obsolete review-card reparenting logic.
- Kept Steam's native review module React-owned while adding in-page continuation.
- Documented language-independent selector preferences and same-origin-only review fetching.

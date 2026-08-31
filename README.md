# UltraWide

Got a 4K or ultrawide monitor? Tired of Steam looking like it was made for a phone? Me too.

**UltraWide for Steam** is a Millennium theme that makes better use of all that extra screen space without trying to turn Steam into something completely different.

The current goal is pretty simple: keep the familiar Steam look and feel, but update the Store so it actually makes sense on ultrawide and very high-resolution displays.

![UltraWide Store homepage](assets/screenshots/homepage.png)

## What UltraWide changes

UltraWide currently focuses mainly on the two parts of Steam where the stock layout feels the most cramped on a large monitor:

- the main Steam Store homepage
- individual game Store pages

The Steam Library already scales pretty well on ultrawide monitors, so I have intentionally left that alone.

The theme also does not currently redesign every Steam sub-page. Steam has a lot of category, discovery, community, and miscellaneous Store pages, and many of those will still use the default Steam layout.

I may expand support for some of those pages in future versions.

## Features

- Three-lane Steam Store homepage designed for ultrawide displays.
- Expanded individual game Store pages.
- Purchase information is consistently placed in the right-hand column.
- Large in-page Customer Reviews section with its own scrollbar.
- Review summary and filter controls stay visible while reviews scroll.
- Left and right mouse gutters remain available for normal page scrolling.
- Scroll chaining returns to the Steam page when the review section reaches the top or bottom.
- **See More Reviews** loads additional reviews directly inside the page.
- Steam's normal full review page is still available through **Open Full Reviews**.
- Steam's review histogram stays native, interactive, and supports hide/show toggling.
- Cold-start handling avoids activating the custom layout before Steam has finished loading meaningful Store content.
- Homepage behavior and individual game-page behavior are separately scoped so they do not interfere with each other.

![UltraWide individual game page](assets/screenshots/app-page.png)

## Design philosophy

The focus of UltraWide is not to completely reskin Steam.

The goal is to keep the default Steam aesthetic while making the Store layout feel more appropriate for modern ultrawide and high-resolution monitors.

I have tried to keep Steam's native functionality intact wherever possible rather than replacing it with custom versions of existing controls.

UltraWide has also been built with the Millennium community guidelines in mind. The theme uses local CSS and JavaScript, does not collect user data, and does not load third-party scripts or styles.

The theme should also remain compatible with Steam's default color changer, since the design is intended to work with Steam rather than override its entire visual identity.

## What is not redesigned yet

UltraWide is currently focused on the main Store experience.

Some Steam pages will still look completely default, including:

- many Store category and discovery pages
- some special Store sub-pages
- Steam Community pages
- other less commonly used Steam web views

That is intentional for now.

Steam has a large number of different page layouts, and I would rather expand support carefully than apply broad styling that breaks pages I have not tested.

Some of these areas may be redesigned in future releases.

## Requirements

- [Millennium](https://steambrew.app/)
- Steam desktop client
- A wide display is strongly recommended

UltraWide is specifically designed to make use of screen space that Steam's stock Store layout normally leaves unused.

### Manual installation

Until UltraWide has been reviewed and approved for the Millennium theme browser, install it manually by placing the theme folder in your Steam Millennium themes directory.

The default Windows path is:

```text
C:\Program Files (x86)\Steam\millennium\themes\UltraWide

## Repository layout

```text
UltraWide/
├── skin.json      # Millennium metadata and URL patch routing
├── home.css       # Main Steam Store homepage styles
├── home.js        # Main Steam Store homepage behavior
├── webkit.css     # Individual game Store page styles
├── webkit.js      # Individual game Store page behavior
├── README.md
├── CHANGELOG.md
├── LICENSE
└── assets/
    └── screenshots/

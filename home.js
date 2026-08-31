(() => {
    "use strict";

    /* =====================================================================
       ULTRAWIDE — MAIN STEAM STORE HOMEPAGE
       =====================================================================

       IMPORTANT: This is the frozen/stable homepage layout implementation.
       V71 changes only cold-start activation timing; the validated routing,
       balancing, and visual layout algorithms are otherwise unchanged.

       Major responsibilities:
         - discover Steam homepage modules;
         - place stable priority modules into three independent ultrawide lanes;
         - leave Steam's long live feed in its native DOM and apply lightweight
           CSS-grid masonry sizing only to direct feed children;
         - preserve footer/infinite-feed behavior;
         - provide click-only inline Community review expansion.

       Selector policy:
         - stable ids/classes/DOM relationships are preferred when available;
         - some homepage modules expose only localized headings reliably across
           Steam builds, so English heading regexes remain documented fallbacks.
         - those selectors are intentionally left behaviorally unchanged in v68
           to avoid regressing the validated homepage.
       ===================================================================== */

    const ACTIVE = "uw25-home-active";
    const WATERFALL_ID = "uw25-home-waterfall";

    /*
      V75 COLD-START STATUS

      Millennium injects the homepage CSS/JS before Valve has necessarily
      mounted the asynchronous Store body. On a true cold Steam launch that
      can leave only Steam's dark canvas visible for several seconds even
      though UltraWide has intentionally not touched the native DOM yet.

      Mark that short boot phase immediately so home.css can display a small,
      non-interactive status card. This does NOT hide, replace, or delay Steam;
      it merely gives the otherwise-black canvas an explicit loading state.
      The marker is removed as soon as the existing V71 structural readiness
      test confirms meaningful native Store content.
    */
    const UW75_BOOTING = "uw-home-booting";
    const UW75_NATIVE_READY = "uw-home-native-ready";

    document.documentElement.classList.add(UW75_BOOTING);
    document.documentElement.classList.remove(UW75_NATIVE_READY);

    /*
      V79 EARLY COLD-START NOTICE

      The V75 CSS pseudo-element depended on <body> being paintable. Steam can
      spend several seconds with only its browser shell/navigation visible while
      the Store document is still mounting. Create a real fixed element directly
      from the injected script so users get feedback even before DOMContentLoaded.

      This element does not alter layout or input. If Millennium itself has not
      injected the theme script yet, no theme can draw inside that not-yet-themed
      document; V79 therefore shows the notice at the earliest point available to
      theme code and removes it the instant native Store content is ready.
    */
    const UW79_BOOT_NOTICE_ID = "uw-home-cold-start-notice";
    let uw79BootNotice = null;
    let uw79BootNoticeTimer = 0;

    function uw79RemoveBootNotice() {
        if (uw79BootNoticeTimer) {
            clearTimeout(uw79BootNoticeTimer);
            uw79BootNoticeTimer = 0;
        }

        if (uw79BootNotice) {
            uw79BootNotice.remove();
            uw79BootNotice = null;
        }

        document.getElementById(UW79_BOOT_NOTICE_ID)?.remove();
    }

    function uw79ShowBootNotice() {
        if (
            uw79BootNotice ||
            document.documentElement.classList.contains(UW75_NATIVE_READY)
        ) {
            return;
        }

        const notice = document.createElement("div");
        notice.id = UW79_BOOT_NOTICE_ID;
        notice.setAttribute("role", "status");
        notice.setAttribute("aria-live", "polite");

        const title = document.createElement("div");
        title.textContent = "Loading Steam Store…";
        title.style.cssText =
            "font-size:18px;font-weight:600;color:#fff;margin-bottom:6px;";

        const detail = document.createElement("div");
        detail.textContent = "UltraWide is waiting for Steam to finish loading.";
        detail.style.cssText =
            "font-size:13px;line-height:1.4;color:#b8c7d9;";

        notice.append(title, detail);
        notice.style.cssText =
            "position:fixed;left:50%;top:46%;transform:translate(-50%,-50%);" +
            "z-index:2147483000;max-width:520px;padding:18px 22px;" +
            "box-sizing:border-box;border:1px solid rgba(103,193,245,.30);" +
            "border-radius:4px;background:rgba(20,34,48,.96);" +
            "box-shadow:0 12px 32px rgba(0,0,0,.45);" +
            "font-family:Arial,Helvetica,sans-serif;text-align:center;" +
            "pointer-events:none;";

        const host = document.body || document.documentElement;
        if (!host) return;

        host.appendChild(notice);
        uw79BootNotice = notice;
    }

    function uw79ScheduleBootNotice() {
        if (uw79BootNoticeTimer || uw79BootNotice) return;

        uw79BootNoticeTimer = window.setTimeout(() => {
            uw79BootNoticeTimer = 0;
            uw79ShowBootNotice();
        }, 350);
    }

    uw79ScheduleBootNotice();

    const LANE_IDS = [
        "uw25-lane-left",
        "uw25-lane-middle",
        "uw25-lane-right"
    ];

    const RELEASE_TABS = [
        "Popular New Releases",
        "Top Sellers",
        "Popular Upcoming",
        "Specials",
        "Trending Free"
    ];

    const KNOWN_SECTION_PATTERNS = [
        /^discounts?\s*&\s*events$/i,
        /^browse by category$/i,
        /^your personal calendar$/i,
        /^recommended based on the games you play$/i,
        /^your wishlist$/i,
        /^dlc for your games$/i,
        /^top played on steam deck$/i,
        /^the community recommends$/i,
        /^recently updated$/i,
        /^from developers and publishers you know$/i,
        /^under \$\d+$/i,
        /^because you played\b/i,
        /^recommended for you\b/i,
        /^games like\b/i,
        /^more like\b/i,
        /^your discovery queue$/i,
        /^explore your discovery queue$/i,
        /^new & noteworthy$/i
    ];

    let scanRAF = 0;
    let sweepRAF = 0;
    let fitRAF = 0;
    let dirtyFitRAF = 0;
    let reflowRAF = 0;
    let lastScanAt = 0;
    let lastDeepSweepAt = 0;
    let observer = null;
    let resizeObserver = null;
    let applying = false;
    let sweeping = false;
    let fitting = false;
    let reflowing = false;
    let lastPlacedCount = 0;
    let nextModuleOrder = 1;
    let nextFeatureSide = 1;

    /*
      V71 COLD-START / FIRST-PAINT SAFETY

      Steam's Store homepage is populated asynchronously after the browser view
      itself reaches DOMContentLoaded. On a cold Steam launch (especially after
      replacing theme files), older builds could immediately run the expensive
      homepage layout pass against a mostly-empty native page. That could leave
      users staring at a black Store canvas while Steam finished mounting.

      V71 deliberately leaves Valve's native page completely untouched until:
        1) Chromium has had at least two animation frames to paint; and
        2) the native Store root contains meaningful homepage content.

      Mutations during this short boot window merely schedule another cheap
      readiness check. They DO NOT trigger the deep scanner, waterfall build,
      reflow, or fitting work. If Steam is slow, users continue seeing Steam's
      normal native loading/page state rather than an empty UltraWide layout.
    */
    let uw71BootReleased = false;
    let uw71BootTimer = 0;
    let uw71BootStartedAt = performance.now();

    /*
      V54 PERFORMANCE / STREAMING STATE

      Once the top utility modules are captured, the long Steam feed is handled
      incrementally. Scrolling itself no longer triggers a full-document scan or
      a full waterfall rebuild. New feed batches are picked up from DOM mutations
      and are placed directly into the shortest *feed* lane.
    */
    let uw53LastFallbackSweepAt = 0;
    let uw53InitialReflowDone = false;
    let uw53TopReadyCached = false;
    let uw53AggregateSuspect = false;

    /*
      V54 DETERMINISTIC DEEP-FEED BALANCING

      V53 used each lane's *rendered pixel height* while Steam was still
      lazy-loading images and expanding personalized sections. That made lane
      choice depend on timing: a first load could favor MIDDLE, while a refresh
      of the exact same page could favor RIGHT.

      V54 assigns the long feed using stable content weights instead. Once a
      deep module gets a lane, that lane is locked for the life of the page.
      No image decode, carousel resize, or late text expansion can change the
      assignment. This keeps all three columns receiving content consistently
      without bringing back the expensive scroll-time reflows.
    */
    let uw54DeepTieCursor = 0;

    /*
      V56 NATIVE LIVE-FEED STAGE

      V55 correctly stopped moving Valve's live aggregate feed HOST, but it
      still removed the host's child sections and placed those children in our
      waterfall lanes. That drained the native stream, collapsed its scroll
      geometry, and caused Steam to stop requesting more recommendations after
      only a few screens.

      V56 keeps BOTH the live host and its children in Valve's DOM. The host is
      expanded to ultrawide width and its real section nodes are laid out into
      three visual columns with CSS/geometry only. No React-owned feed node is
      reparented.
    */
    let uw56FeedLayoutTimer = 0;
    const uw56NativeFeedHosts = new WeakSet();
    const uw56PendingFeedHosts = new Set();
    let uw56FeedResizeObserver = null;

    /*
      V58 LIGHTWEIGHT MASONRY

      V57's normal-flow CSS Grid restored excellent performance, but ordinary
      CSS Grid shares row tracks across all three columns. A tall module in one
      column therefore leaves a large blank area beneath shorter neighbors.

      V58 keeps the V57 architecture (Steam owns #content_more; no reparenting,
      no absolute positioning, no scroll-time feed work) and adds only a tiny
      grid-row span measurement for cards whose size actually changed.
    */
    const uw58MasonryDirty = new WeakMap();
    const uw58MasonryTimer = new WeakMap();
    const uw58MasonryLoadBound = new WeakSet();

    /*
      V59 PRE-FEED BRIDGE

      V58 fixed the long #content_more feed without giving back V57's speed,
      but several lazy Steam modules that appear AFTER the pinned top waterfall
      and BEFORE #content_more could arrive after uw53TopLayoutReady() became
      true.  The optimized observer then intentionally stopped running the
      whole-home scanner, so those modules stayed in Valve's narrow centered
      flow and created large empty left/right regions just below the top.

      V59 watches only that small pre-feed source region.  It never scans the
      live #content_more stream and therefore keeps scrolling hot-path work at
      zero.
    */
    const uw59PreFeedPending = new Set();
    let uw59PreFeedTimer = 0;

    /*
      V60 TOP-LANE COMPACTION

      V59 captures late pre-feed modules without touching the fast native
      #content_more masonry. The remaining upper-page gap is caused by the
      waterfall itself ending at its tallest lane. A few movable shelves were
      still following the older lane-personality rules, so the shorter lane
      could finish hundreds of pixels early.

      V60 treats ONLY familiar pre-feed/gap-filler shelves as neutral packing
      material during the normal one-shot/reflow path. They go to the shortest
      effective top lane, while Calendar/Browse/Community/Developers/Releases
      remain pinned exactly where requested. No scroll-time layout work is
      added and the V58/V59 native feed code is untouched.
    */

    /*
      V64 ROBUST INLINE COMMUNITY REVIEWS

      V63 proved that in-page review reading is a much nicer interaction than
      opening Steam's separate community window, but several real Store review
      variants exposed rough edges: long text could be clipped by Steam's fixed
      review_box height, BBCode was shown literally, and excerpt-only matching
      could occasionally miss the exact review.

      V64 keeps this feature entirely click-driven. It first matches Steam's
      exact Review<recommendationid> DOM id against appreviews.recommendationid,
      then falls back to author/excerpt matching. The active Community card gets
      a modest temporary height increase while the text pane has its own capped
      scroll area. Common Steam BBCode is rendered safely for readability.
    */
    const uw64ReviewCache = new Map();
    const uw64ReviewBypassClicks = new WeakSet();
    let uw64ActiveExpansion = null;
    let uw64InlineReviewsInstalled = false;

    const observedModules = new WeakSet();
    const dirtyFitModules = new Set();
    const placedModules = new WeakSet();
    const deepPlacedModules = new WeakSet();
    const moduleSlots = new WeakMap();

    /*
      V51: some of Steam's long recommendation feed is hosted by a dynamic
      container that starts small and then receives dozens of later sections.
      If that host is moved as one module, one waterfall lane becomes tens of
      thousands of pixels tall. Keep enough source information to restore a
      mistaken host and harvest its real child sections instead.
    */
    const uw51DeepSource = new WeakMap();
    const uw51DeepFeedHosts = new WeakSet();
    let uw51RescueRAF = 0;

    /*
      V32: cache named priority modules BEFORE/AFTER movement. Re-deriving a
      section root from its heading after it has entered our waterfall can
      produce a different ancestor, which was how Community could later be
      treated as a generic LEFT module.
    */
    const specialRoots = new Map();
    const normalizedGenreModules = new WeakSet();

    /*
      V39: only these exact, validated module roots may become utility modules.
      No broad ancestor is ever cached as special.
    */
    const uw39UtilityRoots = new Map();

    /*
      V46: Calendar capture state.

      The normal V43 resolver remains cheap. V46 adds two fallbacks that do
      not depend on Valve's Calendar class names:
        1) one idle deep probe through normal DOM / open shadow roots /
           same-origin iframes;
        2) a visual tail rescue when the stock bottom modules enter view.

      Once captured, all probing stops permanently.
    */
    let uw46CalendarCaptured = false;
    let uw46CalendarRoot = null;
    let uw46DeepProbeDone = false;
    let uw46DeepProbeScheduled = false;
    let uw46TailRAF = 0;

    function text(el) {
        return ((el && el.textContent) || "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function isVisible(el) {
        if (!el) return false;

        const s = getComputedStyle(el);

        if (
            s.display === "none" ||
            s.visibility === "hidden"
        ) {
            return false;
        }

        const r = el.getBoundingClientRect();

        return (
            r.width > 4 &&
            r.height > 4
        );
    }

    function isMajorRoot(el) {
        if (!el) return true;

        return (
            el === document.body ||
            el === document.documentElement ||
            el.id === "responsive_page_template_content" ||
            el.id === "responsive_page_legacy_content" ||
            el.matches(
                ".responsive_page_content, " +
                ".responsive_page_frame, " +
                ".main_content_ctn, " +
                ".home_page_body_ctn, " +
                "#responsive_page_template_content, " +
                `#${WATERFALL_ID}, ` +
                ".uw25-lane, " +
                "#global_header, #store_header, #footer"
            )
        );
    }

    function headingCandidates(root = document) {
        return Array.from(
            root.querySelectorAll(
                "h1, h2, h3, h4, " +
                "[class*='title'], [class*='Title'], " +
                "[class*='header'], [class*='Header']"
            )
        ).filter(el => {
            if (!isVisible(el)) return false;

            const t = text(el);

            return (
                t.length > 0 &&
                t.length <= 120
            );
        });
    }

    function exactHeading(regex, root = document) {
        return (
            headingCandidates(root)
                .find(el =>
                    regex.test(text(el))
                ) ||
            null
        );
    }

    function knownHeadings() {
        return headingCandidates()
            .filter(el =>
                KNOWN_SECTION_PATTERNS.some(rx =>
                    rx.test(text(el))
                )
            );
    }

    function sectionRootForHeading(heading, allHeadings) {
        if (!heading) return null;

        let node = heading;
        let best = heading.parentElement || heading;

        for (
            let i = 0;
            i < 10 &&
            node &&
            node.parentElement;
            i++
        ) {
            const p = node.parentElement;

            if (isMajorRoot(p)) break;

            const containsOther =
                allHeadings.some(h =>
                    h !== heading &&
                    p.contains(h)
                );

            if (containsOther) break;

            const r = p.getBoundingClientRect();

            if (
                r.width >= 280 &&
                r.height >= 60 &&
                r.height <= Math.max(
                    2200,
                    window.innerHeight * 3
                )
            ) {
                best = p;
            }

            node = p;
        }

        return best;
    }

    function lowestCommonAncestor(nodes) {
        const valid = nodes.filter(Boolean);
        if (!valid.length) return null;

        let ancestor = valid[0];

        for (let i = 1; i < valid.length; i++) {
            const other = valid[i];
            const seen = new Set();

            let n = ancestor;
            while (n) {
                seen.add(n);
                n = n.parentElement;
            }

            n = other;
            let common = null;

            while (n) {
                if (seen.has(n)) {
                    common = n;
                    break;
                }
                n = n.parentElement;
            }

            if (!common) return null;
            ancestor = common;
        }

        return ancestor;
    }

    function exactTextNode(label, root = document) {
        const wanted =
            label.toLowerCase();

        return Array.from(
            root.querySelectorAll(
                "a, button, span, div, h1, h2, h3, h4"
            )
        ).find(el => {
            if (!isVisible(el)) return false;
            if (el.children.length > 8) return false;

            return (
                text(el).toLowerCase() ===
                wanted
            );
        }) || null;
    }

    /*
      Find the COMPLETE releases module.

      Start from the common ancestor of the 5 visible tab labels, then climb
      until the wrapper is tall enough to include the active list/detail area.
      Stop before swallowing another known homepage section.
    */
    function findFullReleasesModule() {
        const tabNodes =
            RELEASE_TABS.map(label =>
                exactTextNode(label)
            ).filter(Boolean);

        if (tabNodes.length < 4) {
            return null;
        }

        const alreadyMoved =
            tabNodes[0].closest?.(
                ".uw25-releases-module, " +
                ".uw25-home-module[data-uw32-priority=\"releases\"]"
            );

        if (
            alreadyMoved &&
            tabNodes.every(tab => alreadyMoved.contains(tab))
        ) {
            return alreadyMoved;
        }

        let node =
            lowestCommonAncestor(
                tabNodes
            );

        if (!node) return null;

        const otherKnown =
            knownHeadings()
                .filter(h =>
                    !RELEASE_TABS.some(label =>
                        text(h).toLowerCase() ===
                        label.toLowerCase()
                    )
                );

        let best = null;

        for (
            let i = 0;
            i < 8 &&
            node &&
            node.parentElement;
            i++
        ) {
            if (
                isMajorRoot(node) ||
                node.classList?.contains("uw27-module-slot") ||
                node.closest?.(`#${WATERFALL_ID}`)
            ) break;

            const r =
                node.getBoundingClientRect();

            const hasOtherSection =
                otherKnown.some(h =>
                    node.contains(h)
                );

            if (
                !hasOtherSection &&
                r.width >= 500 &&
                r.height >= 350
            ) {
                best = node;
            }

            if (hasOtherSection && best) {
                break;
            }

            node = node.parentElement;
        }

        /*
          If the first substantial wrapper wasn't found, at minimum preserve
          the tab common ancestor instead of losing the tabs again.
        */
        return (
            best ||
            lowestCommonAncestor(tabNodes)
        );
    }

    function stableSpecialRoot(
        key,
        regex
    ) {
        const cached =
            specialRoots.get(key);

        if (
            cached &&
            cached.isConnected
        ) {
            return cached;
        }

        const heading =
            exactHeading(regex);

        if (!heading) {
            return null;
        }

        const moved =
            heading.closest(
                ".uw25-home-module"
            );

        if (moved) {
            specialRoots.set(
                key,
                moved
            );

            return moved;
        }

        return sectionRootForHeading(
            heading,
            knownHeadings()
        );
    }

    function priorityType(module) {
        if (!module) return null;

        return (
            module.dataset
                .uw32Priority ||
            null
        );
    }

    function protectSpecial(
        module,
        key
    ) {
        if (!module) return;

        specialRoots.set(
            key,
            module
        );

        module.classList.add(
            "uw32-protected-module"
        );

        module.dataset.uw32Priority =
            key;
    }

    function isPriorityRelated(module) {
        if (!module) return false;

        if (
            module.dataset.uw32Priority ||
            module.classList.contains(
                "uw32-protected-module"
            )
        ) {
            return true;
        }

        if (priorityType(module)) {
            return true;
        }

        for (
            const root of
            specialRoots.values()
        ) {
            if (
                !root ||
                !root.isConnected
            ) {
                continue;
            }

            if (
                root === module ||
                root.contains(module) ||
                module.contains(root)
            ) {
                return true;
            }
        }

        return false;
    }

    const UW39_UTILITY_SPECS = [
        {
            key: "calendar",
            regex:
                /^(?:new\s+)?your personal calendar$/i,
            directSelectors: [],
            laneIndex: 0,
            order: 1
        },
        {
            key: "browse",
            regex:
                /^browse by category$/i,
            directSelectors: [],
            laneIndex: 1,
            order: 10
        },
        {
            key: "community",
            regex:
                /^the community recommends$/i,
            directSelectors: [
                ".community_recommendations_by_steam_labs_ctn"
            ],
            laneIndex: 1,
            order: 20
        },
        {
            key: "developers",
            regex:
                /^from developers and publishers you know$/i,
            directSelectors: [
                ".recommended_creators_ctn.home_ctn",
                ".recommended_creators_ctn"
            ],
            laneIndex: 1,
            order: 30
        },
        {
            key: "discovery",
            regex:
                /^(?:explore )?your discovery queue$/i,
            directSelectors: [
                ".discovery_queue_ctn.home_ctn",
                ".discovery_queue_ctn"
            ],
            laneIndex: 1,
            order: 40
        }
    ];

    function uw39NormalizeTitle(el) {
        return text(el)
            .replace(/\s+/g, " ")
            .trim();
    }

    function uw39FindHeading(spec) {
        /*
          V43: intentionally cheap.

          Search only elements Steam normally uses for section headings.
          Do NOT fall back to every div/span in the page. Calendar has its own
          direct-link resolver below and does not need title guessing.
        */
        return (
            headingCandidates()
                .find(el =>
                    spec.regex.test(
                        uw39NormalizeTitle(el)
                    )
                ) ||
            null
        );
    }

    function uw39UtilityHeadingCount(root) {
        if (!root) return 0;

        let hits = 0;

        for (
            const spec of
            UW39_UTILITY_SPECS
        ) {
            const found =
                headingCandidates(root)
                    .some(el =>
                        spec.regex.test(
                            uw39NormalizeTitle(el)
                        )
                    );

            if (found) {
                hits++;
            }
        }

        return hits;
    }

    function uw39ValidateRoot(
        root,
        heading,
        spec
    ) {
        if (
            !root ||
            !heading ||
            !root.contains(heading) ||
            isMajorRoot(root)
        ) {
            return false;
        }

        /*
          This is the key safety rule:
          an individual utility root may contain exactly ONE of our utility
          section headings. If it contains two, it is a broad parent and is
          rejected.
        */
        const hits =
            uw39UtilityHeadingCount(
                root
            );

        if (hits > 1) {
            return false;
        }

        const r =
            root.getBoundingClientRect();

        /*
          Loaded modules can be tall, but a huge multi-screen wrapper is not
          an individual home module.
        */
        if (
            r.width < 240 ||
            r.height >
                Math.max(
                    1700,
                    window.innerHeight * 2.1
                )
        ) {
            return false;
        }

        return true;
    }

    function uw43VisibleCalendarLink() {
        /*
          Steam can also have a Personal Calendar link in navigation.
          Select the visible HOME-PAGE link/button, preferring the exact
          "Explore your full Personal Calendar" control seen in the recording.
        */
        const links =
            Array.from(
                document.querySelectorAll(
                    'a[href*="/personalcalendar"], ' +
                    'a[href*="personalcalendar"]'
                )
            );

        return (
            links.find(a =>
                isVisible(a) &&
                /explore\s+(?:your\s+)?full\s+personal\s+calendar/i
                    .test(text(a))
            ) ||
            links.find(a =>
                isVisible(a) &&
                /personal\s+calendar/i.test(text(a))
            ) ||
            null
        );
    }

    function uw46CalendarPhrase(value) {
        return /your\s+personal\s+calendar/i.test(
            String(value || "")
        );
    }

    function uw46DiscoveryPhrase(value) {
        return /(?:explore\s+)?your\s+discovery\s+queue/i.test(
            String(value || "")
        );
    }

    function uw46CalendarLane() {
        return lanes()[0] || null;
    }

    function uw48LeftLane() {
        return lanes()[0] || null;
    }

    function uw50TopLeftSlot() {
        const lane = uw48LeftLane();
        if (!lane) return null;

        let slot = document.getElementById(
            "uw50-top-left-slot"
        );

        if (!slot) {
            slot = document.createElement("div");
            slot.id = "uw50-top-left-slot";
            slot.className = "uw27-module-slot uw50-top-left-slot";
            slot.dataset.uw50FixedTopLeft = "true";
        }

        /*
          IMPORTANT: this wrapper participates in the SAME pinned-slot system
          as Discounts & Events. That means reflow counts its real height and
          knows its stable position. V49 used an independent wrapper and then
          fought the pinned reflow every frame, which caused sluggishness and
          eventually left the deep Steam feed stranded in one stock column.
        */
        slot.dataset.uw29PinnedLane = lane.id;
        slot.dataset.uw31PinnedOrder = "1";

        /* Only move when the parent is actually wrong. Never ping-pong order. */
        if (slot.parentElement !== lane) {
            lane.prepend(slot);
        }

        return slot;
    }

    function uw48NormalizeRawTopLeft(root, order) {
        if (!root) return false;

        root.classList.remove(
            "uw25-home-module",
            "uw39-utility-module",
            "uw47-calendar-module",
            "uw48-discovery-module"
        );

        root.style.setProperty("width", "100%", "important");
        root.style.setProperty("max-width", "100%", "important");
        root.style.setProperty("min-width", "0", "important");
        root.style.setProperty("height", "auto", "important");
        root.style.setProperty("position", "relative", "important");
        root.style.setProperty("left", "auto", "important");
        root.style.setProperty("right", "auto", "important");
        root.style.setProperty("transform", "none", "important");
        root.style.setProperty("margin", "0", "important");
        root.style.setProperty("box-sizing", "border-box", "important");
        root.style.setProperty("order", String(order), "important");
        root.style.setProperty("flex", "0 0 auto", "important");

        for (const child of root.children) {
            child.style.setProperty("max-width", "100%", "important");
            child.style.setProperty("box-sizing", "border-box", "important");
        }

        return true;
    }

    function uw48DiscoveryRootExact() {
        const signal = uw43DiscoverySignal();
        if (!signal) return null;

        /* DevTools-confirmed complete banner wrapper. */
        const root = signal.matches?.(
            ".home_pagecontent_ctn"
        )
            ? signal
            : signal.closest?.(
                ".home_pagecontent_ctn"
            );

        if (
            !root ||
            isMajorRoot(root) ||
            !/(?:explore\s+)?your\s+discovery\s+queue/i.test(
                text(root)
            )
        ) {
            return null;
        }

        return root;
    }

    function uw48DetachOldSlot(root) {
        if (!root) return;

        const slot = moduleSlots.get(root);
        if (
            slot &&
            slot.isConnected &&
            slot.contains(root)
        ) {
            const parent = slot.parentElement;

            /* Never create a DOM cycle while unwinding an old generic slot. */
            if (
                parent &&
                parent !== root &&
                !root.contains(parent)
            ) {
                parent.insertBefore(root, slot);
            }

            slot.remove();
        }
    }

    function uw50ClearLegacyPins(root) {
        if (!root) return;
        delete root.dataset.uw29PinnedLane;
        delete root.dataset.uw31PinnedOrder;
    }

    function uw48KeepTopLeftUtilities() {
        const lane = uw48LeftLane();
        const slot = uw50TopLeftSlot();
        if (!lane || !slot) return false;

        const calendar =
            uw46CalendarRoot &&
            uw46CalendarRoot.isConnected
                ? uw46CalendarRoot
                : document.querySelector(
                    ".personal_calendar_ctn"
                );

        /*
          Prefer the DevTools-confirmed OUTER Discovery banner every time.
          The older utility resolver can legitimately cache an inner
          .discovery_queue_ctn, which is not the complete purple banner.
        */
        let discovery = uw48DiscoveryRootExact();

        if (!discovery) {
            const cached = uw39UtilityRoots.get("discovery");
            if (
                cached &&
                cached.isConnected &&
                /(?:explore\s+)?your\s+discovery\s+queue/i.test(text(cached))
            ) {
                discovery = cached;
            }
        }

        if (calendar && calendar.isConnected) {
            uw48DetachOldSlot(calendar);
            uw48NormalizeRawTopLeft(calendar, 0);
            uw50ClearLegacyPins(calendar);

            if (calendar.parentElement !== slot) {
                slot.prepend(calendar);
            } else if (slot.firstElementChild !== calendar) {
                slot.prepend(calendar);
            }

            calendar.dataset.uw48TopLeft = "calendar";
            calendar.dataset.uw50TopLeft = "calendar";

            placedModules.add(calendar);
            specialRoots.set("calendar", calendar);
            uw39UtilityRoots.set("calendar", calendar);

            uw46CalendarRoot = calendar;
            uw46CalendarCaptured = true;
        }

        if (
            discovery &&
            discovery.isConnected &&
            discovery !== calendar
        ) {
            uw48DetachOldSlot(discovery);
            uw48NormalizeRawTopLeft(discovery, 1);
            uw50ClearLegacyPins(discovery);

            /* Only mutate the DOM if order/parent is actually wrong. */
            if (
                calendar &&
                calendar.parentElement === slot
            ) {
                if (calendar.nextElementSibling !== discovery) {
                    calendar.after(discovery);
                }
            } else if (discovery.parentElement !== slot) {
                slot.appendChild(discovery);
            }

            discovery.dataset.uw48TopLeft = "discovery";
            discovery.dataset.uw50TopLeft = "discovery";
            discovery.dataset.uw39UtilityKey = "discovery";
            discovery.dataset.uw32Priority = "discovery";

            placedModules.add(discovery);
            specialRoots.set("discovery", discovery);
            uw39UtilityRoots.set("discovery", discovery);
        }

        /*
          Do NOT prepend/reorder the top slot here. Reflow owns its position
          using uw31PinnedOrder=1; Discounts uses order=10. This eliminates
          V49's endless stack <-> Discounts DOM tug-of-war.
        */
        return !!calendar || !!discovery;
    }

    function uw47KeepCalendarTop() {
        /* Backward-compatible call site: V48 now maintains the whole pair. */
        return uw48KeepTopLeftUtilities();
    }

    function uw46MoveCalendar(root) {
        /*
          V47: We finally have Steam's exact Calendar container from DevTools:

              .personal_calendar_ctn

          Do NOT pass it through moveModule()/fitOneModule(). The successful
          live test showed that the native Calendar looks correct when it is
          moved RAW into the left lane and allowed to resize naturally.
        */
        if (
            !root ||
            !root.isConnected ||
            !root.matches?.(
                ".personal_calendar_ctn"
            ) ||
            isMajorRoot(root) ||
            isFooterish(root)
        ) {
            return false;
        }

        const lane = uw48LeftLane();
        const slot = uw50TopLeftSlot();
        if (!lane || !slot) return false;

        const oldParent = root.parentElement;

        /* Clean up any debug/live-test residue if V47 is hot-reloaded. */
        root.querySelector(
            ".home_section_title"
        )?.style.removeProperty(
            "outline"
        );
        root.style.removeProperty(
            "outline"
        );

        root.classList.remove(
            "uw25-home-module",
            "uw47-calendar-module"
        );

        root.dataset.uw39UtilityKey =
            "calendar";
        root.dataset.uw32Priority =
            "calendar";
        root.dataset.uw47CalendarRoot =
            "true";
        root.dataset.uw48TopLeft =
            "calendar";

        /*
          These are the same sizing constraints that produced the good live
          screenshot. They neutralize Steam's original 1600px home width but
          otherwise leave the Calendar component native.
        */
        uw48NormalizeRawTopLeft(
            root,
            0
        );
        uw50ClearLegacyPins(root);

        protectSpecial(root, "calendar");
        uw39UtilityRoots.set(
            "calendar",
            root
        );
        specialRoots.set(
            "calendar",
            root
        );

        /*
          Mark it as already handled so generic discovery never wraps/scales
          it later. Calendar deliberately has NO uw27 module slot.
        */
        placedModules.add(root);

        if (root.parentElement !== slot) {
            slot.prepend(root);
        } else if (slot.firstElementChild !== root) {
            slot.prepend(root);
        }

        uw46CalendarRoot = root;
        uw46CalendarCaptured = true;

        markVacated(oldParent);
        scheduleReflow();

        return true;
    }

    function uw46CandidateFromSeed(seed) {
        if (!seed) return null;

        /*
          If the phrase lives inside an open shadow tree, move its host.
          If it lives inside an iframe, the caller gives us the iframe host.
        */
        let node = seed;

        try {
            const rootNode =
                seed.getRootNode?.();

            if (
                rootNode instanceof ShadowRoot
            ) {
                node = rootNode.host;
            }
        } catch (_) {}

        let best = null;
        let bestScore = -Infinity;

        for (
            let i = 0;
            i < 12 &&
            node &&
            node.parentElement;
            i++
        ) {
            const parent = node.parentElement;

            if (
                !parent ||
                isMajorRoot(parent) ||
                isFooterish(parent) ||
                parent.closest?.(`#${WATERFALL_ID}`)
            ) {
                break;
            }

            const t = text(parent);

            /* Never select a wrapper containing both Calendar and Discovery. */
            if (
                uw46CalendarPhrase(t) &&
                uw46DiscoveryPhrase(t)
            ) {
                break;
            }

            const r = parent.getBoundingClientRect();
            const wr = r.width / Math.max(1, window.innerWidth);
            const hr = r.height / Math.max(1, window.innerHeight);

            if (
                wr >= 0.14 &&
                wr <= 0.48 &&
                hr >= 0.10 &&
                hr <= 0.55
            ) {
                let score = 0;

                if (uw46CalendarPhrase(t)) score += 100;
                if (/personalized[-\s]*for[-\s]*you/i.test(t)) score += 25;
                if (/\bmon\b/i.test(t)) score += 8;
                if (/\btue\b/i.test(t)) score += 8;
                if (/\bwed\b/i.test(t)) score += 8;
                if (/\bthu\b/i.test(t)) score += 8;
                if (/\bfri\b/i.test(t)) score += 8;

                /* Favor a complete medium-sized module, not a tiny label. */
                score += Math.min(30, hr * 80);
                score -= Math.abs(wr - 0.25) * 20;

                if (score > bestScore) {
                    best = parent;
                    bestScore = score;
                }
            }

            node = parent;
        }

        return best;
    }

    function uw46FindTextSeed(root) {
        if (!root) return null;

        try {
            const walker = document.createTreeWalker(
                root,
                NodeFilter.SHOW_TEXT
            );

            let n = walker.nextNode();
            let count = 0;

            while (n && count < 30000) {
                count++;

                if (
                    uw46CalendarPhrase(
                        n.nodeValue
                    )
                ) {
                    return n.parentElement;
                }

                n = walker.nextNode();
            }
        } catch (_) {}

        return null;
    }

    function uw46ProbeDocument(doc, frameHost = null) {
        if (!doc) return false;

        let seed = null;

        try {
            seed = uw46FindTextSeed(
                doc.body || doc.documentElement
            );
        } catch (_) {}

        if (seed) {
            /*
              Cross-document children should not be transplanted. Move the
              iframe element which owns them instead.
            */
            if (
                frameHost &&
                frameHost.ownerDocument === document
            ) {
                const candidate =
                    uw46CandidateFromSeed(
                        frameHost
                    ) || frameHost;

                if (uw46MoveCalendar(candidate)) {
                    return true;
                }
            } else {
                const candidate =
                    uw46CandidateFromSeed(seed);

                if (
                    candidate &&
                    uw46MoveCalendar(candidate)
                ) {
                    return true;
                }
            }
        }

        /* Same-origin iframes are cheap to enumerate and safe to inspect. */
        let frames = [];
        try {
            frames = Array.from(
                doc.querySelectorAll("iframe")
            );
        } catch (_) {}

        for (const frame of frames) {
            try {
                const child =
                    frame.contentDocument;

                if (
                    child &&
                    uw46ProbeDocument(
                        child,
                        frame
                    )
                ) {
                    return true;
                }
            } catch (_) {}
        }

        return false;
    }

    function uw46ProbeOpenShadows() {
        /*
          This runs only once, during browser idle time. We only inspect hosts
          that actually expose an OPEN shadowRoot.
        */
        let elements = [];

        try {
            elements = Array.from(
                document.querySelectorAll("*")
            );
        } catch (_) {
            return false;
        }

        for (const host of elements) {
            const shadow = host.shadowRoot;
            if (!shadow) continue;

            const seed =
                uw46FindTextSeed(shadow);

            if (!seed) continue;

            const candidate =
                uw46CandidateFromSeed(host) || host;

            if (uw46MoveCalendar(candidate)) {
                return true;
            }
        }

        return false;
    }

    function uw46DeepProbe() {
        uw46DeepProbeScheduled = false;

        if (
            uw46CalendarCaptured ||
            uw46DeepProbeDone
        ) {
            return;
        }

        uw46DeepProbeDone = true;

        if (uw46ProbeDocument(document)) {
            return;
        }

        uw46ProbeOpenShadows();
    }

    function uw46ScheduleDeepProbe() {
        if (
            uw46CalendarCaptured ||
            uw46DeepProbeDone ||
            uw46DeepProbeScheduled
        ) {
            return;
        }

        uw46DeepProbeScheduled = true;

        const run = () => {
            window.setTimeout(
                uw46DeepProbe,
                0
            );
        };

        if (
            typeof requestIdleCallback ===
            "function"
        ) {
            requestIdleCallback(
                run,
                { timeout: 7000 }
            );
        } else {
            window.setTimeout(
                run,
                6000
            );
        }
    }

    function uw46TailCandidateScore(el) {
        if (
            !el ||
            !(el instanceof Element) ||
            !el.isConnected ||
            isMajorRoot(el) ||
            isFooterish(el) ||
            el.closest?.(`#${WATERFALL_ID}`) ||
            el.closest?.("#global_header, #store_header")
        ) {
            return -Infinity;
        }

        const r = el.getBoundingClientRect();
        const W = Math.max(1, window.innerWidth);
        const H = Math.max(1, window.innerHeight);
        const wr = r.width / W;
        const hr = r.height / H;
        const cx = (r.left + r.right) / 2 / W;

        /*
          The stock Calendar in the supplied 5230x1950 recording is a centered
          medium-width, medium-height module. Discovery underneath is much
          shorter, while waterfall recommendation cards are excluded above.
        */
        if (
            wr < 0.14 ||
            wr > 0.42 ||
            hr < 0.14 ||
            hr > 0.48 ||
            cx < 0.30 ||
            cx > 0.70 ||
            r.bottom < 0 ||
            r.top > H
        ) {
            return -Infinity;
        }

        let score = 0;

        const t = text(el);

        if (uw46CalendarPhrase(t)) score += 1000;
        if (/personalized[-\s]*for[-\s]*you/i.test(t)) score += 250;
        if (/\bmon\b/i.test(t)) score += 30;
        if (/\btue\b/i.test(t)) score += 30;
        if (/\bwed\b/i.test(t)) score += 30;
        if (/\bthu\b/i.test(t)) score += 30;
        if (/\bfri\b/i.test(t)) score += 30;

        if (
            uw46DiscoveryPhrase(t) &&
            !uw46CalendarPhrase(t)
        ) {
            score -= 1000;
        }

        if (
            el.tagName === "IFRAME"
        ) {
            score += 100;
        }

        if (
            /calendar/i.test(
                String(el.id || "") + " " +
                String(el.className || "")
            )
        ) {
            score += 150;
        }

        /* Geometric fingerprint: around 1/4 viewport width and 1/4 height. */
        score += 120 - Math.abs(wr - 0.24) * 250;
        score += 120 - Math.abs(hr - 0.27) * 220;

        return score;
    }

    function uw46VisualTailRescue() {
        uw46TailRAF = 0;

        if (uw46CalendarCaptured) {
            return;
        }

        const remaining =
            document.documentElement.scrollHeight -
            (window.scrollY + window.innerHeight);

        /* Only arm the geometric fallback near Steam's stock tail. */
        if (
            remaining >
                window.innerHeight * 1.35
        ) {
            return;
        }

        const W = window.innerWidth;
        const H = window.innerHeight;
        const xs = [0.42, 0.50, 0.58];
        const candidates = new Map();

        for (const xf of xs) {
            for (
                let y = Math.max(40, H * 0.08);
                y < H * 0.90;
                y += Math.max(55, H * 0.055)
            ) {
                let stack = [];

                try {
                    stack = document.elementsFromPoint(
                        W * xf,
                        y
                    );
                } catch (_) {}

                for (const hit of stack) {
                    let node = hit;

                    for (
                        let depth = 0;
                        depth < 8 &&
                        node;
                        depth++
                    ) {
                        const score =
                            uw46TailCandidateScore(node);

                        if (
                            Number.isFinite(score)
                        ) {
                            const old =
                                candidates.get(node);

                            if (
                                old === undefined ||
                                score > old
                            ) {
                                candidates.set(
                                    node,
                                    score
                                );
                            }
                        }

                        node = node.parentElement;
                    }
                }
            }
        }

        if (!candidates.size) {
            return;
        }

        const ranked =
            Array.from(candidates.entries())
                .sort((a, b) =>
                    b[1] - a[1]
                );

        for (const [candidate, score] of ranked) {
            /* Require a strong geometric match if text is inaccessible. */
            if (score < 90) continue;

            if (uw46MoveCalendar(candidate)) {
                return;
            }
        }
    }

    function uw46ScheduleTailRescue() {
        if (
            uw46CalendarCaptured ||
            uw46TailRAF
        ) {
            return;
        }

        uw46TailRAF =
            requestAnimationFrame(
                uw46VisualTailRescue
            );
    }

    function uw46LegacyCalendarRoot() {
        const link =
            uw43VisibleCalendarLink();

        if (!link) {
            return null;
        }

        /*
          First choice: Steam's normal discrete homepage-module wrapper.
          This is a local closest() operation, not a page scan.
        */
        const normal =
            link.closest(
                ".home_ctn, .home_cluster_ctn"
            );

        if (normal) {
            const r =
                normal.getBoundingClientRect();

            if (
                r.width >= 420 &&
                r.height >= 120 &&
                r.height <= 1100 &&
                /personal\s+calendar/i.test(
                    text(normal)
                )
            ) {
                return normal;
            }
        }

        /*
          Fallback: walk ONLY the ancestors of the link.

          We remember the largest Calendar-looking ancestor, but stop before:
          - a major page root
          - a huge multi-screen container
          - anything that already contains Discovery Queue

          No media-count requirement. V42's media test was too strict because
          Steam's cards may use CSS backgrounds rather than <img> elements.
        */
        let node = link;
        let best = null;

        for (
            let i = 0;
            i < 10 &&
            node &&
            node.parentElement;
            i++
        ) {
            const parent =
                node.parentElement;

            if (
                !parent ||
                isMajorRoot(parent)
            ) {
                break;
            }

            if (
                parent.querySelector(
                    ".discovery_queue_ctn"
                ) ||
                /explore\s+your\s+discovery\s+queue/i
                    .test(text(parent))
            ) {
                break;
            }

            const r =
                parent.getBoundingClientRect();

            if (
                r.width >= 420 &&
                r.height >= 120 &&
                r.height <= 1100 &&
                /personal\s+calendar/i.test(
                    text(parent)
                )
            ) {
                best = parent;
            }

            if (
                r.height >
                    Math.max(
                        1200,
                        window.innerHeight * 1.5
                    )
            ) {
                break;
            }

            node = parent;
        }

        return best;
    }


    function uw43CalendarRoot() {
        if (
            uw46CalendarCaptured &&
            uw46CalendarRoot &&
            uw46CalendarRoot.isConnected
        ) {
            uw47KeepCalendarTop();
            return uw46CalendarRoot;
        }

        /*
          V47: exact selector confirmed in Steam DevTools on the user's page.
          No text search, href search, ancestor guessing, geometry probe,
          Shadow DOM probe, or tail rescue is necessary.
        */
        const calendar =
            document.querySelector(
                ".personal_calendar_ctn"
            );

        if (!calendar) {
            return null;
        }

        uw46MoveCalendar(calendar);
        return calendar;
    }

    function uw43DiscoverySignal() {
        /*
          Prefer Steam's longstanding class. If Valve changed it, search only
          a very small heading/control set -- never every DIV/SPAN.
        */
        const direct =
            document.querySelector(
                ".discovery_queue_ctn"
            );

        if (direct) {
            return direct;
        }

        const candidates =
            document.querySelectorAll(
                "h1, h2, h3, h4, a, button, " +
                "[class*='title'], [class*='Title'], " +
                "[class*='header'], [class*='Header']"
            );

        for (const el of candidates) {
            if (
                isVisible(el) &&
                /^(?:explore\s+)?your\s+discovery\s+queue$/i
                    .test(text(el))
            ) {
                return el;
            }
        }

        return null;
    }

    function uw43DiscoveryRoot() {
        const exact = uw48DiscoveryRootExact();
        if (exact) return exact;

        /*
          Conservative fallback for Valve variants. Do not let Discovery absorb
          Calendar, Developers, or a major page root.
        */
        const signal = uw43DiscoverySignal();
        if (!signal) return null;

        let node = signal;
        let best = null;

        for (
            let i = 0;
            i < 7 &&
            node &&
            node.parentElement;
            i++
        ) {
            const parent = node.parentElement;
            if (!parent || isMajorRoot(parent)) break;

            const t = text(parent);
            if (
                /your\s+personal\s+calendar/i.test(t) ||
                /from\s+developers\s+and\s+publishers\s+you\s+know/i.test(t)
            ) {
                break;
            }

            const r = parent.getBoundingClientRect();
            if (
                r.width >= 420 &&
                r.height >= 60 &&
                r.height <= 700 &&
                /discovery\s+queue/i.test(t)
            ) {
                best = parent;
            }

            node = parent;
        }

        return best;
    }

    function uw39ResolveUtilityRoot(spec) {
        const cached =
            uw39UtilityRoots.get(
                spec.key
            );

        if (
            cached &&
            cached.isConnected
        ) {
            return cached;
        }

        /*
          V43 special cases use direct, low-cost signals and never invoke
          broad text fallback searches.
        */
        if (spec.key === "calendar") {
            const calendar =
                uw43CalendarRoot();

            if (calendar) {
                calendar.dataset
                    .uw39UtilityKey =
                    spec.key;

                uw39UtilityRoots.set(
                    spec.key,
                    calendar
                );

                return calendar;
            }

            return null;
        }

        if (spec.key === "discovery") {
            const discovery =
                uw43DiscoveryRoot();

            if (discovery) {
                discovery.dataset
                    .uw39UtilityKey =
                    spec.key;

                uw39UtilityRoots.set(
                    spec.key,
                    discovery
                );

                return discovery;
            }

            return null;
        }

        const heading =
            uw39FindHeading(spec);

        /*
          Known Valve module classes are the safest roots when present.
        */
        for (
            const selector of
            spec.directSelectors
        ) {
            let candidate = null;

            if (heading) {
                candidate =
                    heading.closest(
                        selector
                    );
            }

            if (!candidate) {
                candidate =
                    document.querySelector(
                        selector
                    );
            }

            if (
                candidate &&
                (
                    !heading ||
                    uw39ValidateRoot(
                        candidate,
                        heading,
                        spec
                    )
                )
            ) {
                candidate.dataset
                    .uw39UtilityKey =
                    spec.key;

                uw39UtilityRoots.set(
                    spec.key,
                    candidate
                );

                return candidate;
            }
        }

        if (!heading) {
            return null;
        }

        /*
          Calendar/Browse and any class-name fallback:
          use the NEAREST actual Steam home module only.

          No upward "best parent" search. If the nearest home module is not
          safe, we decline to move it.
        */
        const candidate =
            heading.closest(
                ".home_ctn, " +
                ".home_cluster_ctn, " +
                ".home_page_content"
            );

        if (
            candidate &&
            uw39ValidateRoot(
                candidate,
                heading,
                spec
            )
        ) {
            candidate.dataset
                .uw39UtilityKey =
                spec.key;

            uw39UtilityRoots.set(
                spec.key,
                candidate
            );

            return candidate;
        }

        /*
          One final LOCAL fallback: walk at most four ancestors, and only
          accept the first one that already looks like a discrete card/module.
          We never keep climbing in search of a "best" parent.
        */
        let node = heading;

        for (
            let i = 0;
            i < 4 &&
            node.parentElement;
            i++
        ) {
            node =
                node.parentElement;

            if (
                uw39ValidateRoot(
                    node,
                    heading,
                    spec
                ) &&
                (
                    node.querySelector(
                        "img, video, canvas, a[href]"
                    ) ||
                    node.children.length >= 2
                )
            ) {
                node.dataset
                    .uw39UtilityKey =
                    spec.key;

                uw39UtilityRoots.set(
                    spec.key,
                    node
                );

                return node;
            }
        }

        return null;
    }

    function uw39IsUtilityRelated(el) {
        if (!el) return false;

        /*
          Protect known-class utility modules even before title resolution.
        */
        if (
            el.matches?.(
                ".discovery_queue_ctn, " +
                ".recommended_creators_ctn, " +
                ".community_recommendations_by_steam_labs_ctn"
            ) ||
            el.closest?.(
                ".discovery_queue_ctn, " +
                ".recommended_creators_ctn, " +
                ".community_recommendations_by_steam_labs_ctn"
            )
        ) {
            return true;
        }

        for (
            const root of
            uw39UtilityRoots.values()
        ) {
            if (
                !root ||
                !root.isConnected
            ) {
                continue;
            }

            if (
                el === root ||
                root.contains?.(el) ||
                el.contains?.(root)
            ) {
                return true;
            }
        }

        return false;
    }

    function uw39ResolveAllUtilities() {
        for (
            const spec of
            UW39_UTILITY_SPECS
        ) {
            const root =
                uw39ResolveUtilityRoot(
                    spec
                );

            /*
              Once an exact root is known, reserve that exact module
              immediately so generic discovery cannot steal it.
            */
            if (root) {
                root.dataset
                    .uw32Priority =
                    spec.key;

                specialRoots.set(
                    spec.key,
                    root
                );
            }
        }
    }

    function uw39PlaceUtilities(laneSet) {
        if (
            !laneSet ||
            laneSet.length < 3
        ) {
            return;
        }

        uw39ResolveAllUtilities();

        for (
            const spec of
            UW39_UTILITY_SPECS
        ) {
            /*
              V48: Calendar + Discovery are raw native top-left modules. The
              generic utility path would wrap/fit them and can visually distort
              them, so only resolve/cache them here; placement is handled by
              uw48KeepTopLeftUtilities().
            */
            if (
                spec.key === "calendar" ||
                spec.key === "discovery"
            ) {
                continue;
            }

            const module =
                uw39UtilityRoots.get(
                    spec.key
                );

            const lane =
                laneSet[
                    spec.laneIndex
                ];

            if (
                !module ||
                !module.isConnected ||
                !lane
            ) {
                continue;
            }

            if (
                !placedModules.has(
                    module
                )
            ) {
                /*
                  Only move an exact resolved module. Unlike V42, no expensive
                  readiness probing/search loop is involved.
                */
                moveModule(
                    module,
                    lane,
                    "uw39-utility-module",
                    true
                );
            }

            if (
                placedModules.has(
                    module
                )
            ) {
                protectSpecial(
                    module,
                    spec.key
                );

                markPinned(
                    module,
                    lane,
                    spec.order
                );

                const slot =
                    moduleSlots.get(
                        module
                    );

                if (slot) {
                    slot.classList.add(
                        "uw39-utility-slot"
                    );

                    if (
                        spec.key ===
                        "calendar"
                    ) {
                        slot.classList.add(
                            "uw47-calendar-slot"
                        );
                    }

                    if (
                        spec.laneIndex === 1
                    ) {
                        slot.classList.add(
                            "uw43-middle-utility"
                        );
                    }
                }
            }
        }
    }

    function discountsRoot() {
        return stableSpecialRoot(
            "discounts",
            /^discounts?\s*&\s*events$/i
        );
    }

    function browseRoot() {
        return stableSpecialRoot(
            "browse",
            /^browse by category$/i
        );
    }

    function communityRoot() {
        return stableSpecialRoot(
            "community",
            /^the community recommends$/i
        );
    }

    function ensureWaterfall() {
        let shell =
            document.getElementById(
                WATERFALL_ID
            );

        const anchor =
            discountsRoot();

        if (!shell) {
            shell =
                document.createElement(
                    "main"
                );

            shell.id = WATERFALL_ID;

            for (let i = 0; i < 3; i++) {
                const lane =
                    document.createElement(
                        "section"
                    );

                lane.id = LANE_IDS[i];
                lane.className = "uw25-lane";
                shell.appendChild(lane);
            }
        }

        /* V51: the three scaffolding nodes must never lose lane identity. */
        for (let i = 0; i < LANE_IDS.length; i++) {
            const lane = document.getElementById(LANE_IDS[i]);
            if (lane) {
                lane.classList.add("uw25-lane");
                lane.classList.remove(
                    "uw25-home-module",
                    "uw26-deep-module",
                    "uw25-releases-module",
                    "uw32-protected-module"
                );
                delete lane.dataset.uw32Priority;
                delete lane.dataset.uw29Order;
                delete lane.dataset.uw30Kind;
            }
        }

        /*
          Start exactly where Discounts & Events originally lived.
          Everything above remains stock Steam.
        */
        if (
            anchor &&
            anchor.parentElement &&
            anchor !== shell &&
            anchor.parentElement !== shell &&
            !anchor.contains(shell) &&
            !shell.contains(anchor) &&
            !shell.contains(anchor.parentElement) &&
            !anchor.parentElement.contains(shell) &&
            !anchor.parentElement.closest?.(`#${WATERFALL_ID}`) &&
            shell.parentElement !== anchor.parentElement
        ) {
            /*
              V47 containment guard.

              After Discounts & Events has been moved into the waterfall,
              anchor.parentElement is a descendant of shell. Trying to call
              descendant.insertBefore(shell, anchor) creates a DOM cycle and
              throws:

                Failed to execute 'insertBefore' on 'Node':
                The new child element contains the parent.

              Never reposition the waterfall relative to an anchor it already
              owns.
            */
            anchor.parentElement
                .insertBefore(
                    shell,
                    anchor
                );
        } else if (
            !shell.parentElement
        ) {
            (
                document.querySelector(
                    "#responsive_page_template_content"
                ) ||
                document.body
            ).appendChild(shell);
        }

        return shell;
    }

    function lanes() {
        return LANE_IDS
            .map(id =>
                document.getElementById(id)
            )
            .filter(Boolean);
    }

    function laneHeight(lane) {
        if (!lane) return Number.POSITIVE_INFINITY;

        const r =
            lane.getBoundingClientRect();

        return Math.max(
            r.height,
            lane.scrollHeight || 0
        );
    }

    function shortestLane() {
        const ls = lanes();

        if (!ls.length) return null;

        let best = ls[0];
        let bestH = laneHeight(best);

        for (let i = 1; i < ls.length; i++) {
            const h = laneHeight(ls[i]);

            if (h < bestH) {
                best = ls[i];
                bestH = h;
            }
        }

        return best;
    }


    function moduleLooksReady(module) {
        if (!module) return false;

        const r =
            module.getBoundingClientRect();

        if (
            r.width < 40 ||
            r.height < 35
        ) {
            return false;
        }

        const appLinks =
            module.querySelectorAll(
                'a[href*="/app/"]'
            ).length;

        /*
          Several Steam home modules use links that are NOT /app/ links
          (calendar, curator, discovery, publishers, etc.).
        */
        const usefulLinks =
            module.querySelectorAll(
                "a[href]"
            ).length;

        /*
          naturalWidth was too strict in V28: an <img src=...> can already
          represent a fully-created card before the image bytes finish
          decoding. Waiting for naturalWidth meant some sections were never
          rescanned after the image load completed.
        */
        const sourcedImages =
            Array.from(
                module.querySelectorAll("img")
            ).filter(img => {
                const src =
                    img.currentSrc ||
                    img.getAttribute("src") ||
                    img.getAttribute("data-src") ||
                    "";

                return !!src;
            }).length;

        const styledMedia =
            module.querySelectorAll(
                '[style*="background"], ' +
                '[style*="background-image"]'
            ).length;

        const videos =
            module.querySelectorAll(
                "video, canvas"
            ).length;

        /*
          Heading-only lazy shells normally have at most one utility link.
          A populated Steam module has cards/media or multiple actionable
          links even when it does not contain /app/ URLs.
        */
        const ready =
            appLinks > 0 ||
            sourcedImages > 0 ||
            styledMedia > 0 ||
            videos > 0 ||
            usefulLinks >= 2;

        module.classList.toggle(
            "uw28-awaiting-content",
            !ready
        );

        return ready;
    }

    function ensureRunway() {
        /*
          V29: disabled. The artificial runway was responsible for giant
          blank areas and did not reliably make Steam append another batch.
        */
        return null;
    }

    function setRunwayLevel() {}
    function armRunway() {}
    function collapseRunwayAfterContent() {}


    function moduleKind(module) {
        if (!module) return "standard";

        const cached =
            module.dataset.uw30Kind;

        if (cached) {
            return cached;
        }

        const t =
            text(module)
                .replace(/\s+/g, " ")
                .toLowerCase();

        const r =
            module.getBoundingClientRect();

        /*
          Large Steam recommendation cards generally have text such as:
            "Since you wish for..."
            "Since you recently played..."
          and often expose product-page / wishlist / ignore controls.
        */
        const looksFeature =
            /since you (wish|recently played)/i.test(t) ||
            (
                /view product page/i.test(t) &&
                /find more like this/i.test(t)
            ) ||
            (
                r.height >= 260 &&
                module.querySelectorAll(
                    'a[href*="/app/"]'
                ).length <= 3 &&
                module.querySelectorAll(
                    "img"
                ).length >= 3
            );

        /*
          Compact discovery modules include genre rows, small recommendation
          strips, calendar/wishlist/DLC utilities, and familiar Store shelves.
        */
        const looksCompact =
            /games due to your recent playtime in other .* games/i.test(t) ||
            /^under \$\d+/i.test(t) ||
            /your personal calendar/i.test(t) ||
            /your wishlist/i.test(t) ||
            /dlc for your games/i.test(t) ||
            /recently updated/i.test(t) ||
            /curator recommendations/i.test(t) ||
            /from developers and publishers you know/i.test(t) ||
            /recommended based on the games you play/i.test(t) ||
            /because you played/i.test(t) ||
            /browse by category/i.test(t) ||
            (
                r.height <= 235 &&
                module.querySelectorAll(
                    'a[href*="/app/"]'
                ).length >= 3
            );

        let kind = "standard";

        if (looksFeature) {
            kind = "feature";
        } else if (looksCompact) {
            kind = "compact";
        }

        module.dataset.uw30Kind =
            kind;

        module.classList.add(
            `uw30-kind-${kind}`
        );

        return kind;
    }

    function estimatedSlotHeight(module) {
        if (!module) return 1;

        const slot =
            moduleSlot(module);

        if (slot) {
            return slotHeight(slot);
        }

        const r =
            module.getBoundingClientRect();

        return Math.max(
            1,
            r.height
        );
    }

    function laneMetricHeights() {
        const ls = lanes();

        const result =
            new Map();

        for (const lane of ls) {
            result.set(
                lane,
                laneHeight(lane)
            );
        }

        return result;
    }

    /*
      V55: identify Valve's live aggregate feed wrappers BEFORE they can be
      mistaken for one visual module. These wrappers can start short and then
      grow by many thousands of pixels as Steam lazily appends recommendation
      sections. Moving one into a waterfall lane causes all future content to
      accumulate in that single lane.
    */
    function uw55AggregateFeedHost(el) {
        if (!el) return false;

        if (
            el.id === WATERFALL_ID ||
            el.classList?.contains("uw25-lane") ||
            el.classList?.contains("uw27-module-slot") ||
            el.classList?.contains("uw32-protected-module") ||
            el.classList?.contains("uw25-releases-module") ||
            isPriorityRelated(el) ||
            uw39IsUtilityRelated(el) ||
            isFooterish(el) ||
            isMajorRoot(el)
        ) {
            return false;
        }

        /* PERFORMANCE: deep discovery examines many DOM nodes. Do not run
           descendant-count queries on every generic DIV. Valve's live home
           feed wrapper is a .home_ctn; a module already in our waterfall is
           also eligible for the slower recovery test. */
        const likelyHost =
            el.classList?.contains("home_ctn") ||
            el.classList?.contains("uw25-home-module") ||
            el.dataset?.uw55FeedHost === "true";

        if (!likelyHost) {
            return false;
        }

        /* The failure captured in the V54 diagnostic had 17 nested
           .home_pagecontent_ctn sections and 374 app links. A real single
           module normally has zero nested page-content sections. */
        const nestedSections =
            el.querySelectorAll(".home_pagecontent_ctn").length;

        if (nestedSections >= 2) {
            return true;
        }

        const directChildren =
            Array.from(el.children || []).filter(child => {
                if (!(child instanceof HTMLElement)) return false;
                const r = child.getBoundingClientRect();
                return r.width >= 300 && r.height >= 60;
            });

        if (directChildren.length < 2) {
            return false;
        }

        const r = el.getBoundingClientRect();
        const appLinks = el.querySelectorAll('a[href*="/app/"]').length;
        const descendants = el.querySelectorAll("*").length;

        return (
            (appLinks >= 60 && descendants >= 700) ||
            (r.height >= 2200 && appLinks >= 24 && descendants >= 450)
        );
    }

    function uw55NativeAggregateStream(el) {
        if (
            !el ||
            !outsideWaterfall(el) ||
            !uw55AggregateFeedHost(el)
        ) {
            return false;
        }

        const r = el.getBoundingClientRect();

        if (r.width < 620 || r.width > 1700 || r.height < 180) {
            return false;
        }

        const center = r.left + r.width / 2;
        const tolerance = Math.max(420, window.innerWidth * 0.15);

        return Math.abs(center - window.innerWidth / 2) <= tolerance;
    }

    function uw56FeedColumnCount() {
        if (window.innerWidth <= 1900) return 1;
        if (window.innerWidth <= 3000) return 2;
        return 3;
    }

    function uw56FeedGap() {
        const raw = getComputedStyle(document.documentElement)
            .getPropertyValue("--uw25-gap");
        const n = parseFloat(raw || "18");
        return Number.isFinite(n) ? n : 18;
    }

    function uw56ResetMovedModule(module) {
        if (!module) return;

        const slot = moduleSlots.get(module);
        if (slot && slot.isConnected) slot.remove();
        moduleSlots.delete(module);

        placedModules.delete(module);
        deepPlacedModules.delete(module);
        dirtyFitModules.delete(module);

        if (resizeObserver) {
            try { resizeObserver.unobserve(module); } catch (_) {}
        }

        module.classList.remove(
            "uw25-home-module",
            "uw26-deep-module",
            "uw30-kind-feature",
            "uw30-kind-compact",
            "uw30-kind-standard",
            "uw32-genre-module"
        );

        module.style.removeProperty("transform");
        module.style.removeProperty("position");
        module.style.removeProperty("top");
        module.style.removeProperty("left");
        module.style.removeProperty("width");
        module.style.removeProperty("max-width");
        module.style.removeProperty("min-width");
        module.style.removeProperty("height");

        delete module.dataset.uw30Kind;
        delete module.dataset.uw27OriginalWidth;
        delete module.dataset.uw27NaturalWidth;
        delete module.dataset.uw29Order;
        delete module.dataset.uw54DeepLane;
        delete module.dataset.uw54DeepWeight;
    }

    function uw56RestoreFeedDescendants(host) {
        if (!host) return 0;

        let restored = 0;
        const moved = Array.from(document.querySelectorAll(
            `#${WATERFALL_ID} .uw27-module-slot > .uw25-home-module`
        ));

        for (const module of moved) {
            const source = uw51DeepSource.get(module);
            if (!source || !source.parent || !source.parent.isConnected) continue;

            if (
                source.parent !== host &&
                !host.contains(source.parent)
            ) {
                continue;
            }

            source.parent.classList.remove("uw25-home-vacated");

            if (source.marker && source.marker.parentNode === source.parent) {
                source.parent.insertBefore(module, source.marker);
                source.marker.remove();
            } else {
                source.parent.appendChild(module);
            }

            uw56ResetMovedModule(module);
            restored++;
        }

        return restored;
    }


    function uw56FeedCards(host) {
        if (!host) return [];

        /*
          V57: only the direct children of Steam's #content_more participate
          in the ultrawide feed grid.  V56 recursively harvested descendants,
          which meant one appended batch could produce dozens of measured
          "cards" and forced an increasingly expensive absolute-layout pass.
        */
        const content =
            host.querySelector(":scope > #content_more") ||
            host.querySelector("#content_more");

        if (!content) return [];

        return Array.from(content.children).filter(el => {
            if (!(el instanceof HTMLElement)) return false;
            if (isFooterish(el) || isPriorityRelated(el) || uw39IsUtilityRelated(el)) return false;

            /*
              Preserve Valve's structural / loader nodes.  Real recommendation
              batches are page-content containers; other direct children stay
              in normal flow and span the full grid width.
            */
            return (
                el.classList.contains("home_pagecontent_ctn") ||
                el.matches?.("[data-ds-appid], [data-ds-bundleid], [data-ds-packageid]")
            );
        });
    }


    function uw56MarkFeedStructure(host) {
        if (!host) return [];

        const content =
            host.querySelector(":scope > #content_more") ||
            host.querySelector("#content_more");

        if (!content) return [];

        host.classList.add("uw57-native-feed-stage");
        content.classList.remove("uw56-native-feed-flatten");
        content.classList.add("uw57-native-feed-grid");

        /*
          Clean up V56's recursive staging markers ONCE.  The V56 dump showed
          thousands of descendants under the live feed. Re-running recursive
          querySelectorAll() cleanup for every append burst recreates the very
          O(N) growth V57 is meant to remove.
        */
        if (host.dataset.uw57LegacyCleanup !== "true") {
            host.querySelectorAll(".uw56-native-feed-flatten").forEach(el => {
                if (el !== content) el.classList.remove("uw56-native-feed-flatten");
            });

            host.querySelectorAll(".uw56-native-feed-card").forEach(el => {
                el.classList.remove("uw56-native-feed-card");
                el.style.removeProperty("position");
                el.style.removeProperty("left");
                el.style.removeProperty("top");
                el.style.removeProperty("width");
                el.style.removeProperty("max-width");
                el.style.removeProperty("min-width");
                el.style.removeProperty("height");
            });

            host.dataset.uw57LegacyCleanup = "true";
        }

        const cards = uw56FeedCards(host);
        const cardSet = new Set(cards);

        for (const child of Array.from(content.children)) {
            if (!(child instanceof HTMLElement)) continue;

            if (cardSet.has(child)) {
                child.classList.add("uw57-native-feed-card");
                child.classList.remove("uw57-native-feed-structural");
            } else {
                child.classList.remove("uw57-native-feed-card");
                child.classList.add("uw57-native-feed-structural");
                child.style.removeProperty("grid-row-end");
                delete child.dataset.uw58MasonrySpan;
                delete child.dataset.uw58MasonryMeasured;
            }
        }

        uw58BindMasonryLoadEvents(host);
        uw58MarkNewMasonryCards(
            host,
            Array.from(content.children).filter(child =>
                child instanceof HTMLElement &&
                (
                    child.classList.contains("uw57-native-feed-card") ||
                    child.classList.contains("uw57-native-feed-structural")
                )
            )
        );

        return cards;
    }


    function uw56EnsureFeedResizeObserver() {
        /*
          V57 deliberately has no per-card ResizeObserver.

          CSS Grid owns the live feed geometry now, so images/text can resize
          naturally without JavaScript measuring every card and recalculating
          the entire feed.  This removes the O(N) layout loop that became
          progressively more expensive the farther the page was scrolled.
        */
        if (uw56FeedResizeObserver) {
            try { uw56FeedResizeObserver.disconnect(); } catch (_) {}
            uw56FeedResizeObserver = null;
        }
    }



    function uw58GridMetrics(host) {
        const content =
            host?.querySelector?.(":scope > #content_more") ||
            host?.querySelector?.("#content_more");

        if (!content) {
            return {
                content: null,
                row: 8,
                gap: Math.max(10, uw56FeedGap())
            };
        }

        const style = getComputedStyle(content);
        const row = Math.max(
            2,
            parseFloat(style.gridAutoRows) || 8
        );
        const gap = Math.max(
            0,
            parseFloat(style.rowGap) || uw56FeedGap() || 16
        );

        return { content, row, gap };
    }

    function uw58QueueMasonryCards(host, cards, delay = 80) {
        if (!host || !host.isConnected || !cards?.length) return;

        let dirty = uw58MasonryDirty.get(host);
        if (!dirty) {
            dirty = new Set();
            uw58MasonryDirty.set(host, dirty);
        }

        for (const card of cards) {
            if (
                card instanceof HTMLElement &&
                card.isConnected &&
                (
                    card.classList.contains("uw57-native-feed-card") ||
                    card.classList.contains("uw57-native-feed-structural")
                )
            ) {
                dirty.add(card);
            }
        }

        if (!dirty.size || uw58MasonryTimer.get(host)) return;

        const timer = window.setTimeout(() => {
            uw58MasonryTimer.delete(host);

            requestAnimationFrame(() => {
                uw58FlushMasonry(host);
            });
        }, Math.max(0, delay));

        uw58MasonryTimer.set(host, timer);
    }

    function uw58FlushMasonry(host) {
        if (!host || !host.isConnected) return;

        const dirty = uw58MasonryDirty.get(host);
        if (!dirty || !dirty.size) return;

        const { content, row, gap } = uw58GridMetrics(host);
        if (!content) {
            dirty.clear();
            return;
        }

        const cards = Array.from(dirty).filter(card =>
            card.isConnected &&
            card.parentElement === content &&
            (
                card.classList.contains("uw57-native-feed-card") ||
                card.classList.contains("uw57-native-feed-structural")
            )
        );
        dirty.clear();

        if (!cards.length) return;

        /*
          READ PHASE: collect every changed card's intrinsic rendered height.
          Existing spans stay in place while measuring; align-self:start keeps
          the grid area from stretching the card's own box.
        */
        const measurements = cards.map(card => ({
            card,
            height: Math.max(
                1,
                card.getBoundingClientRect().height,
                card.scrollHeight || 0
            )
        }));

        /*
          WRITE PHASE: one compact style update per changed card. The formula
          accounts for both the tiny masonry row and the real inter-card gap.
        */
        let changed = false;

        for (const { card, height } of measurements) {
            const span = Math.max(
                1,
                Math.ceil((height + gap) / (row + gap))
            );

            if (card.dataset.uw58MasonrySpan !== String(span)) {
                card.dataset.uw58MasonrySpan = String(span);
                card.style.setProperty(
                    "grid-row-end",
                    `span ${span}`,
                    "important"
                );
                changed = true;
            }

            card.dataset.uw58MasonryMeasured = "true";
        }

        /*
          The host's real flow height may have changed after the span writes.
          Updating the translated Valve footer once per coalesced batch is
          cheap and keeps it below the feed.
        */
        if (changed) {
            requestAnimationFrame(() => {
                uw57PositionFooterAfterFeed(host);
            });
        }
    }

    function uw58BindMasonryLoadEvents(host) {
        if (!host || uw58MasonryLoadBound.has(host)) return;

        const content =
            host.querySelector(":scope > #content_more") ||
            host.querySelector("#content_more");

        if (!content) return;

        /*
          One capture listener per feed, not one observer/listener per card.
          Native image load events do not bubble, but capture sees them.
        */
        content.addEventListener(
            "load",
            event => {
                const target = event.target;
                if (!(target instanceof HTMLImageElement)) return;

                const card = target.closest(".uw57-native-feed-card");
                if (!card || card.parentElement !== content) return;

                uw58QueueMasonryCards(host, [card], 60);
            },
            true
        );

        uw58MasonryLoadBound.add(host);
    }

    function uw58MarkNewMasonryCards(host, cards) {
        if (!host || !cards?.length) return;

        const newlySeen = cards.filter(card => {
            if (card.dataset.uw58MasonryKnown === "true") return false;
            card.dataset.uw58MasonryKnown = "true";
            return true;
        });

        if (!newlySeen.length) return;

        /*
          Measure the newly appended batch immediately in one READ phase and
          one WRITE phase. This prevents a freshly inserted card from spending
          even a frame in a one-row (8px) grid area and visually overlapping
          its neighbors. Crucially, we still touch ONLY the new batch.
        */
        let dirty = uw58MasonryDirty.get(host);
        if (!dirty) {
            dirty = new Set();
            uw58MasonryDirty.set(host, dirty);
        }
        newlySeen.forEach(card => dirty.add(card));
        uw58FlushMasonry(host);

        /*
          One quiet settling pass catches late text/layout changes. Image loads
          are handled independently by the single capture listener.
        */
        window.setTimeout(() => {
            uw58QueueMasonryCards(
                host,
                newlySeen.filter(card => card.isConnected),
                0
            );
        }, 650);
    }


    function uw56LayoutNativeFeedHost(host) {
        if (!host || !host.isConnected || !host.classList.contains("uw56-native-feed-stage")) return;

        /*
          V57: normal-flow layout only.  Marking is cheap and CSS Grid performs
          all sizing/placement.  No getBoundingClientRect() loop, no absolute
          positioning, no synthetic stage height.
        */
        const cards = uw56MarkFeedStructure(host);

        delete host.dataset.uw56StageHeight;
        host.style.removeProperty("height");
        host.style.removeProperty("min-height");

        for (const card of cards) {
            delete card.dataset.uw56FeedLane;
            delete card.dataset.uw56ResizeObserved;
        }

        const unmeasured = cards.filter(
            card => card.dataset.uw58MasonryMeasured !== "true"
        );
        if (unmeasured.length) {
            uw58QueueMasonryCards(host, unmeasured, 30);
        }

        uw57PositionFooterAfterFeed(host);
    }


    function uw56ScheduleFeedLayout(host, delay = 120) {
        if (!host || !host.isConnected) return;

        uw56PendingFeedHosts.add(host);
        if (uw56FeedLayoutTimer) return;

        /*
          Coalesce an entire Steam append burst into one cheap marker pass.
          Browser Grid handles the actual reflow.
        */
        uw56FeedLayoutTimer = window.setTimeout(() => {
            uw56FeedLayoutTimer = 0;
            const pending = Array.from(uw56PendingFeedHosts);
            uw56PendingFeedHosts.clear();

            requestAnimationFrame(() => {
                for (const h of pending) uw56LayoutNativeFeedHost(h);
            });
        }, Math.max(60, delay));
    }


    function uw56PrepareNativeFeedHost(host) {
        if (!host || !host.isConnected || !outsideWaterfall(host)) return false;
        if (!uw55AggregateFeedHost(host) && host.dataset?.uw55FeedHost !== "true") return false;

        uw51DeepFeedHosts.add(host);
        uw56NativeFeedHosts.add(host);

        host.dataset.uw55FeedHost = "true";
        host.dataset.uw56NativeStage = "true";
        host.dataset.uw57NativeStage = "true";

        host.classList.remove("uw25-home-vacated");
        host.classList.add("uw56-native-feed-stage", "uw57-native-feed-stage");

        /*
          Restore any descendant an older generic sweep moved before we knew
          this was Valve's live feed.  From this point onward V57 leaves all
          feed children in their original React/Steam parentage.
        */
        uw56RestoreFeedDescendants(host);
        uw56MarkFeedStructure(host);
        uw56ScheduleFeedLayout(host, 60);

        return true;
    }

    function uw56PreparePotentialNativeFeeds() {
        const hosts = Array.from(document.querySelectorAll(".home_ctn"));
        for (const host of hosts) {
            if (host.closest?.(`#${WATERFALL_ID}`)) continue;
            if (uw55AggregateFeedHost(host)) uw56PrepareNativeFeedHost(host);
        }
    }


    function uw56FeedMutationHosts(records) {
        const hosts = new Set();

        for (const record of records || []) {
            if (record.type !== "childList" || !record.addedNodes?.length) continue;

            const target =
                record.target instanceof Element
                    ? record.target
                    : record.target?.parentElement;

            const host = target?.closest?.(".uw56-native-feed-stage");
            if (host) {
                hosts.add(host);

                const content =
                    host.querySelector(":scope > #content_more") ||
                    host.querySelector("#content_more");

                const card = target?.closest?.(
                    ".uw57-native-feed-card, .uw57-native-feed-structural"
                );
                if (
                    content &&
                    card instanceof HTMLElement &&
                    card.parentElement === content
                ) {
                    uw58QueueMasonryCards(host, [card], 90);
                }
            }
        }

        /*
          V58 still avoids image-src MutationObserver churn and per-card
          ResizeObservers. New DOM batches get one coalesced structure pass;
          only cards whose contents actually changed are remeasured.
        */
        for (const host of hosts) uw56ScheduleFeedLayout(host, 140);
        return hosts.size > 0;
    }

    function isPersonalizedGenreModule(
        module
    ) {
        if (!module || uw55AggregateFeedHost(module)) return false;

        const t =
            text(module)
                .replace(/\s+/g, " ");

        return (
            /games\s+due to your recent playtime in other\s+.+?\s+games/i
                .test(t)
        );
    }

    function outermostAppCards(module) {
        if (!module) return [];

        const anchors =
            Array.from(
                module.querySelectorAll(
                    'a[href*="/app/"]'
                )
            ).filter(a =>
                isVisible(a)
            );

        const byHref =
            new Map();

        for (const anchor of anchors) {
            const href =
                anchor.getAttribute(
                    "href"
                ) || "";

            const match =
                href.match(
                    /\/app\/\d+/
                );

            if (
                !match ||
                byHref.has(match[0])
            ) {
                continue;
            }

            let card = anchor;
            let node = anchor;

            /*
              Walk upward while the parent still appears to represent ONLY
              this same app. That usually lands on Valve's card wrapper and
              keeps price/wishlist badges attached.
            */
            for (
                let i = 0;
                i < 5 &&
                node &&
                node.parentElement &&
                node.parentElement !== module;
                i++
            ) {
                const p =
                    node.parentElement;

                const appHrefs =
                    new Set(
                        Array.from(
                            p.querySelectorAll(
                                'a[href*="/app/"]'
                            )
                        )
                        .map(a => {
                            const h =
                                a.getAttribute(
                                    "href"
                                ) || "";

                            const m =
                                h.match(
                                    /\/app\/\d+/
                                );

                            return m
                                ? m[0]
                                : null;
                        })
                        .filter(Boolean)
                    );

                if (
                    appHrefs.size !== 1 ||
                    !appHrefs.has(match[0])
                ) {
                    break;
                }

                const r =
                    p.getBoundingClientRect();

                if (
                    r.width > 45 &&
                    r.height > 35
                ) {
                    card = p;
                }

                node = p;
            }

            byHref.set(
                match[0],
                card
            );
        }

        return Array.from(
            byHref.values()
        );
    }

    function normalizeGenreModule(module) {
        if (
            !module ||
            normalizedGenreModules.has(
                module
            ) ||
            !isPersonalizedGenreModule(
                module
            )
        ) {
            return;
        }

        const cards =
            outermostAppCards(module);

        /*
          With fewer than two identifiable cards, leave Steam's markup alone.
          With many cards, preserve the first eight so the shelf can use a
          second consistent row rather than becoming horizontally tiny.
        */
        if (cards.length < 1) {
            return;
        }

        const grid =
            document.createElement(
                "div"
            );

        grid.className =
            "uw32-genre-grid";

        for (
            const card of
            cards.slice(0, 8)
        ) {
            card.classList.add(
                "uw32-genre-card"
            );

            grid.appendChild(card);
        }

        module.appendChild(grid);

        module.classList.add(
            "uw32-genre-module"
        );

        normalizedGenreModules.add(
            module
        );
    }

    function uniqueAppCount(module) {
        if (!module) return 0;

        const hrefs =
            new Set();

        module.querySelectorAll(
            'a[href*="/app/"]'
        ).forEach(a => {
            const href =
                a.getAttribute("href") ||
                "";

            const match =
                href.match(
                    /\/app\/\d+/
                );

            if (match) {
                hrefs.add(
                    match[0]
                );
            }
        });

        return hrefs.size;
    }

    /*
      A module is allowed into the LEFT shelf rail only when its geometry is
      reasonably shelf-like.

      This is the central V31 change: "compact" no longer automatically means
      "put it on the left".
    */
    function isUniformLeftShelf(module) {
        if (!module) return false;

        if (
            isPersonalizedGenreModule(
                module
            )
        ) {
            return true;
        }

        const t =
            text(module)
                .replace(/\s+/g, " ")
                .toLowerCase();

        /*
          These special modules have their own intended location/layout.
        */
        if (
            /browse by category/i.test(t) ||
            /the community recommends/i.test(t) ||
            /popular new releases/i.test(t)
        ) {
            return false;
        }

        const r =
            module.getBoundingClientRect();

        const apps =
            uniqueAppCount(module);

        const images =
            module.querySelectorAll(
                "img"
            ).length;

        /*
          Four-to-eight distinct games is the visual density that looked most
          consistent in the full-page capture.

          Allow a few non-/app/ Steam shelves when their media density and
          height strongly resemble the same component.
        */
        const cardDensity =
            (
                apps >= 4 &&
                apps <= 8
            ) ||
            (
                apps === 0 &&
                images >= 4 &&
                images <= 10
            );

        const shelfHeight =
            r.height >= 105 &&
            r.height <= 290;

        return (
            cardDensity &&
            shelfHeight
        );
    }

    function isIrregularCompact(module) {
        if (!module) return false;

        if (
            moduleKind(module) !==
            "compact"
        ) {
            return false;
        }

        return !isUniformLeftShelf(
            module
        );
    }

    function updateSlotPresentation(
        slot,
        module,
        lane
    ) {
        if (!slot) return;

        slot.classList.remove(
            "uw31-left-shelf",
            "uw31-irregular-compact",
            "uw32-genre-shelf",
            "uw32-middle-fixed"
        );

        normalizeGenreModule(
            module
        );

        if (
            lane &&
            lane.id ===
                "uw25-lane-middle" &&
            (
                module.dataset
                    .uw32Priority ===
                    "browse" ||
                module.dataset
                    .uw32Priority ===
                    "community" ||
                module.dataset
                    .uw32Priority ===
                    "calendar" ||
                module.dataset
                    .uw32Priority ===
                    "discovery" ||
                module.dataset
                    .uw32Priority ===
                    "developers"
            )
        ) {
            slot.classList.add(
                "uw32-middle-fixed"
            );
        }

        if (
            lane &&
            lane.id ===
                "uw25-lane-left" &&
            isPersonalizedGenreModule(
                module
            )
        ) {
            slot.classList.add(
                "uw32-genre-shelf"
            );
        }

        if (
            lane &&
            lane.id ===
                "uw25-lane-left" &&
            isUniformLeftShelf(module)
        ) {
            slot.classList.add(
                "uw31-left-shelf"
            );
        }

        if (
            lane &&
            lane.id ===
                "uw25-lane-left" &&
            (
                moduleKind(module) ===
                    "feature" ||
                isIrregularCompact(module)
            )
        ) {
            slot.classList.add(
                "uw39-left-recovery"
            );
        } else {
            slot.classList.remove(
                "uw39-left-recovery"
            );
        }

        if (
            isIrregularCompact(module)
        ) {
            slot.classList.add(
                "uw31-irregular-compact"
            );
        }
    }

    function uw53LaneFeedHeight(lane) {
        if (!lane) return Number.POSITIVE_INFINITY;

        let total = 0;
        let count = 0;

        for (const child of lane.children) {
            if (
                !child.classList?.contains("uw27-module-slot") ||
                child.dataset.uw29PinnedLane
            ) {
                continue;
            }

            if (count > 0) {
                total += laneGap(lane);
            }

            total += slotHeight(child);
            count++;
        }

        return total;
    }

    function uw53FeedMetricHeights() {
        const result = new Map();
        for (const lane of lanes()) {
            result.set(lane, uw53LaneFeedHeight(lane));
        }
        return result;
    }

    function uw53ShortestFeedLane(heightMap = null) {
        const ls = lanes();
        if (!ls.length) return null;

        const heights = heightMap || uw53FeedMetricHeights();
        let best = ls[0];
        let bestH = heights.get(best) || 0;

        for (let i = 1; i < ls.length; i++) {
            const h = heights.get(ls[i]) || 0;
            if (h < bestH - 1) {
                best = ls[i];
                bestH = h;
            }
        }

        return best;
    }

    function uw54DeepWeight(module) {
        if (!module) return 3;

        const cached = parseFloat(module.dataset.uw54DeepWeight || "");
        if (Number.isFinite(cached) && cached > 0) {
            return cached;
        }

        /*
          Deliberately avoid getBoundingClientRect()/scrollHeight here. Those
          values are precisely what change depending on Steam's lazy-load
          timing. Use only stable content structure/text.
        */
        const t = text(module).replace(/\s+/g, " ").toLowerCase();
        const appLinks = module.querySelectorAll('a[href*="/app/"]').length;
        const images = module.querySelectorAll("img").length;

        let weight = 3;

        if (
            /since you (wish|recently played)/i.test(t) ||
            (
                /view product page/i.test(t) &&
                /find more like this/i.test(t)
            )
        ) {
            /* Large single-game recommendation card. */
            weight = 6;
        } else if (
            /games due to your recent playtime in other .* games/i.test(t) ||
            appLinks >= 5 ||
            images >= 7
        ) {
            /* Dense horizontal shelf: visually shorter than feature cards. */
            weight = 2;
        } else if (appLinks <= 2 && images >= 3) {
            weight = 5;
        } else if (appLinks >= 3) {
            weight = 3;
        }

        module.dataset.uw54DeepWeight = String(weight);
        return weight;
    }

    function uw54DeepLoadMap() {
        const ls = lanes();
        const loads = new Map(ls.map(lane => [lane, 0]));

        for (const lane of ls) {
            for (const slot of lane.children) {
                if (!slot.classList?.contains("uw27-module-slot")) continue;
                if (slot.dataset.uw29PinnedLane) continue;

                const module = slot.querySelector(
                    ":scope > .uw26-deep-module"
                );

                if (!module) continue;
                loads.set(lane, (loads.get(lane) || 0) + uw54DeepWeight(module));
            }
        }

        return loads;
    }

    function uw54ChooseDeepLane(loadMap = null) {
        const ls = lanes();
        if (!ls.length) return null;

        const loads = loadMap || uw54DeepLoadMap();
        let minimum = Number.POSITIVE_INFINITY;

        for (const lane of ls) {
            minimum = Math.min(minimum, loads.get(lane) || 0);
        }

        const tied = ls.filter(lane =>
            Math.abs((loads.get(lane) || 0) - minimum) < 0.001
        );

        if (!tied.length) return ls[0];

        const lane = tied[uw54DeepTieCursor % tied.length];
        uw54DeepTieCursor = (uw54DeepTieCursor + 1) % 1000000;
        return lane;
    }

    function uw54LockedDeepLane(module) {
        if (!module) return null;
        const id = module.dataset.uw54DeepLane;
        return id ? document.getElementById(id) : null;
    }

    function uw60TopGapFiller(module) {
        if (!module || module.classList?.contains("uw26-deep-module")) {
            return false;
        }

        if (module.dataset?.uw60GapFiller === "true") {
            return true;
        }

        const t = text(module)
            .replace(/\s+/g, " ")
            .slice(0, 1400);

        return (
            /recommended based on the games you play/i.test(t) ||
            /because you played\b/i.test(t) ||
            /your wishlist\b/i.test(t) ||
            /dlc for your games\b/i.test(t) ||
            /recently updated\b/i.test(t) ||
            /curator recommendations\b/i.test(t) ||
            /top played on steam deck\b/i.test(t) ||
            /under \$\d+/i.test(t)
        );
    }

    function uw60ShortestLaneFromHeights(ls, heights) {
        if (!ls.length) return null;

        let best = ls[0];
        let bestHeight = heights.get(best) || 0;

        for (let i = 1; i < ls.length; i++) {
            const candidate = ls[i];
            const h = heights.get(candidate) || 0;

            if (h < bestHeight - 1) {
                best = candidate;
                bestHeight = h;
            }
        }

        return best;
    }

    function chooseStructuredLane(
        module,
        heightMap = null,
        countMap = null
    ) {
        const ls = lanes();

        if (ls.length < 3) {
            return ls[0] || null;
        }

        const left = ls[0];
        const middle = ls[1];
        const right = ls[2];

        const heights =
            heightMap ||
            laneMetricHeights();

        const hLeft =
            heights.get(left) || 0;

        const hMiddle =
            heights.get(middle) || 0;

        const hRight =
            heights.get(right) || 0;

        /*
          Protected named modules never enter the normal lane heuristics.
        */
        const priority =
            priorityType(module);

        if (priority === "discounts") {
            return left;
        }

        if (
            priority === "browse" ||
            priority === "community"
        ) {
            return middle;
        }

        if (priority === "releases") {
            return right;
        }

        /*
          V60: these are the small/medium pre-feed shelves whose job is now
          also to close the unequal pinned-lane runway. Use the effective
          height map directly instead of preserving an old lane personality.
          Deep #content_more cards never enter this path.
        */
        if (uw60TopGapFiller(module)) {
            return uw60ShortestLaneFromHeights(ls, heights);
        }

        const kind =
            moduleKind(module);

        /*
          V53: once a module comes from Steam's long/deep recommendation stream,
          stop applying the early-page "lane personality" rules. Those rules
          were useful near the top, but on a very long page they could starve
          the left/right lanes while the middle lane kept growing. Deep modules
          simply fill the shortest FEED lane (pinned headers are ignored).
        */
        if (module.classList.contains("uw26-deep-module")) {
            return (
                uw54LockedDeepLane(module) ||
                uw54ChooseDeepLane()
            );
        }

        /*
          FEATURE:
          Keep large product recommendation cards out of the left discovery
          rail. Alternate middle/right when they are close in height, but
          still correct a meaningful imbalance.
        */
        if (kind === "feature") {
            /*
              V39 starvation recovery:
              V32 intentionally kept feature cards out of the left discovery
              rail. Deep in a long page that can leave the entire left third
              empty because the remaining Steam feed is mostly feature cards.

              Only break that rule when LEFT is more than ~900px behind BOTH
              recommendation lanes.
            */
            if (
                hLeft + 900 <
                Math.min(
                    hMiddle,
                    hRight
                )
            ) {
                return left;
            }

            const difference =
                Math.abs(
                    hMiddle -
                    hRight
                );

            let lane;

            if (difference > 240) {
                lane =
                    hMiddle <= hRight
                        ? middle
                        : right;
            } else {
                lane =
                    nextFeatureSide === 1
                        ? middle
                        : right;

                nextFeatureSide =
                    nextFeatureSide === 1
                        ? 2
                        : 1;
            }

            return lane;
        }

        /*
          COMPACT is now split in two.

          UNIFORM SHELF:
          belongs to LEFT unless that rail is dramatically overloaded.

          IRREGULAR COMPACT:
          1-3 giant cards, unusually tiny strips, odd aspect ratios, etc.
          These were what made the left lane feel random in V30, so they use
          the recommendation lanes instead.
        */
        if (kind === "compact") {
            if (
                isUniformLeftShelf(
                    module
                )
            ) {
                const shortestOther =
                    Math.min(
                        hMiddle,
                        hRight
                    );

                if (
                    hLeft >
                    shortestOther + 760
                ) {
                    return (
                        hMiddle <= hRight
                            ? middle
                            : right
                    );
                }

                return left;
            }

            /*
              Irregular compact modules normally stay out of the left rail,
              but they can also rescue a badly starved left column.
            */
            if (
                hLeft + 650 <
                Math.min(
                    hMiddle,
                    hRight
                )
            ) {
                return left;
            }

            return (
                hMiddle <= hRight
                    ? middle
                    : right
            );
        }

        /*
          STANDARD / MEDIUM:
          Use normal height balancing. These are the glue that fills the
          occasional natural hole without destroying lane identity.
        */
        let best = left;

        if (
            hMiddle <
            (heights.get(best) || 0)
        ) {
            best = middle;
        }

        if (
            hRight <
            (heights.get(best) || 0)
        ) {
            best = right;
        }

        return best;
    }

    function moduleSlot(module) {
        return (
            module &&
            moduleSlots.get(module)
        ) || null;
    }

    function markPinned(
        module,
        lane,
        order = 100
    ) {
        const slot =
            moduleSlot(module);

        if (
            !module ||
            !slot ||
            !lane
        ) {
            return;
        }

        module.dataset.uw29PinnedLane =
            lane.id;

        module.dataset.uw31PinnedOrder =
            String(order);

        slot.dataset.uw29PinnedLane =
            lane.id;

        slot.dataset.uw31PinnedOrder =
            String(order);

        if (
            lane.id ===
            "uw25-lane-middle"
        ) {
            slot.classList.add(
                "uw31-middle-priority"
            );
        }
    }

    function slotHeight(slot) {
        if (!slot) return 0;

        const r =
            slot.getBoundingClientRect();

        return Math.max(
            1,
            r.height,
            slot.scrollHeight || 0
        );
    }

    function laneGap(lane) {
        if (!lane) return 22;

        const s =
            getComputedStyle(lane);

        return (
            parseFloat(s.rowGap) ||
            parseFloat(s.gap) ||
            22
        );
    }

    function uw59PinnedLaneBaseline(lane) {
        if (!lane) return 0;

        let total = 0;
        let count = 0;
        const gap = laneGap(lane);

        for (const child of lane.children) {
            const pinned =
                child.dataset?.uw29PinnedLane ||
                child.id === "uw50-top-left-slot";

            if (!pinned) continue;

            if (count > 0) total += gap;
            total += slotHeight(child);
            count++;
        }

        return total;
    }

    function uw59ReflowBaselineOffsets(ls) {
        const raw = new Map();

        for (const lane of ls) {
            raw.set(lane, uw59PinnedLaneBaseline(lane));
        }

        const finite = Array.from(raw.values()).filter(Number.isFinite);
        const minimum = finite.length ? Math.min(...finite) : 0;
        const result = new Map();

        for (const lane of ls) {
            /*
              Count only the DIFFERENCE between pinned header stacks.  This
              lets movable pre-feed modules fill the shorter left/middle
              columns before adding more below the tall Releases rail, while
              capping the correction so an unusually tall Valve module can
              never starve a lane indefinitely.
            */
            result.set(
                lane,
                Math.min(1100, Math.max(0, (raw.get(lane) || 0) - minimum))
            );
        }

        return result;
    }

    function visibleAnchorSlot() {
        const slots =
            Array.from(
                document.querySelectorAll(
                    ".uw27-module-slot"
                )
            );

        if (!slots.length) {
            return null;
        }

        const targetY =
            Math.min(
                180,
                window.innerHeight * 0.2
            );

        let best = null;
        let bestDistance =
            Number.POSITIVE_INFINITY;

        for (const slot of slots) {
            const r =
                slot.getBoundingClientRect();

            if (
                r.bottom <= 0 ||
                r.top >= window.innerHeight
            ) {
                continue;
            }

            /*
              Prefer the slot crossing our anchor line, otherwise choose the
              visible slot whose top is closest to it.
            */
            const distance =
                (
                    r.top <= targetY &&
                    r.bottom >= targetY
                )
                    ? 0
                    : Math.abs(
                        r.top - targetY
                    );

            if (
                distance <
                bestDistance
            ) {
                best = slot;
                bestDistance =
                    distance;
            }
        }

        return best;
    }

    function reflowWaterfall() {
        reflowRAF = 0;

        if (
            reflowing ||
            applying ||
            sweeping
        ) {
            return;
        }

        const ls = lanes();

        if (ls.length < 3) {
            return;
        }

        const slots =
            Array.from(
                document.querySelectorAll(
                    ".uw27-module-slot"
                )
            );

        if (!slots.length) {
            return;
        }

        reflowing = true;

        const anchor =
            visibleAnchorSlot();

        const anchorBefore =
            anchor
                ? anchor
                    .getBoundingClientRect()
                    .top
                : null;

        try {
            const laneById =
                new Map(
                    ls.map(lane => [
                        lane.id,
                        lane
                    ])
                );

            const pinned =
                slots.filter(slot =>
                    !!slot.dataset
                        .uw29PinnedLane
                );

            /*
              V30 only pinned a module to a LANE, not to a POSITION inside
              that lane. If Browse was discovered late, it stayed far down.

              V31 gives pinned modules explicit order and physically rebuilds
              each lane's pinned header stack at the top.
            */
            for (const lane of ls) {
                const lanePinned =
                    pinned
                        .filter(slot =>
                            slot.dataset
                                .uw29PinnedLane ===
                            lane.id
                        )
                        .sort((a, b) =>
                            (
                                parseInt(
                                    a.dataset
                                        .uw31PinnedOrder ||
                                        "100",
                                    10
                                ) -
                                parseInt(
                                    b.dataset
                                        .uw31PinnedOrder ||
                                        "100",
                                    10
                                )
                            )
                        );

                /*
                  Moving in sorted sequence before the first non-pinned child
                  guarantees deterministic top ordering even when a module
                  lazy-loads much later.
                */
                let cursor = lane.firstElementChild;

                for (const slot of lanePinned) {
                    if (slot !== cursor) {
                        lane.insertBefore(slot, cursor);
                    }

                    cursor = slot.nextElementSibling;

                    const module =
                        slot.querySelector(
                            ":scope > .uw25-home-module"
                        );

                    if (module) {
                        updateSlotPresentation(
                            slot,
                            module,
                            lane
                        );
                    }
                }
            }

            /*
              V53: balance the continuing feed independently of the unequal
              pinned header stacks. The right Releases panel can be much taller
              than Calendar/Discounts; counting that height here starved the
              right lane for thousands of pixels. Pinned modules stay fixed at
              the top, while movable content gets an equal three-lane budget.
            */
            const heights = uw59ReflowBaselineOffsets(ls);
            const counts = new Map();
            const deepLoads = uw54DeepLoadMap();

            for (const lane of ls) {
                /* Every lane already has a pinned header stack, so the first
                   movable module also needs the normal inter-module gap. */
                counts.set(lane, 1);
            }

            const movable =
                slots.filter(slot =>
                    !slot.dataset
                        .uw29PinnedLane
                );

            movable.sort((a, b) => {
                const am =
                    a.querySelector(
                        ":scope > .uw25-home-module"
                    );

                const bm =
                    b.querySelector(
                        ":scope > .uw25-home-module"
                    );

                const ao =
                    parseInt(
                        am?.dataset
                            .uw29Order || "0",
                        10
                    );

                const bo =
                    parseInt(
                        bm?.dataset
                            .uw29Order || "0",
                        10
                    );

                return ao - bo;
            });

            /*
              Rebuild visual rhythm deterministically from original module
              order. The classification rules determine lane personality;
              height only breaks ties / prevents extreme imbalance.
            */
            nextFeatureSide = 1;

            for (const slot of movable) {
                const module =
                    slot.querySelector(
                        ":scope > .uw25-home-module"
                    );

                if (!module) {
                    continue;
                }

                let lane;

                if (module.classList.contains("uw26-deep-module")) {
                    lane = uw54LockedDeepLane(module);

                    if (!lane) {
                        lane = uw54ChooseDeepLane(deepLoads);
                        if (lane) {
                            module.dataset.uw54DeepLane = lane.id;
                            deepLoads.set(
                                lane,
                                (deepLoads.get(lane) || 0) + uw54DeepWeight(module)
                            );
                        }
                    }
                } else {
                    lane = chooseStructuredLane(
                        module,
                        heights,
                        counts
                    );
                }

                if (!lane) {
                    continue;
                }

                if (
                    slot.parentElement !== lane
                ) {
                    lane.appendChild(slot);
                }

                updateSlotPresentation(
                    slot,
                    module,
                    lane
                );

                let h =
                    heights.get(lane) || 0;

                if (
                    (counts.get(lane) || 0) > 0
                ) {
                    h += laneGap(lane);
                }

                h += slotHeight(slot);

                heights.set(
                    lane,
                    h
                );

                counts.set(
                    lane,
                    (counts.get(lane) || 0) + 1
                );
            }
        } finally {
            /*
              Pinned slots are prepended during reflow. Calendar is purposely
              not a slot, so reassert its true order-1 position afterwards.
            */
            uw47KeepCalendarTop();
            reflowing = false;
        }

        if (
            anchor &&
            anchorBefore !== null &&
            anchor.isConnected
        ) {
            const anchorAfter =
                anchor
                    .getBoundingClientRect()
                    .top;

            const delta =
                anchorAfter -
                anchorBefore;

            if (
                Math.abs(delta) > 0.5
            ) {
                window.scrollBy(
                    0,
                    delta
                );
            }
        }
    }

    let uw30ReflowTimer = 0;

    function scheduleReflow() {
        if (uw30ReflowTimer) {
            clearTimeout(
                uw30ReflowTimer
            );
        }

        /*
          Let a lazy-loaded batch settle before making one deterministic
          layout pass. This prevents the "everything keeps moving" feeling.
        */
        uw30ReflowTimer =
            window.setTimeout(
                () => {
                    uw30ReflowTimer = 0;

                    /*
                      V53 PERFORMANCE: never refit every module just because a
                      new Steam batch arrived. ResizeObserver already tracks the
                      changed modules. Reflow only the lane slots themselves.
                    */
                    requestAnimationFrame(
                        reflowWaterfall
                    );
                },
                320
            );
    }


    function markVacated(parent) {
        if (
            !parent ||
            isMajorRoot(parent) ||
            uw51DeepFeedHosts.has(parent) ||
            uw56NativeFeedHosts.has(parent) ||
            parent.classList?.contains("uw56-native-feed-stage") ||
            parent.id === WATERFALL_ID ||
            parent.classList.contains("uw25-lane")
        ) {
            return;
        }

        const visibleChildren =
            Array.from(parent.children)
                .filter(el =>
                    el.id !== WATERFALL_ID &&
                    isVisible(el)
                );

        if (!visibleChildren.length) {
            parent.classList.add(
                "uw25-home-vacated"
            );
        }
    }

    function ensureModuleSlot(
        module,
        lane
    ) {
        let slot =
            moduleSlots.get(module);

        if (
            slot &&
            slot.isConnected
        ) {
            return slot;
        }

        slot =
            document.createElement(
                "div"
            );

        slot.className =
            "uw27-module-slot";

        lane.appendChild(slot);

        moduleSlots.set(
            module,
            slot
        );

        return slot;
    }

    function fitOneModule(module) {
        if (
            !module ||
            !module.isConnected
        ) {
            return;
        }

        const slot =
            moduleSlots.get(module);

        if (
            !slot ||
            !slot.isConnected
        ) {
            return;
        }

        /*
          V28: the full Releases / Top Sellers module was being shrunk to a
          postage stamp because its internal detail preview contributes to
          scrollWidth. Never apply generic transform fitting to it.
        */
        if (
            module.classList.contains(
                "uw25-releases-module"
            ) ||
            module.classList.contains(
                "uw32-genre-module"
            ) ||
            module.classList.contains(
                "uw32-protected-module"
            )
        ) {
            slot.classList.remove(
                "uw27-fitted"
            );

            slot.style.removeProperty(
                "height"
            );

            module.style.removeProperty(
                "width"
            );

            module.style.removeProperty(
                "transform"
            );

            module.style.removeProperty(
                "position"
            );

            module.style.removeProperty(
                "top"
            );

            module.style.removeProperty(
                "left"
            );

            return;
        }

        const targetWidth =
            Math.max(
                1,
                slot.clientWidth
            );

        /*
          If already fitted, keep the native width stored on the module.
          Otherwise measure horizontal overflow in its current lane.
        */
        let naturalWidth =
            parseFloat(
                module.dataset
                    .uw27NaturalWidth || "0"
            );

        if (!naturalWidth) {
            const original =
                parseFloat(
                    module.dataset
                        .uw27OriginalWidth || "0"
                );

            naturalWidth =
                Math.max(
                    original,
                    module.scrollWidth || 0,
                    module.offsetWidth || 0
                );
        }

        /*
          Only scale genuinely overflowing modules. A 3% tolerance prevents
          tiny shadows/controls from causing needless scaling.
        */
        const needsFit =
            naturalWidth >
            targetWidth * 1.12;

        if (!needsFit) {
            slot.classList.remove(
                "uw27-fitted"
            );

            slot.style.removeProperty(
                "height"
            );

            module.style.removeProperty(
                "width"
            );

            module.style.removeProperty(
                "transform"
            );

            module.style.removeProperty(
                "position"
            );

            module.style.removeProperty(
                "top"
            );

            module.style.removeProperty(
                "left"
            );

            return;
        }

        module.dataset.uw27NaturalWidth =
            String(naturalWidth);

        /*
          Preserve Steam's native internal layout, then scale the complete
          interactive module to fit the lane.
        */
        module.style.setProperty(
            "width",
            `${naturalWidth}px`,
            "important"
        );

        const scale =
            Math.min(
                1,
                targetWidth /
                naturalWidth
            );

        module.style.setProperty(
            "transform",
            `scale(${scale})`,
            "important"
        );

        slot.classList.add(
            "uw27-fitted"
        );

        /*
          Transforms do not change normal layout height. offsetHeight is the
          unscaled/native height, which is what we need here.
        */
        const naturalHeight =
            Math.max(
                1,
                module.offsetHeight ||
                module.scrollHeight ||
                module.getBoundingClientRect()
                    .height
            );

        slot.style.setProperty(
            "height",
            `${Math.ceil(
                naturalHeight * scale
            )}px`
        );
    }

    function fitDirtyModules() {
        dirtyFitRAF = 0;

        if (fitting || !dirtyFitModules.size) return;

        const pending = Array.from(dirtyFitModules);
        dirtyFitModules.clear();

        fitting = true;

        try {
            for (const module of pending) {
                if (
                    module &&
                    module.isConnected &&
                    module.classList?.contains("uw25-home-module")
                ) {
                    fitOneModule(module);
                }
            }
        } finally {
            fitting = false;
        }
    }

    function scheduleFitModules(modules) {
        for (const module of modules || []) {
            if (module) dirtyFitModules.add(module);
        }

        if (dirtyFitRAF || !dirtyFitModules.size) return;

        dirtyFitRAF = requestAnimationFrame(fitDirtyModules);
    }

    function fitAllModules() {
        fitRAF = 0;

        if (fitting) return;

        fitting = true;

        try {
            document.querySelectorAll(
                ".uw27-module-slot > .uw25-home-module"
            ).forEach(module => {
                fitOneModule(module);
            });
        } finally {
            fitting = false;
        }
    }

    function scheduleFitAll() {
        if (fitRAF) return;

        fitRAF =
            requestAnimationFrame(
                fitAllModules
            );
    }

    function uw51StructuralFeedHost(el) {
        if (!el) return false;

        if (
            el.matches?.(
                ".main_content_ctn, " +
                ".home_page_body_ctn, " +
                "[class*='infinite_scroll'], " +
                "[class*='InfiniteScroll'], " +
                "[id*='infinite_scroll'], " +
                "[id*='InfiniteScroll']"
            )
        ) {
            return true;
        }

        const name = `${el.id || ""} ${el.className || ""}`.toLowerCase();

        return (
            /(?:^|[\s_-])infinite(?:[\s_-]|$)/.test(name) &&
            /scroll|feed|home|content/.test(name)
        );
    }

    function uw51RememberDeepSource(module, oldParent) {
        if (
            !module ||
            !oldParent ||
            oldParent.closest?.(`#${WATERFALL_ID}`) ||
            uw51DeepSource.has(module)
        ) {
            return;
        }

        const marker = document.createComment("uw51-deep-source");
        oldParent.insertBefore(marker, module);

        uw51DeepSource.set(module, {
            parent: oldParent,
            marker
        });
    }

    function uw51ChunkCandidates(host) {
        if (!host) return [];

        const hr = host.getBoundingClientRect();
        const minWidth = Math.max(300, hr.width * 0.52);
        const maxLeafHeight = Math.max(2200, window.innerHeight * 1.45);
        const result = [];

        function walk(parent, depth = 0) {
            if (!parent || depth > 7) return;

            const kids = Array.from(parent.children).filter(el => {
                if (!(el instanceof HTMLElement)) return false;
                if (isFooterish(el) || isMajorRoot(el)) return false;
                if (el.id === WATERFALL_ID || el.classList.contains("uw25-lane")) return false;

                const r = el.getBoundingClientRect();
                return r.width >= minWidth && r.height >= 65;
            });

            if (!kids.length) return;

            const meaningful = kids.filter(el => moduleSignal(el) >= 2);

            /*
              Two or more substantial siblings is the signature we want: a
              stream wrapper containing multiple real recommendation modules.
            */
            if (meaningful.length >= 2) {
                for (const child of meaningful) {
                    const r = child.getBoundingClientRect();

                    if (r.height > maxLeafHeight) {
                        const before = result.length;
                        walk(child, depth + 1);
                        if (result.length === before && moduleSignal(child) >= 4) {
                            result.push(child);
                        }
                    } else {
                        result.push(child);
                    }
                }
                return;
            }

            /* One very tall wrapper usually just hides the next stream level. */
            if (meaningful.length === 1) {
                const only = meaningful[0];
                if (only.getBoundingClientRect().height > maxLeafHeight) {
                    walk(only, depth + 1);
                }
            }
        }

        walk(host);

        /* Remove nested duplicates; prefer the outer real section. */
        const unique = [];
        for (const candidate of result) {
            if (
                !candidate ||
                unique.some(existing => existing === candidate || existing.contains(candidate))
            ) {
                continue;
            }

            for (let i = unique.length - 1; i >= 0; i--) {
                if (candidate.contains(unique[i])) unique.splice(i, 1);
            }
            unique.push(candidate);
        }

        return unique;
    }

    function uw51RestoreAggregateHost(module) {
        const source = uw51DeepSource.get(module);
        const slot = moduleSlots.get(module);

        if (!source || !source.parent || !source.parent.isConnected) {
            return false;
        }

        source.parent.classList.remove("uw25-home-vacated");

        if (source.marker && source.marker.parentNode === source.parent) {
            source.parent.insertBefore(module, source.marker);
            source.marker.remove();
        } else {
            source.parent.appendChild(module);
        }

        if (slot && slot.isConnected) slot.remove();
        moduleSlots.delete(module);

        if (resizeObserver) {
            try { resizeObserver.unobserve(module); } catch (_) {}
        }

        module.classList.remove(
            "uw25-home-module",
            "uw26-deep-module",
            "uw30-kind-feature",
            "uw30-kind-compact",
            "uw30-kind-standard",
            "uw32-genre-module"
        );
        module.style.removeProperty("transform");
        module.style.removeProperty("position");
        module.style.removeProperty("width");
        module.style.removeProperty("max-width");
        module.style.removeProperty("min-width");
        module.style.removeProperty("height");

        delete module.dataset.uw30Kind;
        delete module.dataset.uw27OriginalWidth;
        delete module.dataset.uw29Order;
        delete module.dataset.uw54DeepLane;
        delete module.dataset.uw54DeepWeight;

        uw51DeepFeedHosts.add(module);
        module.dataset.uw51FeedHost = "true";

        return true;
    }

    function uw51RescueOversizedDeepModules() {
        uw51RescueRAF = 0;

        if (!uw53AggregateSuspect) return false;
        if (applying || sweeping || reflowing) return false;

        const threshold = Math.max(3400, window.innerHeight * 2.15);
        const slots = Array.from(document.querySelectorAll(
            `#${WATERFALL_ID} .uw27-module-slot`
        ));

        for (const slot of slots) {
            const module = slot.querySelector(":scope > .uw25-home-module");
            if (!module) continue;

            /* Fixed/pinned modules can legitimately be complex. */
            if (
                module.classList.contains("uw32-protected-module") ||
                slot.dataset.uw29PinnedLane
            ) {
                continue;
            }

            const h = Math.max(
                slot.getBoundingClientRect().height,
                slot.scrollHeight || 0,
                module.getBoundingClientRect().height,
                module.scrollHeight || 0
            );

            const aggregate = uw55AggregateFeedHost(module);
            const oversizedDeep =
                module.classList.contains("uw26-deep-module") &&
                h >= threshold;

            if (!aggregate && !oversizedDeep) continue;

            const chunks = uw51ChunkCandidates(module);
            if (chunks.length < 2) continue;

            if (!uw51RestoreAggregateHost(module)) continue;

            /* Harvest only the real child sections; leave the dynamic host in
               Steam's source DOM so future lazy-loaded children still arrive. */
            const moved = [];
            const heights = uw54DeepLoadMap();

            for (const chunk of chunks) {
                if (
                    !chunk.isConnected ||
                    chunk.closest(`#${WATERFALL_ID}`) ||
                    isFooterish(chunk) ||
                    uw39IsUtilityRelated(chunk)
                ) {
                    continue;
                }

                chunk.classList.add("uw26-deep-module");
                const lane = uw54ChooseDeepLane(heights);
                if (lane) {
                    chunk.dataset.uw54DeepLane = lane.id;
                }
                const before = lastPlacedCount;

                moveModule(
                    chunk,
                    lane,
                    "uw26-deep-module",
                    false,
                    true
                );

                if (lastPlacedCount > before) {
                    deepPlacedModules.add(chunk);
                    moved.push(chunk);
                    heights.set(
                        lane,
                        (heights.get(lane) || 0) + uw54DeepWeight(chunk)
                    );
                } else {
                    chunk.classList.remove("uw26-deep-module");
                }
            }

            uw53AggregateSuspect = false;
            scheduleFitModules(moved);
            return true;
        }

        uw53AggregateSuspect = false;
        return false;
    }

    function uw51ScheduleAggregateRescue() {
        if (!uw53AggregateSuspect || uw51RescueRAF) return;

        /*
          V52 PERFORMANCE: aggregate-host rescue is expensive because it has
          to measure every deep slot. It does not need to run once per scroll
          frame or once per image resize. Debounce it and let image/layout
          activity settle first.
        */
        uw51RescueRAF = window.setTimeout(() => {
            uw51RescueRAF = 0;

            const run = () =>
                uw51RescueOversizedDeepModules();

            if (typeof requestIdleCallback === "function") {
                requestIdleCallback(run, { timeout: 500 });
            } else {
                requestAnimationFrame(run);
            }
        }, 900);
    }

    function moveModule(
        module,
        lane,
        extraClass = null,
        allowUnready = false,
        deferLayout = false
    ) {
        /* V55: a live aggregate feed host must stay in Valve's native DOM.
           Its CHILD sections are what belong in the waterfall. */
        if (
            module &&
            uw55AggregateFeedHost(module) &&
            !module.classList?.contains("uw32-protected-module")
        ) {
            uw51DeepFeedHosts.add(module);
            module.dataset.uw55FeedHost = "true";
            return;
        }

        if (
            !module ||
            !lane ||
            placedModules.has(module) ||
            module === lane ||
            module.id === WATERFALL_ID ||
            module.classList?.contains("uw25-lane") ||
            module.classList?.contains("uw27-module-slot") ||
            module.closest?.(".uw56-native-feed-stage") ||
            module.contains?.(lane) ||
            lane.contains?.(module) ||
            (extraClass === "uw26-deep-module" &&
                (uw51DeepFeedHosts.has(module) || uw51StructuralFeedHost(module)))
        ) {
            return;
        }

        /*
          Do not relocate an empty lazy-loaded shell. Steam is much more
          reliable about populating it while it remains in its stock DOM.
        */
        if (
            !allowUnready &&
            !moduleLooksReady(module)
        ) {
            return;
        }

        const oldParent =
            module.parentElement;

        /* V55 remembers the native source for every moved module. This makes
           aggregate recovery possible even if a normal module later expands
           into a live Steam feed host after lazy content arrives. */
        uw51RememberDeepSource(module, oldParent);

        /*
          If a named priority section somehow reaches moveModule through a
          late recovery path, protect it immediately.
        */
        const pType =
            priorityType(module);

        if (pType) {
            protectSpecial(
                module,
                pType
            );
        }

        /*
          Capture its native page width BEFORE moving it. This lets V27
          restore/scale fixed-width recommendation cards accurately.
        */
        const originalWidth =
            Math.max(
                1,
                module.getBoundingClientRect()
                    .width
            );

        module.dataset.uw27OriginalWidth =
            String(originalWidth);

        if (
            !module.dataset.uw29Order
        ) {
            module.dataset.uw29Order =
                String(
                    nextModuleOrder++
                );
        }

        module.classList.add(
            "uw25-home-module"
        );

        moduleKind(module);

        if (extraClass) {
            module.classList.add(
                extraClass
            );
        }

        if (extraClass === "uw26-deep-module") {
            module.dataset.uw54DeepLane = lane.id;
            uw54DeepWeight(module);
        }

        const slot =
            ensureModuleSlot(
                module,
                lane
            );

        slot.appendChild(module);

        updateSlotPresentation(
            slot,
            module,
            lane
        );

        placedModules.add(module);

        lastPlacedCount++;

        if (
            resizeObserver &&
            !observedModules.has(module)
        ) {
            observedModules.add(module);
            resizeObserver.observe(module);
        }

        markVacated(oldParent);

        /*
          V53 PERFORMANCE: fit only the module we just moved. A deep batch may
          contain many modules, so its caller can defer the single reflow until
          the whole batch has been placed.
        */
        scheduleFitModules([module]);

        if (!deferLayout) {
            scheduleReflow();
        }
    }

    /*
      Detect substantial lower-page modules not already covered by a known
      title. We only consider sections below the original Discounts area.
    */
    function discoverGenericModules() {
        const anchor =
            document.getElementById(
                WATERFALL_ID
            );

        if (!anchor) return [];

        const anchorY =
            anchor.getBoundingClientRect().top +
            window.scrollY;

        const known =
            new Set(
                knownHeadings()
            );

        const roots = [];

        for (
            const heading of
            headingCandidates()
        ) {
            if (
                known.has(heading) ||
                heading.closest(
                    `#${WATERFALL_ID}`
                )
            ) {
                continue;
            }

            const y =
                heading.getBoundingClientRect().top +
                window.scrollY;

            if (y < anchorY - 20) {
                continue;
            }

            let node = heading;
            let best = null;

            for (
                let i = 0;
                i < 7 &&
                node &&
                node.parentElement;
                i++
            ) {
                const p = node.parentElement;

                if (
                    isMajorRoot(p) ||
                    p.id === WATERFALL_ID ||
                    p.classList.contains("uw25-lane")
                ) {
                    break;
                }

                const r =
                    p.getBoundingClientRect();

                if (
                    r.width >= 300 &&
                    r.height >= 100 &&
                    r.height <= 1800
                ) {
                    const knownInside =
                        knownHeadings()
                            .filter(h =>
                                p.contains(h)
                            );

                    if (
                        knownInside.length <= 1
                    ) {
                        best = p;
                    }
                }

                node = p;
            }

            if (best) {
                roots.push(best);
            }
        }

        return roots;
    }

    function allCandidateModules() {
        /*
          Reserve exact utility modules before generic discovery gets a chance
          to classify them.
        */
        uw39ResolveAllUtilities();

        const all =
            knownHeadings();

        const modules = [];

        for (const heading of all) {
            /*
              The two fixed top modules are handled separately.
            */
            if (
                /^discounts?\s*&\s*events$/i.test(
                    text(heading)
                ) ||
                /^browse by category$/i.test(
                    text(heading)
                ) ||
                /^the community recommends$/i.test(
                    text(heading)
                ) ||
                /^(?:new\s+)?your personal calendar$/i.test(
                    text(heading)
                ) ||
                /^(?:explore )?your discovery queue$/i.test(
                    text(heading)
                ) ||
                /^from developers and publishers you know$/i.test(
                    text(heading)
                )
            ) {
                continue;
            }

            const root =
                sectionRootForHeading(
                    heading,
                    all
                );

            if (root) {
                modules.push(root);
            }
        }

        modules.push(
            ...discoverGenericModules()
        );

        /*
          Remove duplicates/nested roots and anything already managed.
        */
        const unique = [];

        for (const root of modules) {
            if (
                !root ||
                isPriorityRelated(root) ||
                uw39IsUtilityRelated(root) ||
                placedModules.has(root) ||
                root.closest(
                    `#${WATERFALL_ID}`
                ) ||
                root.closest?.(".uw56-native-feed-stage") ||
                uw55AggregateFeedHost(root)
            ) {
                /* Never move Valve's live feed wrapper as a single card. */
                if (uw55AggregateFeedHost(root)) {
                    uw51DeepFeedHosts.add(root);
                    root.dataset.uw55FeedHost = "true";
                }
                continue;
            }

            if (
                unique.some(existing =>
                    existing === root ||
                    existing.contains(root)
                )
            ) {
                continue;
            }

            for (
                let i = unique.length - 1;
                i >= 0;
                i--
            ) {
                if (
                    root.contains(
                        unique[i]
                    )
                ) {
                    unique.splice(i, 1);
                }
            }

            unique.push(root);
        }

        /*
          Keep Steam's original order for all non-fixed modules.
        */
        unique.sort((a, b) => {
            if (a === b) return 0;

            const pos =
                a.compareDocumentPosition(b);

            return (
                pos &
                Node.DOCUMENT_POSITION_FOLLOWING
            ) ? -1 : 1;
        });

        return unique;
    }


    /* ================================================================
       V26 - DEEP / GEOMETRY-BASED FEED DISCOVERY
       ================================================================ */

    function footerRoot() {
        return (
            document.querySelector("#footer") ||
            document.querySelector(".footer_content")?.parentElement ||
            null
        );
    }

    function isFooterish(el) {
        if (!el) return false;

        if (
            el.id === "footer" ||
            el.closest?.("#footer") ||
            /(?:^|\s)footer(?:\s|$)/i.test(
                String(el.className || "")
            )
        ) {
            return true;
        }

        const t = text(el).toLowerCase();

        return (
            t.includes("privacy policy") &&
            t.includes("legal") &&
            t.includes("steam")
        );
    }

    function uw57PositionFooterAfterFeed(host) {
        const footer = footerRoot();

        if (!host || !footer || !host.isConnected || !footer.isConnected) {
            return;
        }

        /*
          Keep Valve's footer in its original DOM position so Steam's own
          infinite-scroll code sees the structure it expects.  We only move
          its painted box with a transform and reserve equivalent space after
          the native feed.  This is much less invasive than reparenting it.
        */
        footer.classList.add("uw57-footer-visual-bottom");

        let flowTop = parseFloat(footer.dataset.uw57FlowTop || "");
        if (!Number.isFinite(flowTop)) {
            const currentTransform = footer.style.getPropertyValue("transform");
            const currentPriority = footer.style.getPropertyPriority("transform");

            footer.style.removeProperty("transform");
            flowTop = footer.getBoundingClientRect().top + window.scrollY;
            footer.dataset.uw57FlowTop = String(flowTop);

            if (currentTransform) {
                footer.style.setProperty("transform", currentTransform, currentPriority || "");
            }
        }

        const hostRect = host.getBoundingClientRect();
        const hostBottom = hostRect.bottom + window.scrollY;
        const footerHeight = Math.max(
            1,
            footer.offsetHeight || 0,
            footer.getBoundingClientRect().height || 0
        );

        const gap = Math.max(30, uw56FeedGap());
        const targetTop = hostBottom + gap;
        const shift = Math.max(0, targetTop - flowTop);

        footer.style.setProperty(
            "transform",
            `translate3d(0, ${Math.round(shift)}px, 0)`,
            "important"
        );

        /*
          A transform does not contribute to document height.  Reserve enough
          real flow space on the feed host so the translated footer remains
          scrollable/clickable at the true end of the page.
        */
        host.style.setProperty(
            "margin-bottom",
            `${Math.ceil(footerHeight + gap * 2)}px`,
            "important"
        );
    }


    function moveFooterAfterWaterfall() {
        /*
          V27 intentionally leaves Steam's footer exactly where Valve put it.

          In V26, physically relocating the footer appears to have interfered
          with the long recommendation-feed / lazy-loading sequence and made
          the page end much sooner than stock Steam.
        */
    }

    function absoluteTop(el) {
        return (
            el.getBoundingClientRect().top +
            window.scrollY
        );
    }

    function outsideWaterfall(el) {
        return (
            el &&
            !el.closest(
                `#${WATERFALL_ID}`
            )
        );
    }

    function moduleSignal(el) {
        if (!el) return 0;

        let score = 0;
        const cls =
            String(el.className || "")
                .toLowerCase();

        const id =
            String(el.id || "")
                .toLowerCase();

        const combined =
            `${cls} ${id}`;

        if (
            /home|cluster|carousel|recommend|discovery|wishlist|curator|content|category|sale|store/.test(
                combined
            )
        ) {
            score += 3;
        }

        if (
            el.querySelector(
                "h1, h2, h3, h4"
            )
        ) {
            score += 2;
        }

        const appLinks =
            el.querySelectorAll(
                'a[href*="/app/"]'
            ).length;

        if (appLinks >= 2) {
            score += 3;
        } else if (appLinks === 1) {
            score += 1;
        }

        if (
            el.querySelector(
                "img, video"
            )
        ) {
            score += 1;
        }

        return score;
    }

    /*
      Does a node look like ONE of Steam's stock narrow recommendation/feed
      modules?

      On a 32:9 screen those modules still retain roughly their normal
      ~940px CSS width, centered in the enormous webview.
    */
    function looksLikeNarrowFeedBlock(el) {
        if (
            !el ||
            !outsideWaterfall(el) ||
            uw51DeepFeedHosts.has(el) ||
            uw51StructuralFeedHost(el) ||
            uw55AggregateFeedHost(el) ||
            isFooterish(el) ||
            isMajorRoot(el) ||
            isPriorityRelated(el) ||
            uw39IsUtilityRelated(el)
        ) {
            return false;
        }

        const r =
            el.getBoundingClientRect();

        if (
            r.width < 620 ||
            r.width > 1500 ||
            r.height < 70 ||
            r.height > 1800
        ) {
            return false;
        }

        /*
          Steam's untouched recommendation feed is normally centered.
          Use a generous center tolerance because the current refreshed
          homepage occasionally offsets content a little.
        */
        const center =
            r.left + r.width / 2;

        const centerTolerance =
            Math.max(
                320,
                window.innerWidth * 0.11
            );

        if (
            Math.abs(
                center -
                window.innerWidth / 2
            ) > centerTolerance
        ) {
            return false;
        }

        /*
          Deep-feed modules must contain some actual Store content.
        */
        if (moduleSignal(el) < 3) {
            return false;
        }

        return true;
    }

    /*
      A narrow STREAM wrapper can contain many vertically stacked modules.
      Split it into substantial full-width children instead of moving the
      entire stream into one lane.
    */
    function splitNarrowStream(stream) {
        if (!stream) return [];

        const sr =
            stream.getBoundingClientRect();

        const chunks = [];

        function walk(parent, depth = 0) {
            if (
                depth > 4 ||
                !parent
            ) {
                return;
            }

            const children =
                Array.from(
                    parent.children
                ).filter(el =>
                    el instanceof HTMLElement &&
                    outsideWaterfall(el) &&
                    !isFooterish(el)
                );

            const substantial =
                children.filter(el => {
                    const r =
                        el.getBoundingClientRect();

                    return (
                        r.width >=
                            sr.width * 0.72 &&
                        r.height >= 65
                    );
                });

            /*
              If this wrapper clearly contains multiple stacked substantial
              blocks, descend and treat those blocks as the real modules.
            */
            if (substantial.length >= 2) {
                for (
                    const child of
                    substantial
                ) {
                    const cr =
                        child.getBoundingClientRect();

                    /*
                      Very tall child probably contains several modules too.
                    */
                    if (
                        cr.height >
                            window.innerHeight * 1.35
                    ) {
                        const before =
                            chunks.length;

                        walk(
                            child,
                            depth + 1
                        );

                        if (
                            chunks.length ===
                            before &&
                            looksLikeNarrowFeedBlock(
                                child
                            )
                        ) {
                            chunks.push(
                                child
                            );
                        }
                    } else if (
                        moduleSignal(child) >= 2
                    ) {
                        chunks.push(
                            child
                        );
                    }
                }

                return;
            }

            if (
                looksLikeNarrowFeedBlock(
                    parent
                )
            ) {
                chunks.push(parent);
            }
        }

        walk(stream);

        return chunks;
    }

    function deepCandidatesNearViewport() {
        const shell =
            document.getElementById(
                WATERFALL_ID
            );

        if (!shell) return [];

        const shellTop =
            absoluteTop(shell);

        /*
          Broad source set, then geometry does the real filtering.
        */
        const elements =
            Array.from(
                document.querySelectorAll(
                    "main, section, article, div"
                )
            );

        const streams = [];

        for (const el of elements) {
            if (el.closest?.(".uw56-native-feed-stage")) {
                continue;
            }

            const aggregateStream = uw55NativeAggregateStream(el);

            /* V56: preserve Valve's live stream DOM completely. The host is
               widened and visually masonry-laid out in place; none of its
               children become waterfall modules. */
            if (aggregateStream) {
                uw56PrepareNativeFeedHost(el);
                continue;
            }

            const narrowStream = looksLikeNarrowFeedBlock(el);

            if (!narrowStream) {
                continue;
            }

            if (
                absoluteTop(el) <
                shellTop - 20
            ) {
                continue;
            }

            /* Prefer the outermost live stream. Unlike V54, aggregate hosts
               are allowed to be very tall; splitNarrowStream() will harvest
               their child sections without moving the host itself. */
            const parent = el.parentElement;
            if (parent && looksLikeNarrowFeedBlock(parent)) {
                continue;
            }

            streams.push(el);
        }

        const chunks = [];

        for (const stream of streams) {
            chunks.push(
                ...splitNarrowStream(
                    stream
                )
            );
        }

        /*
          Dedupe nested candidates and keep document order.
        */
        const unique = [];

        for (const candidate of chunks) {
            if (
                !candidate ||
                deepPlacedModules.has(candidate) ||
                placedModules.has(candidate) ||
                candidate.closest(
                    `#${WATERFALL_ID}`
                ) ||
                candidate.closest?.(".uw56-native-feed-stage") ||
                isFooterish(candidate) ||
                uw39IsUtilityRelated(
                    candidate
                )
            ) {
                continue;
            }

            if (
                unique.some(existing =>
                    existing === candidate ||
                    existing.contains(candidate)
                )
            ) {
                continue;
            }

            for (
                let i = unique.length - 1;
                i >= 0;
                i--
            ) {
                if (
                    candidate.contains(
                        unique[i]
                    )
                ) {
                    unique.splice(i, 1);
                }
            }

            unique.push(candidate);
        }

        unique.sort((a, b) => {
            const ay =
                absoluteTop(a);

            const by =
                absoluteTop(b);

            if (
                Math.abs(ay - by) > 2
            ) {
                return ay - by;
            }

            return (
                a.compareDocumentPosition(b) &
                Node.DOCUMENT_POSITION_FOLLOWING
            ) ? -1 : 1;
        });

        return unique;
    }

    function deepSweep() {
        sweepRAF = 0;

        if (
            sweeping ||
            applying ||
            window.innerWidth < 1500
        ) {
            return;
        }

        /*
          V57: once Valve's live feed has been claimed, generic geometry
          discovery has nothing useful left to do there.  Avoid repeatedly
          querySelectorAll("main, section, article, div") across thousands of
          recommendation descendants as the page grows.
        */
        if (
            document.querySelector(".uw56-native-feed-stage") &&
            uw53TopLayoutReady() &&
            !uw53AggregateSuspect
        ) {
            return;
        }

        if (
            uw53AggregateSuspect &&
            uw51RescueOversizedDeepModules()
        ) {
            scheduleDeepSweep();
            return;
        }

        sweeping = true;

        const moved = [];
        const heights = uw54DeepLoadMap();
        const counts = new Map(lanes().map(lane => [lane, 0]));

        try {
            for (const module of deepCandidatesNearViewport()) {
                if (
                    module.closest(`#${WATERFALL_ID}`) ||
                    isFooterish(module) ||
                    uw39IsUtilityRelated(module)
                ) {
                    continue;
                }

                /* Mark before classification so chooseStructuredLane uses the
                   V53 deep-feed shortest-lane rule. */
                module.classList.add("uw26-deep-module");

                const lane = uw54ChooseDeepLane(heights);

                if (!lane) continue;

                /* Lock the first assignment. Never let lazy image/text sizing
                   on a later pass migrate this module to another column. */
                module.dataset.uw54DeepLane = lane.id;

                const before = lastPlacedCount;

                moveModule(
                    module,
                    lane,
                    "uw26-deep-module",
                    false,
                    true
                );

                if (lastPlacedCount > before) {
                    deepPlacedModules.add(module);
                    moved.push(module);

                    const h =
                        (heights.get(lane) || 0) +
                        uw54DeepWeight(module);
                    heights.set(lane, h);
                    counts.set(lane, (counts.get(lane) || 0) + 1);

                    if (
                        estimatedSlotHeight(module) >
                        Math.max(3400, window.innerHeight * 2.15)
                    ) {
                        uw53AggregateSuspect = true;
                    }
                } else {
                    module.classList.remove("uw26-deep-module");
                    delete module.dataset.uw54DeepLane;
                }
            }

            moveFooterAfterWaterfall();

            if (moved.length) {
                /* Local fitting only. Do NOT rebuild the entire long page. */
                scheduleFitModules(moved);
                collapseRunwayAfterContent();
                uw51ScheduleAggregateRescue();
            }
        } finally {
            sweeping = false;
        }
    }

    function scheduleDeepSweep() {
        if (sweepRAF) return;

        if (
            document.querySelector(".uw56-native-feed-stage") &&
            uw53TopLayoutReady() &&
            !uw53AggregateSuspect
        ) {
            return;
        }

        /*
          V52 PERFORMANCE: deepCandidatesNearViewport() is intentionally broad
          and therefore expensive on Steam's very long personalized homepage.
          V51 could run it every animation frame while scrolling. Cap it to a
          few passes per second instead; MutationObserver still wakes it as
          soon as Valve appends another content batch.
        */
        const elapsed = performance.now() - lastDeepSweepAt;
        const delay = Math.max(0, 520 - elapsed);

        sweepRAF = window.setTimeout(() => {
            sweepRAF = 0;
            lastDeepSweepAt = performance.now();
            requestAnimationFrame(deepSweep);
        }, delay);
    }

    function installResizeObserver() {
        if (
            resizeObserver ||
            typeof ResizeObserver === "undefined"
        ) {
            return;
        }

        /*
          Do NOT rebalance modules between lanes when they resize; that would
          make content jump around while browsing.

          We only recalculate local fit/slot height so a changing carousel
          cannot overlap the module below it or the neighboring lane.
        */
        resizeObserver =
            new ResizeObserver(
                entries => {
                    if (
                        fitting ||
                        !entries.length
                    ) {
                        return;
                    }

                    /*
                      V52 PERFORMANCE: one image decoding in one card used to
                      refit EVERY module on the page. On a long Store feed that
                      turns progressive image loading into hundreds of full-DOM
                      layout passes. Refit only the modules that actually resized.
                    */
                    const changed = entries
                        .map(entry => entry.target)
                        .filter(module =>
                            module?.classList?.contains("uw25-home-module")
                        );

                    scheduleFitModules(changed);

                    if (changed.some(module =>
                        (
                            uw55AggregateFeedHost(module) ||
                            (module.classList.contains("uw26-deep-module") &&
                                estimatedSlotHeight(module) >
                                    Math.max(3400, window.innerHeight * 2.15))
                        ) &&
                        !module.classList.contains("uw32-protected-module")
                    )) {
                        uw53AggregateSuspect = true;
                        uw51ScheduleAggregateRescue();
                    }
                }
            );

        document.querySelectorAll(
            ".uw25-home-module"
        ).forEach(module => {
            if (
                !observedModules.has(module)
            ) {
                observedModules.add(module);
                resizeObserver.observe(module);
            }
        });
    }

    /* =====================================================================
       V71 — COLD-START READINESS GATE
       ===================================================================== */

    function uw71NativeHomeLooksReady() {
        /*
          Structural checks only: no visible-language selectors are used here.
          We intentionally avoid depending on one specific Steam module because
          personalized homepages can omit or reorder sections.
        */
        const template =
            document.querySelector("#responsive_page_template_content");

        const body =
            document.querySelector(".home_page_body_ctn");

        const main =
            body?.querySelector(".main_content_ctn") ||
            body;

        if (!template || !main || !main.isConnected) {
            return false;
        }

        /*
          Steam may create the containers before it has mounted any real cards.
          Require at least one meaningful content signal before UltraWide starts
          moving DOM nodes. App links, images, carousels/clusters, or a visible
          direct child all count as a ready signal.
        */
        if (
            main.querySelector(
                "a[href*='/app/'], img, " +
                "[class*='carousel'], [class*='Carousel'], " +
                "[class*='cluster'], [class*='Cluster']"
            )
        ) {
            return true;
        }

        for (const child of main.children) {
            const rect = child.getBoundingClientRect();

            if (
                rect.width > 240 &&
                rect.height > 48
            ) {
                return true;
            }
        }

        return false;
    }

    function uw71ReleaseBoot() {
        if (uw71BootReleased) return;

        /*
          V75: Valve has now mounted real homepage content. Remove the startup
          status before any UltraWide layout work begins so the user's first
          usable native frame is never covered by the theme.
        */
        document.documentElement.classList.add(UW75_NATIVE_READY);
        document.documentElement.classList.remove(UW75_BOOTING);
        uw79RemoveBootNotice();

        uw71BootReleased = true;

        if (uw71BootTimer) {
            clearTimeout(uw71BootTimer);
            uw71BootTimer = 0;
        }

        /*
          Start with the normal coalesced scanner. Defer deep-probe/rescue work
          until after the first UltraWide layout frame so cold launch never
          stacks every expensive discovery job into one task.
        */
        scheduleScan();

        window.setTimeout(() => {
            uw46ScheduleDeepProbe();
            uw51ScheduleAggregateRescue();
            scheduleDeepSweep();
            scheduleReflow();
        }, 220);
    }

    function uw71ScheduleBootCheck(delay = 40) {
        if (uw71BootReleased || uw71BootTimer) return;

        uw71BootTimer = window.setTimeout(() => {
            uw71BootTimer = 0;

            /*
              Two RAFs guarantee at least one native rendering opportunity
              before UltraWide considers taking over the page.
            */
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (uw71NativeHomeLooksReady()) {
                        uw71ReleaseBoot();
                        return;
                    }

                    /*
                      Do not force activation onto an empty page. Steam's own
                      MutationObserver traffic will keep waking this inexpensive
                      readiness check. A slow network therefore shows native
                      Steam instead of a theme-created black canvas.
                    */
                    const bootAge =
                        performance.now() - uw71BootStartedAt;

                    /*
                      Poll briefly during ordinary cold starts. After 15 seconds
                      stop periodic polling and let the MutationObserver wake us
                      when Steam finally mounts something. This prevents a
                      permanent timer on genuinely failed/offline Store pages.
                    */
                    if (bootAge < 15000) {
                        uw71ScheduleBootCheck(
                            bootAge < 4000
                                ? 90
                                : 250
                        );
                    }
                });
            });
        }, Math.max(0, delay));
    }

    function apply() {
        scanRAF = 0;

        if (!uw71BootReleased) {
            uw71ScheduleBootCheck(40);
            return;
        }

        const placedBefore =
            lastPlacedCount;

        if (
            applying ||
            window.innerWidth < 1500
        ) {
            return;
        }

        applying = true;

        try {
            document.documentElement
                .classList.add(ACTIVE);

            ensureWaterfall();
            installResizeObserver();

            /* Detect/claim Valve's live recommendation stream before generic
               module discovery can pull any of its React-owned children out. */
            uw56PreparePotentialNativeFeeds();

            const ls = lanes();

            if (ls.length < 3) {
                return;
            }

            /*
              V48 top-left fixed pair. This does NOT touch the centered
              Featured & Recommended hero, which remains above the waterfall.
            */
            uw48KeepTopLeftUtilities();

            /*
              Fixed first row:
                left   = Discounts
                middle = Browse
                right  = Full releases tab module
            */
            const discounts =
                discountsRoot();

            if (discounts) {
                protectSpecial(
                    discounts,
                    "discounts"
                );

                if (
                    !placedModules.has(
                        discounts
                    )
                ) {
                    moveModule(
                        discounts,
                        ls[0]
                    );
                }

                if (
                    placedModules.has(
                        discounts
                    )
                ) {
                    markPinned(
                        discounts,
                        ls[0],
                        10
                    );
                }
            }

            /*
              V39 exact top-middle utility stack.

              Every root is individually validated. Generic discovery is not
              allowed to touch any root once identified.
            */
            uw39PlaceUtilities(
                ls
            );

            const releases =
                findFullReleasesModule();

            if (releases) {
                protectSpecial(
                    releases,
                    "releases"
                );

                if (
                    !placedModules.has(
                        releases
                    )
                ) {
                    moveModule(
                        releases,
                        ls[2],
                        "uw25-releases-module"
                    );
                }

                if (
                    placedModules.has(
                        releases
                    )
                ) {
                    markPinned(
                        releases,
                        ls[2],
                        10
                    );
                }
            }

            /*
              If V31 had already allowed one of these modules into a wrong
              lane, V32's ordered reflow will recover it now.
            */
            if (!uw53InitialReflowDone) {
                reflowWaterfall();
                uw53InitialReflowDone = true;
            }

            /* Pinned-slot reflow may change DOM order; flex order keeps the pair
               visually first, and this reasserts the intended raw parents. */
            uw48KeepTopLeftUtilities();

            /*
              Everything else continuously fills the currently shortest lane.
            */
            const genericMoved = [];
            const genericHeights = uw53FeedMetricHeights();

            for (const module of allCandidateModules()) {
                const lane = chooseStructuredLane(module, genericHeights);
                const before = lastPlacedCount;

                moveModule(
                    module,
                    lane,
                    null,
                    false,
                    true
                );

                if (lastPlacedCount > before) {
                    genericMoved.push(module);
                    let h = genericHeights.get(lane) || 0;
                    h += estimatedSlotHeight(module) + laneGap(lane);
                    genericHeights.set(lane, h);
                }
            }

            if (genericMoved.length) {
                scheduleFitModules(genericMoved);
                scheduleReflow();
            }

            moveFooterAfterWaterfall();

            if (Array.from(document.querySelectorAll(
                `#${WATERFALL_ID} .uw27-module-slot > .uw25-home-module`
            )).some(module =>
                !module.classList.contains("uw32-protected-module") &&
                uw55AggregateFeedHost(module)
            )) {
                uw53AggregateSuspect = true;
            }
        } finally {
            applying = false;
        }

        /*
          Named-section scan first, geometry sweep second.
          V52 avoids a whole-page fit/reflow when a scan found nothing new.
        */
        scheduleDeepSweep();
        if (uw53AggregateSuspect) uw51ScheduleAggregateRescue();

        if (
            lastPlacedCount >
            placedBefore
        ) {
            collapseRunwayAfterContent();
        }
    }

    function uw59MainContentRoot() {
        const shell = document.getElementById(WATERFALL_ID);
        const parent = shell?.parentElement;

        return parent?.classList?.contains("main_content_ctn")
            ? parent
            : document.querySelector(".home_page_body_ctn > .main_content_ctn");
    }

    function uw59DirectPreFeedRoot(node) {
        let el =
            node instanceof Element
                ? node
                : node?.parentElement;

        if (!el) return null;
        if (el.closest?.(`#${WATERFALL_ID}, .uw56-native-feed-stage`)) return null;

        const shell = document.getElementById(WATERFALL_ID);
        const main = uw59MainContentRoot();

        if (!shell || !main || !main.contains(el)) return null;

        if (el === main) return null;

        while (el.parentElement && el.parentElement !== main) {
            el = el.parentElement;
        }

        if (el.parentElement !== main || el === shell) return null;

        const position = shell.compareDocumentPosition(el);
        if (!(position & Node.DOCUMENT_POSITION_FOLLOWING)) return null;

        if (
            el.id === "home_maincap_v7" ||
            el.id === "footer" ||
            el.classList?.contains("uw25-home-vacated") ||
            el.classList?.contains("uw56-native-feed-stage") ||
            el.querySelector?.("#content_more") ||
            isFooterish(el)
        ) {
            return null;
        }

        return el;
    }

    function uw59LooksLikeTopUtility(root) {
        if (!root) return false;

        const t = text(root).slice(0, 700);

        return (
            /(?:^|\b)Your Personal Calendar\b/i.test(t) ||
            /(?:^|\b)Browse by Category\b/i.test(t) ||
            /(?:^|\b)The Community Recommends\b/i.test(t) ||
            /(?:^|\b)From Developers and Publishers You Know\b/i.test(t) ||
            /(?:^|\b)Explore Your Discovery Queue\b/i.test(t) ||
            /(?:^|\b)Discounts? & Events\b/i.test(t) ||
            (t.includes("Popular New Releases") && t.includes("Top Sellers"))
        );
    }

    function uw59QueuePreFeedRoots(records) {
        let queued = false;

        const consider = node => {
            const root = uw59DirectPreFeedRoot(node);
            if (!root || placedModules.has(root)) return;

            uw59PreFeedPending.add(root);
            queued = true;
        };

        for (const record of records || []) {
            consider(record.target);
            for (const node of record.addedNodes || []) consider(node);
        }

        if (!queued || uw59PreFeedTimer) return queued;

        uw59PreFeedTimer = window.setTimeout(() => {
            uw59PreFeedTimer = 0;
            requestAnimationFrame(uw59FlushPreFeedRoots);
        }, 120);

        return queued;
    }

    function uw59FlushPreFeedRoots() {
        if (applying || sweeping || reflowing || window.innerWidth < 1500) {
            if (!uw59PreFeedTimer && uw59PreFeedPending.size) {
                uw59PreFeedTimer = window.setTimeout(() => {
                    uw59PreFeedTimer = 0;
                    requestAnimationFrame(uw59FlushPreFeedRoots);
                }, 120);
            }
            return;
        }

        const roots = Array.from(uw59PreFeedPending)
            .filter(root => root?.isConnected && !placedModules.has(root));
        uw59PreFeedPending.clear();

        if (!roots.length) return;

        /* Preserve Valve's original top-to-bottom order before distributing. */
        roots.sort((a, b) => {
            if (a === b) return 0;
            return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
                ? -1
                : 1;
        });

        const ls = lanes();
        if (ls.length < 3) return;

        /* A late utility (most notably Discovery Queue) still belongs to its
           explicitly pinned location, not to generic balancing. */
        if (roots.some(uw59LooksLikeTopUtility)) {
            scheduleScan();
        }

        const heights = new Map(ls.map(lane => [lane, laneHeight(lane)]));
        const moved = [];

        for (const root of roots) {
            if (
                !root.isConnected ||
                placedModules.has(root) ||
                uw59LooksLikeTopUtility(root) ||
                !moduleLooksReady(root) ||
                uw55AggregateFeedHost(root)
            ) {
                continue;
            }

            root.dataset.uw60GapFiller = "true";

            const lane = chooseStructuredLane(root, heights);
            if (!lane) continue;

            const before = lastPlacedCount;
            moveModule(root, lane, null, false, true);

            if (lastPlacedCount > before) {
                moved.push(root);
                heights.set(
                    lane,
                    (heights.get(lane) || 0) +
                    estimatedSlotHeight(root) +
                    laneGap(lane)
                );
            }
        }

        if (moved.length) {
            scheduleFitModules(moved);
            scheduleReflow();
            collapseRunwayAfterContent();
        }
    }

    function scheduleScan() {
        if (scanRAF) return;

        /*
          V52 PERFORMANCE: lazy images/sections can generate a burst of DOM
          mutations. Coalesce those bursts instead of rescanning the whole
          homepage every animation frame.
        */
        const elapsed = performance.now() - lastScanAt;
        const delay = Math.max(0, 140 - elapsed);

        scanRAF = window.setTimeout(() => {
            scanRAF = 0;
            lastScanAt = performance.now();
            requestAnimationFrame(apply);
        }, delay);
    }

    function mutationNeedsScan(records) {
        for (const record of records) {
            const target =
                record.target instanceof Element
                    ? record.target
                    : record.target.parentElement;

            if (!target) continue;

            /* V56: mutations inside the native live-feed stage have their
               own lightweight layout queue. Do not wake the whole-page deep
               discovery pass for every card/image Steam appends there. */
            if (target.closest?.(".uw56-native-feed-stage")) {
                continue;
            }

            if (
                target.closest(
                    `#${WATERFALL_ID}`
                )
            ) {
                continue;
            }

            /*
              V52 PERFORMANCE: do not wake the expensive discovery pass for
              arbitrary attribute/style churn. A childList addition is the
              reliable signal that Valve appended/replaced Store content.
              src changes are retained only for lazy shells that become real
              image-backed cards without adding another wrapper node.
            */
            if (record.type === "childList") {
                const hasElementAddition =
                    Array.from(record.addedNodes || [])
                        .some(node => node instanceof Element);

                if (hasElementAddition) return true;
                continue;
            }

            if (
                record.type === "attributes" &&
                record.attributeName === "src" &&
                target.tagName === "IMG"
            ) {
                return true;
            }
        }

        return false;
    }


    function uw53TopLayoutReady() {
        if (uw53TopReadyCached) return true;

        const calendar = document.querySelector(".personal_calendar_ctn");
        const discovery = uw48DiscoveryRootExact();
        const discounts = discountsRoot();
        const browse = uw39UtilityRoots.get("browse");
        const community = uw39UtilityRoots.get("community");
        const developers = uw39UtilityRoots.get("developers");
        const releases = findFullReleasesModule();

        /*
          V57: Discovery Queue is optional.  Steam does not always render that
          module, and V56 therefore never considered the top layout "ready".
          That kept expensive whole-home scans alive for the entire session.
        */
        const requiredReady = !!(
            calendar && placedModules.has(calendar) &&
            discounts && placedModules.has(discounts) &&
            browse && placedModules.has(browse) &&
            community && placedModules.has(community) &&
            developers && placedModules.has(developers) &&
            releases && placedModules.has(releases)
        );

        const discoveryReady =
            !discovery || placedModules.has(discovery);

        const ready = requiredReady && discoveryReady;

        if (ready) uw53TopReadyCached = true;
        return ready;
    }

    function uw39InstallDiagnostics() {
        window.__UW39 = {
            version:
                "64.0.0",

            utility:
                () =>
                    UW39_UTILITY_SPECS
                        .map(spec => {
                            const root =
                                uw39UtilityRoots.get(
                                    spec.key
                                );

                            return {
                                key: spec.key,
                                found: !!root,
                                moved:
                                    !!root &&
                                    placedModules.has(root),
                                className:
                                    root
                                        ? root.className
                                        : null
                            };
                        }),

            calendarCapture:
                () => ({
                    captured: uw46CalendarCaptured,
                    deepProbeDone: uw46DeepProbeDone,
                    rootTag: uw46CalendarRoot?.tagName || null,
                    rootClass: uw46CalendarRoot?.className || null
                }),

            laneHeights:
                () =>
                    lanes().map(lane => ({
                        id: lane.id,
                        className: lane.className,
                        display: getComputedStyle(lane).display,
                        height:
                            Math.round(
                                laneHeight(lane)
                            )
                    })),

            oversizedDeep:
                () => Array.from(document.querySelectorAll(
                    `#${WATERFALL_ID} .uw27-module-slot`
                )).map(slot => ({
                    height: Math.round(slotHeight(slot)),
                    title: text(slot).slice(0, 100),
                    deep: !!slot.querySelector(
                        ":scope > .uw26-deep-module"
                    )
                })).filter(x => x.height > 3000),

            aggregateHosts:
                () => Array.from(document.querySelectorAll(
                    `#${WATERFALL_ID} .uw27-module-slot > .uw25-home-module`
                )).filter(module =>
                    !module.classList.contains("uw32-protected-module") &&
                    uw55AggregateFeedHost(module)
                ).map(module => ({
                    title: text(module).slice(0, 120),
                    className: module.className,
                    nestedSections: module.querySelectorAll(".home_pagecontent_ctn").length,
                    appLinks: module.querySelectorAll('a[href*="/app/"]').length,
                    height: Math.round(module.getBoundingClientRect().height)
                })),

            preFeedBridge:
                () => {
                    const shell = document.getElementById(WATERFALL_ID);
                    const main = uw59MainContentRoot();
                    const outside = [];

                    if (shell && main) {
                        for (const child of main.children) {
                            if (
                                child !== shell &&
                                (shell.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING) &&
                                !child.classList?.contains("uw25-home-vacated") &&
                                !child.classList?.contains("uw56-native-feed-stage") &&
                                !placedModules.has(child) &&
                                moduleLooksReady(child)
                            ) {
                                outside.push({
                                    id: child.id || "",
                                    className: String(child.className || ""),
                                    title: text(child).slice(0, 100),
                                    height: Math.round(child.getBoundingClientRect().height)
                                });
                            }
                        }
                    }

                    return {
                        pending: uw59PreFeedPending.size,
                        outside
                    };
                },

            topCompaction:
                () => {
                    const ls = lanes();
                    const heights = ls.map(lane => ({
                        id: lane.id,
                        height: Math.round(laneHeight(lane)),
                        fillers: Array.from(lane.querySelectorAll(
                            ":scope > .uw27-module-slot > .uw25-home-module"
                        )).filter(uw60TopGapFiller).length
                    }));
                    const values = heights.map(x => x.height);

                    return {
                        heights,
                        spread: values.length
                            ? Math.max(...values) - Math.min(...values)
                            : null
                    };
                },

            nativeFeedStages:
                () => Array.from(document.querySelectorAll(
                    ".uw56-native-feed-stage"
                )).map(host => {
                    const content =
                        host.querySelector(":scope > #content_more") ||
                        host.querySelector("#content_more");
                    const footer = footerRoot();

                    return {
                        height: Math.round(host.getBoundingClientRect().height),
                        contentHeight: content
                            ? Math.round(content.getBoundingClientRect().height)
                            : null,
                        cards: content
                            ? content.querySelectorAll(":scope > .uw57-native-feed-card").length
                            : 0,
                        masonryMeasured: content
                            ? content.querySelectorAll(
                                ":scope > .uw57-native-feed-card[data-uw58-masonry-measured='true']"
                              ).length
                            : 0,
                        masonrySpanMin: content
                            ? (() => {
                                const spans = Array.from(
                                    content.querySelectorAll(
                                        ":scope > .uw57-native-feed-card[data-uw58-masonry-span]"
                                    )
                                ).map(card =>
                                    parseInt(card.dataset.uw58MasonrySpan || "0", 10)
                                ).filter(Boolean);
                                return spans.length ? Math.min(...spans) : 0;
                              })()
                            : 0,
                        masonrySpanMax: content
                            ? (() => {
                                const spans = Array.from(
                                    content.querySelectorAll(
                                        ":scope > .uw57-native-feed-card[data-uw58-masonry-span]"
                                    )
                                ).map(card =>
                                    parseInt(card.dataset.uw58MasonrySpan || "0", 10)
                                ).filter(Boolean);
                                return spans.length ? Math.max(...spans) : 0;
                              })()
                            : 0,
                        directChildren: content?.children?.length || 0,
                        nestedSections: host.querySelectorAll(".home_pagecontent_ctn").length,
                        appLinks: host.querySelectorAll('a[href*="/app/"]').length,
                        footerDocumentTop: footer
                            ? Math.round(footer.getBoundingClientRect().top + window.scrollY)
                            : null,
                        documentHeight: document.documentElement.scrollHeight,
                        text: text(host).slice(0, 120)
                    };
                })
        };
    }


    function uw64CommunityRoot(el) {
        return el?.closest?.(
            ".community_recommendations_by_steam_labs_ctn, .uw25-community-module"
        ) || null;
    }

    function uw64NormalizeReviewText(value) {
        return String(value || "")
            .replace(/&quot;/gi, '"')
            .replace(/&#39;|&apos;/gi, "'")
            .replace(/&amp;/gi, "&")
            .replace(/\[(?:\/?)(?:h[1-6]|b|i|u|strike|spoiler|quote|code|pre|list|olist|table|tr|td|th)(?:=[^\]]*)?\]/gi, " ")
            .replace(/\[(?:url|img)(?:=[^\]]*)?\]/gi, " ")
            .replace(/\[\*\]/g, " ")
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/\.{3,}|…/g, " ")
            .replace(/[^\p{L}\p{N}]+/gu, " ")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
    }

    function uw64FindReviewScope(trigger, community) {
        const directReview = trigger?.closest?.('[id^="Review"].review_box');
        if (directReview) return directReview;

        let node = trigger;
        let fallback = trigger.parentElement || community;

        for (let i = 0; node && node !== community && i < 10; i += 1) {
            node = node.parentElement;
            if (!node) break;

            if (/^Review\d+$/i.test(node.id || "")) return node;

            const r = node.getBoundingClientRect();
            const t = text(node);

            if (
                r.width >= 260 &&
                r.width <= 1100 &&
                r.height >= 90 &&
                t.length >= 80 &&
                t.length <= 7000
            ) {
                fallback = node;

                if (
                    /played\s+[\d,.]+\s*hrs?/i.test(t) ||
                    node.querySelector('a[href*="steamcommunity.com/profiles/"], a[href*="steamcommunity.com/id/"]')
                ) {
                    return node;
                }
            }
        }

        return fallback || community;
    }

    function uw64FindRecommendationId(scope) {
        if (!scope) return null;

        const own = String(scope.id || "").match(/^Review(\d+)$/i);
        if (own) return own[1];

        const nested = scope.querySelector?.('[id^="Review"]');
        const nestedMatch = String(nested?.id || "").match(/^Review(\d+)$/i);
        return nestedMatch ? nestedMatch[1] : null;
    }

    function uw64FindExcerpt(scope, trigger) {
        if (!scope) return null;

        const triggerRect = trigger?.getBoundingClientRect?.();
        let best = null;
        let bestScore = -Infinity;

        const candidates = Array.from(
            scope.querySelectorAll("p, blockquote, div, span")
        );

        for (const el of candidates) {
            if (el === trigger || el.contains(trigger)) continue;
            if (!isVisible(el)) continue;

            const value = text(el);
            if (value.length < 55 || value.length > 2400) continue;
            if (/read entire review/i.test(value)) continue;
            if (/^played\s+[\d,.]+\s*hrs?/i.test(value)) continue;
            if (/people found this review helpful/i.test(value)) continue;
            if (/^\d+\s+of\s+\d+\s+reviews?$/i.test(value)) continue;

            const r = el.getBoundingClientRect();
            if (r.width < 180 || r.height < 20) continue;

            let score = Math.min(value.length, 1100);

            if (/\.{3}\s*["']?$|…\s*["']?$/.test(value)) score += 500;
            if (/^["“].+["”]?$/s.test(value)) score += 80;

            if (triggerRect && r.bottom <= triggerRect.top + 80) {
                score += Math.max(0, 250 - Math.abs(triggerRect.top - r.bottom));
            }

            const childTextBlocks = Array.from(el.children)
                .filter(child => text(child).length > 45).length;
            score -= childTextBlocks * 120;

            if (score > bestScore) {
                best = el;
                bestScore = score;
            }
        }

        return best;
    }

    function uw64FindAppId(trigger, scope, community) {
        let node = trigger;

        for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
            const links = node.querySelectorAll?.('a[href*="/app/"]') || [];
            const ids = new Set();

            for (const link of links) {
                const match = String(link.href || "").match(/\/app\/(\d+)/);
                if (match) ids.add(match[1]);
            }

            if (ids.size === 1) return [...ids][0];
            if (node === community) break;
        }

        for (const root of [scope, scope?.closest?.('.community_recommendation_app'), community]) {
            if (!root) continue;

            for (const el of root.querySelectorAll('a[href*="/app/"], img[src*="/steam/apps/"]')) {
                const raw = el.href || el.src || "";
                const match = String(raw).match(/(?:\/app\/|\/steam\/apps\/)(\d+)/);
                if (match) return match[1];
            }
        }

        return null;
    }

    function uw64FindSteamId(scope) {
        if (!scope) return null;

        const profile = scope.querySelector(
            'a[href*="steamcommunity.com/profiles/"]'
        );

        const match = String(profile?.href || "").match(/\/profiles\/(\d{15,20})/);
        return match ? match[1] : null;
    }

    async function uw64FetchReviewPage(
        appid,
        cursor = "*",
        filter = "recent",
        dayRange = null
    ) {
        const params = new URLSearchParams({
            json: "1",
            filter,
            language: "all",
            review_type: "all",
            purchase_type: "all",
            num_per_page: "100",
            filter_offtopic_activity: "0",
            cursor
        });

        if (filter === "all" && dayRange) {
            params.set("day_range", String(dayRange));
        }

        const response = await fetch(
            `/appreviews/${encodeURIComponent(appid)}?${params.toString()}`,
            {
                credentials: "include",
                cache: "no-store"
            }
        );

        if (!response.ok) {
            throw new Error(`Steam reviews request failed (${response.status})`);
        }

        const data = await response.json();
        if (!data || data.success !== 1 || !Array.isArray(data.reviews)) {
            throw new Error("Steam returned an invalid reviews response");
        }

        return data;
    }

    function uw64ReviewMatches(review, normalizedExcerpt, steamid, recommendationid) {
        if (!review) return false;

        if (
            recommendationid &&
            String(review.recommendationid || "") === String(recommendationid)
        ) {
            return true;
        }

        if (
            steamid &&
            String(review.author?.steamid || "") === String(steamid)
        ) {
            return true;
        }

        if (!normalizedExcerpt || normalizedExcerpt.length < 30) return false;

        const full = uw64NormalizeReviewText(review.review);
        const probeLength = Math.min(180, normalizedExcerpt.length);
        const probe = normalizedExcerpt.slice(0, probeLength);

        if (probe.length >= 30 && full.includes(probe)) return true;

        const shortProbe = normalizedExcerpt.slice(
            0,
            Math.min(85, normalizedExcerpt.length)
        );
        return shortProbe.length >= 40 && full.includes(shortProbe);
    }

    function uw64ReviewCacheFor(appid) {
        const key = String(appid);
        let cache = uw64ReviewCache.get(key);

        if (!cache) {
            cache = {
                reviews: [],
                recommendationIds: new Set(),
                states: new Map()
            };
            uw64ReviewCache.set(key, cache);
        }

        return cache;
    }

    function uw64MergeReviews(cache, reviews) {
        for (const review of reviews || []) {
            const id = String(review?.recommendationid || "");
            if (id && cache.recommendationIds.has(id)) continue;
            if (id) cache.recommendationIds.add(id);
            cache.reviews.push(review);
        }
    }

    async function uw64ResolveFullReview(appid, excerpt, steamid, recommendationid) {
        const normalizedExcerpt = uw64NormalizeReviewText(excerpt);
        const cache = uw64ReviewCacheFor(appid);

        const cachedMatch = cache.reviews.find(review =>
            uw64ReviewMatches(
                review,
                normalizedExcerpt,
                steamid,
                recommendationid
            )
        );
        if (cachedMatch) return cachedMatch;

        /* Exact DOM recommendation ids make the common path very reliable.
           If a review is not in the recent stream, updated/all are cheap
           click-time fallbacks and do not affect page scrolling. */
        const strategies = [
            { filter: "recent", maxPages: recommendationid ? 8 : 4 },
            { filter: "updated", maxPages: recommendationid ? 5 : 2 },
            { filter: "all", maxPages: 1, dayRange: 365 }
        ];

        for (const strategy of strategies) {
            const stateKey = `${strategy.filter}:${strategy.dayRange || 0}`;
            let state = cache.states.get(stateKey);

            if (!state) {
                state = {
                    cursor: "*",
                    cursors: new Set(),
                    exhausted: false,
                    pages: 0
                };
                cache.states.set(stateKey, state);
            }

            for (
                let i = state.pages;
                i < strategy.maxPages && !state.exhausted;
                i += 1
            ) {
                const cursor = state.cursor || "*";
                if (state.cursors.has(cursor)) {
                    state.exhausted = true;
                    break;
                }

                state.cursors.add(cursor);

                const data = await uw64FetchReviewPage(
                    appid,
                    cursor,
                    strategy.filter,
                    strategy.dayRange || null
                );

                state.pages += 1;
                uw64MergeReviews(cache, data.reviews);

                const found = data.reviews.find(review =>
                    uw64ReviewMatches(
                        review,
                        normalizedExcerpt,
                        steamid,
                        recommendationid
                    )
                );
                if (found) return found;

                if (strategy.filter === "all") {
                    state.exhausted = true;
                    break;
                }

                const next = String(data.cursor || "");
                if (!next || next === cursor || data.reviews.length === 0) {
                    state.exhausted = true;
                } else {
                    state.cursor = next;
                }
            }
        }

        return cache.reviews.find(review =>
            uw64ReviewMatches(
                review,
                normalizedExcerpt,
                steamid,
                recommendationid
            )
        ) || null;
    }

    function uw64EscapeHtml(value) {
        return String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function uw64RenderReviewMarkup(value) {
        let html = uw64EscapeHtml(value || "");

        /* Steam reviews use BBCode rather than HTML. Render the common
           formatting subset after escaping the user's text, then strip any
           unknown tags so markup never appears as raw [h1]/[b]/etc. */
        const pairs = [
            ["h1", '<div class="uw64-bb-heading uw64-bb-h1">', "</div>"],
            ["h2", '<div class="uw64-bb-heading uw64-bb-h2">', "</div>"],
            ["h3", '<div class="uw64-bb-heading uw64-bb-h3">', "</div>"],
            ["b", "<strong>", "</strong>"],
            ["i", "<em>", "</em>"],
            ["u", '<span class="uw64-bb-underline">', "</span>"],
            ["strike", "<s>", "</s>"],
            ["quote", '<blockquote class="uw64-bb-quote">', "</blockquote>"],
            ["code", '<pre class="uw64-bb-code">', "</pre>"],
            ["pre", '<pre class="uw64-bb-code">', "</pre>"],
            ["spoiler", '<span class="uw64-bb-spoiler">', "</span>"]
        ];

        for (const [tag, open, close] of pairs) {
            html = html
                .replace(new RegExp(`\\[${tag}\\]`, "gi"), open)
                .replace(new RegExp(`\\[\\/${tag}\\]`, "gi"), close);
        }

        html = html
            .replace(/\[(?:list|olist)\]/gi, "\n")
            .replace(/\[\/(?:list|olist)\]/gi, "\n")
            .replace(/\[\*\]/g, "\n• ")
            .replace(/\[url(?:=[^\]]*)?\]/gi, "")
            .replace(/\[\/url\]/gi, "")
            .replace(/\[img(?:=[^\]]*)?\]/gi, "")
            .replace(/\[\/img\]/gi, "")
            .replace(/\[(?:table|tr|td|th)(?:=[^\]]*)?\]/gi, " ")
            .replace(/\[\/(?:table|tr|td|th)\]/gi, " ")
            .replace(/\[\/?[a-z0-9_]+(?:=[^\]]*)?\]/gi, "")
            .replace(/\n{3,}/g, "\n\n");

        return html;
    }

    function uw64SetExpandedGeometry(state, enabled) {
        const community = state?.community;
        const app = state?.app;
        const scope = state?.scope;

        community?.classList.toggle("uw64-review-open", !!enabled);
        app?.classList.toggle("uw64-review-open-card", !!enabled);
        scope?.classList.toggle("uw64-review-open-box", !!enabled);
    }

    function uw64RestoreActiveExpansion() {
        const state = uw64ActiveExpansion;
        uw64ActiveExpansion = null;
        if (!state) return;

        uw64SetExpandedGeometry(state, false);

        if (state.excerpt?.isConnected) {
            state.excerpt.classList.remove("uw64-review-excerpt-hidden");
        }

        if (state.trigger?.isConnected) {
            state.trigger.classList.remove("uw64-review-trigger-expanded");
            if (state.originalLabel) {
                state.trigger.textContent = state.originalLabel;
            }
        }

        state.panel?.remove();
    }

    function uw64MakeInlinePanel(
        trigger,
        excerptEl,
        review,
        originalHref,
        community,
        scope
    ) {
        uw64RestoreActiveExpansion();

        const panel = document.createElement("div");
        panel.className = "uw64-inline-review";

        const body = document.createElement("div");
        body.className = "uw64-inline-review-text";
        body.innerHTML = uw64RenderReviewMarkup(review.review || "");

        const actions = document.createElement("div");
        actions.className = "uw64-inline-review-actions";

        const collapse = document.createElement("button");
        collapse.type = "button";
        collapse.className = "uw64-inline-review-collapse";
        collapse.textContent = "Collapse Review";
        collapse.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            uw64RestoreActiveExpansion();
        });
        actions.appendChild(collapse);

        if (originalHref) {
            const original = document.createElement("button");
            original.type = "button";
            original.className = "uw64-inline-review-original";
            original.textContent = "Open Original";
            original.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                uw64ReviewBypassClicks.add(trigger);
                trigger.click();
            });
            actions.appendChild(original);
        }

        panel.append(body, actions);

        if (excerptEl?.parentElement) {
            excerptEl.insertAdjacentElement("afterend", panel);
            excerptEl.classList.add("uw64-review-excerpt-hidden");
        } else {
            trigger.parentElement?.insertBefore(panel, trigger);
        }

        const originalLabel = text(trigger) || "Read Entire Review";
        trigger.textContent = "Collapse Review";
        trigger.classList.add("uw64-review-trigger-expanded");

        const app = scope?.closest?.(".community_recommendation_app") || null;

        uw64ActiveExpansion = {
            trigger,
            excerpt: excerptEl,
            panel,
            originalLabel,
            community,
            scope,
            app
        };

        uw64SetExpandedGeometry(uw64ActiveExpansion, true);

        /* Keep the review readable even when it is very long. The module grows
           a little, then the text itself scrolls rather than escaping Steam's
           carousel geometry. */
        requestAnimationFrame(() => {
            if (!panel.isConnected) return;
            body.scrollTop = 0;
            panel.scrollIntoView({
                block: "nearest",
                behavior: "smooth"
            });
        });
    }

    function uw64MakeLoadingPanel(trigger, excerptEl) {
        const panel = document.createElement("div");
        panel.className = "uw64-inline-review uw64-inline-review-loading";
        panel.textContent = "Loading full review…";

        if (excerptEl?.parentElement) {
            excerptEl.insertAdjacentElement("afterend", panel);
        } else {
            trigger.parentElement?.insertBefore(panel, trigger);
        }

        return panel;
    }

    function uw64InlineReviewError(panel, trigger, message) {
        if (!panel?.isConnected) return;

        panel.classList.remove("uw64-inline-review-loading");
        panel.classList.add("uw64-inline-review-error");
        panel.textContent = "Steam did not return this exact review inline. ";

        const original = document.createElement("button");
        original.type = "button";
        original.className = "uw64-inline-review-original";
        original.textContent = "Open Original Review";
        original.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            uw64ReviewBypassClicks.add(trigger);
            trigger.click();
        });

        panel.appendChild(original);
        console.warn("[Ultrawide] Inline review expansion failed:", message);
    }

    async function uw64HandleReviewClick(event, trigger, community) {
        if (uw64ReviewBypassClicks.has(trigger)) {
            uw64ReviewBypassClicks.delete(trigger);
            return;
        }

        if (trigger.classList.contains("uw64-review-trigger-expanded")) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            uw64RestoreActiveExpansion();
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const scope = uw64FindReviewScope(trigger, community);
        const excerptEl = uw64FindExcerpt(scope, trigger);
        const excerpt = text(excerptEl);
        const appid = uw64FindAppId(trigger, scope, community);
        const steamid = uw64FindSteamId(scope);
        const recommendationid = uw64FindRecommendationId(scope);
        const originalHref = trigger.href || trigger.getAttribute?.("href") || "";

        uw64RestoreActiveExpansion();
        const loading = uw64MakeLoadingPanel(trigger, excerptEl);

        if (!appid || (excerpt.length < 20 && !recommendationid)) {
            uw64InlineReviewError(
                loading,
                trigger,
                `missing ${!appid ? "appid" : "review identity"}`
            );
            return;
        }

        try {
            const review = await uw64ResolveFullReview(
                appid,
                excerpt,
                steamid,
                recommendationid
            );

            if (!loading.isConnected) return;

            if (!review?.review) {
                uw64InlineReviewError(
                    loading,
                    trigger,
                    `matching review not found (recommendationid=${recommendationid || "unknown"})`
                );
                return;
            }

            loading.remove();
            uw64MakeInlinePanel(
                trigger,
                excerptEl,
                review,
                originalHref,
                community,
                scope
            );
        } catch (error) {
            uw64InlineReviewError(
                loading,
                trigger,
                error?.message || String(error)
            );
        }
    }

    function uw64InstallInlineReviews() {
        if (uw64InlineReviewsInstalled) return;
        uw64InlineReviewsInstalled = true;

        document.addEventListener(
            "click",
            event => {
                const target = event.target instanceof Element
                    ? event.target
                    : null;
                if (!target) return;

                const trigger = target.closest("a, button, [role='button']");
                if (!trigger) return;

                const community = uw64CommunityRoot(trigger);
                if (!community) return;

                const label = text(trigger);
                if (!/^read entire review$/i.test(label) &&
                    !trigger.classList.contains("uw64-review-trigger-expanded")) {
                    return;
                }

                void uw64HandleReviewClick(event, trigger, community);
            },
            true
        );
    }

    function start() {
        uw39InstallDiagnostics();
        uw64InstallInlineReviews();

        if (!observer) {
            observer =
                new MutationObserver(
                    records => {
                        /*
                          V71 cold-start gate: while Steam is still mounting the
                          native homepage, mutations should only wake the cheap
                          readiness test. Do not run scanners/reflows yet.
                        */
                        if (!uw71BootReleased) {
                            uw71ScheduleBootCheck(30);
                            return;
                        }

                        /* V64: Steam replaces review_box nodes when its inner
                           Community carousel advances. If that happens while
                           a review is open, remove the temporary expanded
                           geometry immediately instead of leaving a tall empty
                           card behind. This is O(1) and only runs while a
                           review is actually expanded. */
                        if (
                            uw64ActiveExpansion &&
                            !uw64ActiveExpansion.panel?.isConnected
                        ) {
                            uw64RestoreActiveExpansion();
                        }

                        const touchedNativeFeed = uw56FeedMutationHosts(records);

                        const preFeedQueued =
                            !applying &&
                            uw59QueuePreFeedRoots(records);

                        if (
                            !applying &&
                            mutationNeedsScan(
                                records
                            )
                        ) {
                            /*
                              New Valve content appeared. Remove temporary
                              runway immediately; the real modules will now
                              create the page height.
                            */
                            collapseRunwayAfterContent();

                            /*
                              V53 PERFORMANCE: after the fixed top layout is
                              captured, do not rescan/rebuild the entire Store
                              homepage for every newly appended recommendation
                              batch. The deep sweep is enough for the long feed.
                            */
                            if (!uw53TopLayoutReady()) {
                                scheduleScan();
                            } else if (preFeedQueued) {
                                /* V59 handles these few early modules through
                                   the narrow pre-feed queue above; do not wake
                                   the full-home scanner once the top is ready. */
                            }

                            scheduleDeepSweep();
                            uw46ScheduleTailRescue();
                        }
                    }
                );

            observer.observe(
                document.documentElement,
                {
                    /*
                      V57: child insertions are sufficient. CSS Grid naturally
                      reacts when lazy images resize, so observing every "src"
                      attribute on a long feed only creates needless JS churn.
                    */
                    childList: true,
                    subtree: true
                }
            );
        }

        /*
          V71: wait for a native first paint and meaningful Store content.
          The normal layout pipeline is released by uw71ReleaseBoot().
        */
        uw71ScheduleBootCheck(0);
    }

    window.addEventListener(
        "resize",
        () => {
            if (!uw71BootReleased) {
                uw71ScheduleBootCheck(30);
                return;
            }

            scheduleScan();
            scheduleDeepSweep();
            scheduleFitAll();
            scheduleReflow();
            document.querySelectorAll(".uw56-native-feed-stage")
                .forEach(host => {
                    uw56ScheduleFeedLayout(host, 80);

                    /*
                      Width changes are rare and can change every card's height,
                      so this is the one case where V58 intentionally remeasures
                      the full native feed.
                    */
                    window.setTimeout(() => {
                        uw58QueueMasonryCards(
                            host,
                            uw56FeedCards(host),
                            40
                        );
                    }, 140);
                });
        },
        { passive: true }
    );

    /*
      Steam's long recommendation feed is progressively revealed/appended
      as the user scrolls. Sweep around the viewport as we move down-page.
    */
    window.addEventListener(
        "scroll",
        () => {
            if (!uw71BootReleased) {
                return;
            }

            /*
              V52 PERFORMANCE: scrolling must stay cheap. V51 scheduled three
              different geometry/layout jobs on virtually every scroll frame.
              Deep sweep is now throttled internally, Calendar tail rescue is a
              no-op once captured, and aggregate-host rescue is driven by deep
              module resize/new-content events instead of raw scroll activity.
            */
            uw46ScheduleTailRescue();

            const remaining =
                document.documentElement
                    .scrollHeight -
                (
                    window.scrollY +
                    window.innerHeight
                );

            if (
                remaining <
                window.innerHeight * 2.25
            ) {
                const nativeFeed =
                    document.querySelector(".uw56-native-feed-stage");

                /*
                  Once the native feed exists Steam owns infinite loading and
                  CSS Grid owns placement. Scrolling must not wake the generic
                  deep-DOM scanner anymore.
                */
                if (nativeFeed) {
                    /*
                      V57: scrolling itself performs zero feed/footer geometry
                      work. New Steam batches and window resize already update
                      the footer. This keeps the hot scroll path read/write free.
                    */
                    return;
                }

                const now = performance.now();

                if (now - uw53LastFallbackSweepAt > 1800) {
                    uw53LastFallbackSweepAt = now;
                    scheduleDeepSweep();

                    if (!uw53TopLayoutReady()) {
                        scheduleScan();
                    }
                }
            }
        },
        { passive: true }
    );

    if (
        document.readyState ===
        "loading"
    ) {
        document.addEventListener(
            "DOMContentLoaded",
            start,
            { once: true }
        );
    } else {
        start();
    }
})();

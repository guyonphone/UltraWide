(() => {
    "use strict";

    /* ---------------------------------------------------------------------
       HARD APP-PAGE SCOPE GUARD

       Millennium already scopes this file through skin.json, but Steam can
       reuse browser views and hot-reload/navigate content in ways that leave
       previously injected JavaScript alive longer than expected.  Treat the
       URL as a second line of defense: this module may only operate on an
       actual /app/<numeric-id> Store page.
       --------------------------------------------------------------------- */
    function isUltraWideAppPage() {
        return (
            location.hostname === "store.steampowered.com" &&
            /^\/app\/\d+(?:\/|$)/.test(location.pathname)
        );
    }

    if (!isUltraWideAppPage()) return;

    /* =====================================================================
       ULTRAWIDE — INDIVIDUAL STEAM APP PAGES
       =====================================================================

       This file only runs on store.steampowered.com/app/... pages.

       Design goals:
         1. Build a wide three-lane app-page layout without changing Steam's
            underlying data or security model.
         2. Keep purchase controls in the right lane on every game page.
         3. Keep Steam's React-owned Customer Reviews subtree intact so native
            filters can safely re-render it.
         4. Add a theme-owned, same-origin review continuation below Steam's
            native review sample without importing remote JavaScript or CSS.
         5. Prefer language-independent ids/classes/URLs/values. Visible English
            text is used only as a documented last-resort fallback.

       Performance policy:
         - layout work is coalesced through requestAnimationFrame;
         - no per-card review observers or review-card reparenting;
         - the review scroll handler is throttled to one RAF callback.
       ===================================================================== */

    /* ---------------------------------------------------------------------
       GLOBAL LAYOUT CONSTANTS AND RUNTIME STATE
       --------------------------------------------------------------------- */

    const ACTIVE = "uw9-active";
    const SHELL = "uw9-shell";

    const MID_ID = "uw9-middle";
    const AUX_ID = "uw9-aux";

    const LOWER_ID = "uw9-lower-grid";
    const MIN_WIDTH = 2200;

    const moved = new Map();
    const vacated = new Set();
    const generated = new Set();

    let raf = 0;
    let observer = null;

    /*
      V73 COLD-START STATUS NOTICE

      Steam browser views can briefly paint only the dark Store canvas while
      Valve is still mounting an app page. That looks indistinguishable from a
      broken theme to a first-time user. If #game_highlights has not appeared
      after a short grace period, show a small theme-owned status card. It never
      hides native Steam content and disappears immediately when the page mounts.
    */
    let appLoadingNotice = null;
    let appLoadingNoticeTimer = 0;

    /* Native review viewport state. */
    let reviewObserver = null;
    let reviewObservedRoot = null;
    let reviewLoadObserver = null;
    let reviewLoadSentinel = null;
    let reviewLoadViewport = null;
    let reviewScrollRAF = 0;
    let lastReviewLoaderWake = 0;
    const boundReviewViewports = new WeakSet();

    /*
      V79/V80 finite graph-settle probes. Steam can reveal the histogram through a
      layout/style transition that produces no useful childList signal. Each
      native review root gets only a handful of cheap post-mount checks, never
      a permanent poll.
    */
    const reviewGraphSettlingRoots = new WeakSet();

    /*
      V80 GRAPH-TOGGLE STABILITY

      Once Steam's histogram wrapper has been identified, remember that exact
      native branch even while Steam temporarily collapses it to zero height.
      This prevents a hide/show transition from dropping the graph branch out
      of the cached pin set and then having to rediscover it mid-animation.
    */
    const knownReviewGraphBranches = new Set();
    let reviewGraphToggleTimers = [];

    /*
      Review header pinning state.

      V73 deliberately pins the review chrome as a SET OF EXISTING NATIVE
      blocks instead of trying to guess one magical wrapper. Current Steam
      app pages can render the review summary, dropdown row and active-filter
      row as separate generated DIV branches. A single-wrapper heuristic can
      therefore pin only one strip and later lose it when React mutates the
      tree.

      The V73 detector finds the first real review card, walks the ancestor
      path back toward the native review root, and collects the visible sibling
      branches that occur BEFORE that card. Those branches are the pre-review
      chrome. They remain in Steam's original DOM; we only translate their
      paint by the internal viewport's scrollTop. The set is cached until Steam
      actually replaces one of the blocks, avoiding scroll-dependent re-detects.
    */
    let pinnedReviewPieces = [];
    let pinnedReviewBackdrop = null;
    let pinnedReviewChromeHeight = 0;

    /* Theme-owned review continuation state. */
    let reviewCursor = "*";
    let reviewFilterSignature = "";
    let reviewLoading = false;
    let reviewExhausted = false;
    const seenReviewCursors = new Set();
    const seenRecommendationIds = new Set();

    /* ---------------------------------------------------------------------
       GENERIC DOM RELOCATION HELPERS
       Nodes moved by the theme receive comment placeholders so the original
       Steam DOM can be restored if the window becomes too narrow.
       --------------------------------------------------------------------- */

    function normText(el) {
        return ((el && el.textContent) || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
    }

    function placeholderFor(el) {
        if (moved.has(el)) return moved.get(el);

        const parent = el.parentElement;
        if (!parent) return null;

        const ph = document.createComment("uw9-placeholder");
        parent.insertBefore(ph, el);

        moved.set(el, { placeholder: ph, parent });
        return ph;
    }

    function isMajorRoot(el) {
        return !el || el.matches(
            "body, html, " +
            ".game_page_background, .game_background_glow, " +
            "#responsive_page_template_content, .responsive_page_content, " +
            ".page_content_ctn, #tabletGrid"
        );
    }

    function markVacated(parent) {
        if (!parent || isMajorRoot(parent)) return;

        if (parent.children.length === 0) {
            parent.classList.add("uw9-vacated");
            vacated.add(parent);
        }
    }

    function moveNode(el, destination, extraClass = "") {
        if (!el || !destination || destination.contains(el)) return;

        const parent = el.parentElement;

        placeholderFor(el);

        if (extraClass) el.classList.add(extraClass);

        destination.appendChild(el);

        markVacated(parent);
    }

    function restoreEverything() {
        const els = Array.from(moved.keys()).reverse();

        for (const el of els) {
            const data = moved.get(el);
            if (!data) continue;

            const ph = data.placeholder;

            if (ph && ph.parentNode) {
                ph.parentNode.insertBefore(el, ph);
                ph.remove();
            }

            el.classList.remove("uw9-header-extra");
            el.classList.remove("uw10-live-broadcast");
            el.classList.remove("uw11-packed-module");
            el.classList.remove("uw65-purchase-section");
            el.classList.remove("uw-native-review-root");
            moved.delete(el);
        }

        for (const el of vacated) {
            el.classList.remove("uw9-vacated");
        }
        vacated.clear();

        for (const el of generated) {
            el.remove();
        }
        generated.clear();

        document.getElementById(MID_ID)?.remove();
        document.getElementById(AUX_ID)?.remove();
        document.getElementById(LOWER_ID)?.remove();

        document.getElementById("uw11-left-continuation")?.remove();
        document.getElementById("uw11-mid-continuation")?.remove();
        document.getElementById("uw11-aux-continuation")?.remove();

        if (reviewObserver) {
            reviewObserver.disconnect();
            reviewObserver = null;
        }
        reviewObservedRoot = null;

        if (reviewLoadObserver) {
            reviewLoadObserver.disconnect();
            reviewLoadObserver = null;
        }
        reviewLoadSentinel = null;
        reviewLoadViewport = null;

        document.querySelectorAll(".uw-native-review-root").forEach(el => {
            el.classList.remove("uw-native-review-root");
        });

        document.querySelectorAll(".uw-native-browse-hidden").forEach(el => {
            el.classList.remove("uw-native-browse-hidden");
            el.removeAttribute("aria-hidden");
        });

        document.querySelectorAll(".uw-review-pinned-piece").forEach(el => {
            el.classList.remove("uw-review-pinned-piece");
            el.removeAttribute("data-uw-review-pinned");
            el.removeAttribute("data-uw-review-pin-source");
            el.style.removeProperty("--uw-review-pin-y");
        });

        document.querySelectorAll(".uw-review-pin-chain").forEach(el => {
            el.classList.remove("uw-review-pin-chain");
        });

        document.getElementById("uw-review-pin-backdrop")?.remove();

        pinnedReviewPieces = [];
        pinnedReviewBackdrop = null;
        pinnedReviewChromeHeight = 0;

        reviewCursor = "*";
        reviewFilterSignature = "";
        reviewLoading = false;
        reviewExhausted = false;
        seenReviewCursors.clear();
        seenRecommendationIds.clear();

        const hero = document.querySelector("#game_highlights");

        if (hero) {
            hero.classList.remove(SHELL);

            for (const prop of [
                "--uw9-gap",
                "--uw9-media",
                "--uw9-mid",
                "--uw9-aux",
                "--uw9-total",
                "--uw9-lower-gap"
            ]) {
                hero.style.removeProperty(prop);
            }
        }

        document.documentElement.classList.remove(ACTIVE);
    }

    function directChildContaining(root, descendant) {
        if (!root || !descendant) return null;

        let n = descendant;

        while (n && n.parentElement && n.parentElement !== root) {
            n = n.parentElement;
        }

        return n && n.parentElement === root ? n : null;
    }

    /* ---------------------------------------------------------------------
       APP-PAGE CONTENT DISCOVERY
       Structural selectors are preferred. English heading text is retained
       only as a fallback for older Steam templates.
       --------------------------------------------------------------------- */

    function findAboutBoundary(mainCol) {
        if (!mainCol) return null;

        const desc =
            mainCol.querySelector("#game_area_description") ||
            document.querySelector("#game_area_description");

        if (desc) return directChildContaining(mainCol, desc);

        const headings = Array.from(mainCol.querySelectorAll("h1, h2, h3"));

        const heading = headings.find(h =>
            /^about this game$/i.test(h.textContent.trim())
        );

        return heading
            ? directChildContaining(mainCol, heading)
            : null;
    }

    function collectPreAboutNodes(mainCol) {
        if (!mainCol) return [];

        const boundary = findAboutBoundary(mainCol);
        const children = Array.from(mainCol.children);

        if (!boundary) {
            return children.filter(el =>
                el.id === "game_area_purchase" ||
                el.matches(".early_access_header") ||
                el.matches(".recent_game_events") ||
                el.matches(".game_area_bubble") ||
                el.matches(".game_page_autocollapse") ||
                el.matches("[class*='curator']") ||
                el.matches("[class*='franchise']")
            );
        }

        const idx = children.indexOf(boundary);
        return idx > 0 ? children.slice(0, idx) : [];
    }

    function isVisible(el) {
        if (!el) return false;

        const s = getComputedStyle(el);

        if (s.display === "none" || s.visibility === "hidden") {
            return false;
        }

        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
    }

    function findTitleArea() {
        return (
            document.querySelector(".page_title_area.game_title_area") ||
            document.querySelector(".game_title_area") ||
            document.querySelector(".apphub_HomeHeaderContent")
                ?.closest(".page_title_area") ||
            document.querySelector(".apphub_HomeHeaderContent")
        );
    }

    function findHeaderExtras(hero, titleArea) {
        if (!hero) return [];

        const heroRect = hero.getBoundingClientRect();

        const titleRect =
            titleArea && isVisible(titleArea)
                ? titleArea.getBoundingClientRect()
                : null;

        const low =
            titleRect
                ? titleRect.bottom - 6
                : heroRect.top - 420;

        const high = heroRect.top + 8;

        const candidates = [];
        const seen = new Set();

        const imageLike = Array.from(
            document.querySelectorAll(
                ".game_page_background img, " +
                ".game_page_background picture, " +
                ".game_page_background [style*='background-image']"
            )
        );

        for (const visual of imageLike) {
            if (!isVisible(visual)) continue;
            if (hero.contains(visual)) continue;
            if (titleArea && titleArea.contains(visual)) continue;

            const vr = visual.getBoundingClientRect();

            if (vr.top < low || vr.bottom > high) continue;
            if (vr.width < 420 || vr.height < 45 || vr.height > 420) continue;

            let node = visual;
            let best = visual;

            for (let i = 0; i < 5 && node.parentElement; i++) {
                const p = node.parentElement;

                if (isMajorRoot(p)) break;

                const pr = p.getBoundingClientRect();

                const inBand =
                    pr.top >= low - 12 &&
                    pr.bottom <= high + 12;

                const compact =
                    pr.width <= Math.max(1800, vr.width * 1.35) &&
                    pr.height <= Math.max(480, vr.height * 1.75);

                if (!inBand || !compact) break;

                best = p;
                node = p;
            }

            if (!seen.has(best)) {
                seen.add(best);
                candidates.push(best);
            }
        }

        const textMatch = Array.from(
            document.querySelectorAll(".game_page_background div")
        ).find(el => {
            if (!isVisible(el) || hero.contains(el)) return false;

            const txt = (el.textContent || "").trim();

            if (!/THIS GAME IS PART OF A SALE EVENT/i.test(txt)) {
                return false;
            }

            const r = el.getBoundingClientRect();

            return (
                r.top >= low - 20 &&
                r.bottom <= high + 40
            );
        });

        if (textMatch) {
            let node = textMatch;

            for (let i = 0; i < 4 && node.parentElement; i++) {
                const p = node.parentElement;

                if (isMajorRoot(p)) break;

                const pr = p.getBoundingClientRect();
                if (pr.height > 500) break;

                node = p;
            }

            if (!seen.has(node)) {
                seen.add(node);
                candidates.unshift(node);
            }
        }

        return candidates.filter((el, i, arr) =>
            !arr.some(
                (other, j) =>
                    j !== i &&
                    other.contains(el)
            )
        );
    }

    /*
      V65: Purchase information has one deterministic home: the RIGHT/AUX rail.

      Older routing intentionally classified the pre-About blocks by their
      contents. That worked for DLC/events, but #game_area_purchase itself did
      not have an explicit rule, so a plain purchase block fell through to the
      left information rail while a purchase block containing DLC/event text
      could land on the right. The result varied by game.

      Keep the test structural. Steam has used a few wrapper variants, but the
      canonical #game_area_purchase container and its purchase descendants are
      much safer signals than localized button text such as "Buy" or
      "Add to Cart".
    */
    /* ---------------------------------------------------------------------
       PURCHASE MODULE ROUTING
       Purchase controls are structurally identified and always pinned to the
       right/AUX lane. No localized "Buy"/"Add to Cart" text is required.
       --------------------------------------------------------------------- */

    function isPurchaseSection(el) {
        if (!el || el.nodeType !== 1) return false;

        if (el.id === "game_area_purchase") return true;

        if (el.matches(
            ".game_area_purchase, " +
            ".game_area_purchase_game_wrapper, " +
            ".game_area_purchase_game"
        )) {
            return true;
        }

        return !!el.querySelector?.(
            "#game_area_purchase, " +
            ".game_area_purchase_game_wrapper, " +
            ".game_area_purchase_game, " +
            ".game_purchase_action"
        );
    }

    function findPurchaseRoot() {
        const canonical = document.getElementById("game_area_purchase");
        if (canonical) return canonical;

        /*
          Fallback for Steam templates that omit the historical id. Prefer the
          nearest purchase-specific wrapper and never climb into a whole
          game_description_column/page wrapper.
        */
        const leaf = document.querySelector(
            ".game_area_purchase_game_wrapper, " +
            ".game_area_purchase_game, " +
            ".game_purchase_action"
        );

        if (!leaf) return null;

        return (
            leaf.closest(".game_area_purchase") ||
            leaf.closest(".game_area_purchase_game_wrapper") ||
            leaf.closest(".game_area_purchase_game") ||
            leaf
        );
    }

    function pinPurchaseToAux(aux) {
        if (!aux) return;

        const purchase = findPurchaseRoot();
        if (!purchase) return;

        if (purchase.parentElement !== aux) {
            /*
              Even if a broader pre-About wrapper was already routed to AUX,
              extract the canonical purchase root itself so its order is fully
              deterministic and unrelated sibling content is left alone.
            */
            moveNode(
                purchase,
                aux,
                "uw65-purchase-section"
            );
        } else {
            purchase.classList.add(
                "uw65-purchase-section"
            );
        }

        /*
          Purchase is the primary action on an app page. Keep it above DLC,
          events, metadata, Steam Deck compatibility, etc., even if a late
          Steam mutation caused one of those blocks to be appended first.
        */
        if (
            purchase.parentElement === aux &&
            aux.firstElementChild !== purchase
        ) {
            aux.prepend(purchase);
        }
    }

    function belongsInAux(el) {
        if (!el) return false;

        const t = normText(el);
        const id = el.id || "";
        const cls = String(el.className || "").toLowerCase();

        /* Purchase never participates in heuristic lane selection. */
        if (isPurchaseSection(el)) return true;

        /* Language-independent structural signals are evaluated first. */
        if (el.matches(".recent_game_events")) return true;

        if (
            id.includes("item") ||
            id.includes("dlc") ||
            cls.includes("item") ||
            cls.includes("dlc") ||
            cls.includes("event")
        ) {
            return true;
        }

        /*
          Last-resort English fallback for optional modules whose Steam markup
          exposes no stable semantic hook. If this fails in another language,
          the module simply remains in its native location.
        */
        if (
            t.includes("content for this game") ||
            t.includes("items available for this game") ||
            t.includes("recent events") ||
            t.includes("recent events & announcements") ||
            t.includes("recent events and announcements") ||
            t.includes("premium edition") ||
            t.includes("join the discord") ||
            t.includes("report bugs and leave feedback") ||
            t.includes("see all discussions")
        ) {
            return true;
        }

        return false;
    }


    /*
      V10: Find Steam's Live / Broadcast module.

      Valve has used several different broadcast wrappers over time, so
      this deliberately does NOT depend on one brittle class name.

      Strong signal:
        - "Show Chat"
        - and either "Share Broadcast", "Now Broadcasting",
          "Now Re-Broadcasting", or a visible "Live" label

      We then climb to the largest compact ancestor that still looks like
      one self-contained broadcast card, without swallowing a page root.
    */
    /* ---------------------------------------------------------------------
       LIVE BROADCAST DISCOVERY
       Steam has several markup variants. Structural/geometry checks do the
       heavy lifting; "Show Chat" is a documented last-resort text fallback.
       --------------------------------------------------------------------- */

    function compactBroadcastAncestor(signal, hero, requireEnglishSignals = false) {
        if (!signal || !isVisible(signal)) return null;

        let node = signal;
        let best = null;

        for (let i = 0; i < 10 && node; i++) {
            if (isMajorRoot(node)) break;

            const rect = node.getBoundingClientRect();
            const compactEnough =
                rect.width > 300 &&
                rect.height > 80 &&
                rect.height < Math.max(1200, window.innerHeight * 0.95) &&
                rect.width < window.innerWidth * 0.80;

            let signalMatches = true;
            if (requireEnglishSignals) {
                const text = normText(node);
                signalMatches =
                    text.includes("show chat") &&
                    (
                        text.includes("share broadcast") ||
                        text.includes("now broadcasting") ||
                        text.includes("now re-broadcasting") ||
                        text.includes("now rebroadcasting") ||
                        /\blive\b/.test(text)
                    );
            }

            if (compactEnough && signalMatches) best = node;
            node = node.parentElement;
        }

        if (!best) return null;

        if (
            document.getElementById(MID_ID)?.contains(best) ||
            document.getElementById(AUX_ID)?.contains(best)
        ) {
            return null;
        }

        if (hero) {
            const broadcastRect = best.getBoundingClientRect();
            const heroRect = hero.getBoundingClientRect();
            if (broadcastRect.top > heroRect.bottom + 300) return null;
        }

        return best;
    }

    function findLiveBroadcast(hero) {
        /*
          Preferred path: semantic id/class/data attributes. Attribute contains
          checks are tolerant of Steam adding prefixes/suffixes to class names.
        */
        const structuralSignals = Array.from(
            document.querySelectorAll(
                "[id*='broadcast' i], " +
                "[class*='broadcast' i], " +
                "[data-feature*='broadcast' i], " +
                "[data-panel*='broadcast' i], " +
                "iframe[src*='broadcast' i]"
            )
        );

        for (const signal of structuralSignals) {
            const candidate = compactBroadcastAncestor(signal, hero, false);
            if (candidate) return candidate;
        }

        /*
          Last-resort English fallback for builds whose broadcast component is
          entirely hash-classed. Failure here is safe: the broadcast stays in
          Steam's native location rather than being guessed from unrelated DOM.
        */
        const showChat = Array.from(
            document.querySelectorAll("button, a, div, span")
        ).find(el => {
            if (!isVisible(el)) return false;
            const text = (el.textContent || "").replace(/\s+/g, " ").trim();
            return /^show chat$/i.test(text);
        });

        return compactBroadcastAncestor(showChat, hero, true);
    }

    /* ---------------------------------------------------------------------
       RESPONSIVE ULTRAWIDE SIZING
       Compute lane widths from viewport size while keeping the media player
       close to its native aspect ratio and leaving comfortable lane gaps.
       --------------------------------------------------------------------- */

    function calculateWidths(hero) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const gap = Math.round(
            Math.min(32, Math.max(18, vw * 0.004))
        );

        const mid = Math.round(
            Math.min(1050, Math.max(620, vw * 0.20))
        );

        const aux = Math.round(
            Math.min(980, Math.max(560, vw * 0.18))
        );

        const playerAspect = 600 / 338;

        const mediaByHeight =
            vh * 0.93 * playerAspect;

        const mediaByWidth =
            (vw * 0.985) -
            mid -
            aux -
            (gap * 2);

        const media = Math.round(
            Math.max(
                1050,
                Math.min(
                    3500,
                    mediaByHeight,
                    mediaByWidth
                )
            )
        );

        const total =
            Math.round(
                media +
                mid +
                aux +
                (gap * 2)
            );

        const lowerGap = Math.round(
            Math.min(42, Math.max(24, vw * 0.005))
        );

        hero.style.setProperty("--uw9-gap", `${gap}px`);
        hero.style.setProperty("--uw9-media", `${media}px`);
        hero.style.setProperty("--uw9-mid", `${mid}px`);
        hero.style.setProperty("--uw9-aux", `${aux}px`);
        hero.style.setProperty("--uw9-total", `${total}px`);
        hero.style.setProperty("--uw9-lower-gap", `${lowerGap}px`);

        document.documentElement.style.setProperty("--uw9-gap", `${gap}px`);
        document.documentElement.style.setProperty("--uw9-media", `${media}px`);
        document.documentElement.style.setProperty("--uw9-mid", `${mid}px`);
        document.documentElement.style.setProperty("--uw9-aux", `${aux}px`);
        document.documentElement.style.setProperty("--uw9-total", `${total}px`);
        document.documentElement.style.setProperty(
            "--uw9-lower-gap",
            `${lowerGap}px`
        );
    }

    /* ---------------------------------------------------------------------
       GENERATED THREE-LANE SHELL
       Creates the middle and right rails adjacent to Steam's native media lane.
       --------------------------------------------------------------------- */

    function ensureTopColumns(hero) {
        let middle = document.getElementById(MID_ID);
        let aux = document.getElementById(AUX_ID);

        if (!middle) {
            middle = document.createElement("div");
            middle.id = MID_ID;
            middle.className = "uw9-column";
            hero.appendChild(middle);
        }

        if (!aux) {
            aux = document.createElement("div");
            aux.id = AUX_ID;
            aux.className = "uw9-column";
            hero.appendChild(aux);
        }

        return { middle, aux };
    }

    /*
      Return a compact ancestor for a text/header match without swallowing
      the full Steam page_content wrapper.
    */
    function usefulSectionAncestor(el) {
        if (!el) return null;

        const preferred = el.closest(
            ".steam_curators_block, " +
            ".recommendation_carousel, " +
            ".game_page_autocollapse, " +
            ".block, " +
            ".responsive_apppage_reviewblock"
        );

        if (preferred && !isMajorRoot(preferred)) {
            return preferred;
        }

        let node = el;

        for (let i = 0; i < 4 && node.parentElement; i++) {
            const p = node.parentElement;

            if (isMajorRoot(p)) break;

            const text = normText(p);

            if (text.length < 25000) {
                node = p;
            } else {
                break;
            }
        }

        return node;
    }

    function findSectionByHeading(regex) {
        const candidates = Array.from(
            document.querySelectorAll(
                "h1, h2, h3, .block_header, .home_page_content_title"
            )
        );

        const h = candidates.find(el =>
            regex.test(
                (el.textContent || "")
                    .replace(/\s+/g, " ")
                    .trim()
            )
        );

        return h ? usefulSectionAncestor(h) : null;
    }

    /* ---------------------------------------------------------------------
       OPTIONAL SECTION FALLBACKS
       findSectionByHeading() is used only when Steam provides no stable class
       for an optional section. If the localized text does not match, the
       theme leaves that optional module in Steam's native location rather than
       guessing and moving the wrong content.
       --------------------------------------------------------------------- */

    /* =====================================================================
       INDEPENDENT CONTINUATION LANE HELPERS
       ===================================================================== */

    const LEFT_CONT_ID = "uw11-left-continuation";
    const MID_CONT_ID = "uw11-mid-continuation";
    const AUX_CONT_ID = "uw11-aux-continuation";

    function ensureContinuation(parent, id) {
        let c = document.getElementById(id);

        if (!c) {
            c = document.createElement("div");
            c.id = id;
            c.className = "uw11-continuation";
            parent.appendChild(c);
        } else if (c.parentElement !== parent) {
            parent.appendChild(c);
        }

        return c;
    }

    function elementHeight(el) {
        if (!el) return 0;
        const r = el.getBoundingClientRect();
        return Math.max(r.height, el.scrollHeight || 0);
    }

    /*
      Choose the currently shorter information lane.

      This is intentionally evaluated AFTER Steam's main top modules have
      been moved. A game with a giant live broadcast may have a much taller
      middle lane; in that case reviews/curators automatically go right.
      Another game may have lots of DLC/events in the right lane, causing
      reviews to remain in the middle.

      This is the dynamic "fill the hole" behavior requested for 32:9.
    */
    function shorterInfoContinuation(mid, aux, midCont, auxCont) {
        const midH = elementHeight(mid);
        const auxH = elementHeight(aux);

        return midH <= auxH
            ? midCont
            : auxCont;
    }


    /* =====================================================================
       CUSTOMER REVIEWS — REACT-SAFE NATIVE VIEWPORT
       =====================================================================

       Steam owns the review filters and native review cards through React.
       Reparenting individual cards breaks React reconciliation when a filter
       changes. This theme therefore moves only ONE outer review root and never
       changes the parent/child relationships inside that root.

       The outer review root is placed inside a tall, independently scrollable
       viewport. Near the bottom we wake Steam's own loader when one exists.
       A separate theme-owned continuation can request more reviews from Steam's
       same-origin /appreviews endpoint without inserting nodes into React's tree.
       ===================================================================== */

    function findReviewRoot() {
        const hash = document.querySelector("#app_reviews_hash");
        if (!hash) return null;

        return (
            hash.closest(
                ".review_ctn, " +
                ".responsive_apppage_reviewblock, " +
                ".app_reviews_area, " +
                ".user_reviews_container"
            ) ||
            hash
        );
    }

    function ensureReviewSection(hero) {
        let section = document.getElementById("uw-review-section");
        let viewport = document.getElementById("uw-review-viewport");
        let sentinel = document.getElementById("uw-review-sentinel");

        if (!section) {
            section = document.createElement("section");
            section.id = "uw-review-section";
            generated.add(section);

            viewport = document.createElement("div");
            viewport.id = "uw-review-viewport";

            sentinel = document.createElement("div");
            sentinel.id = "uw-review-sentinel";
            sentinel.setAttribute("aria-hidden", "true");

            viewport.appendChild(sentinel);
            section.appendChild(viewport);
            hero.insertAdjacentElement("afterend", section);
        } else {
            if (!viewport) {
                viewport = document.createElement("div");
                viewport.id = "uw-review-viewport";
                section.appendChild(viewport);
            }

            if (!sentinel) {
                sentinel = document.createElement("div");
                sentinel.id = "uw-review-sentinel";
                sentinel.setAttribute("aria-hidden", "true");
                viewport.appendChild(sentinel);
            }
        }

        return { section, viewport, sentinel };
    }

    function elementIsVisible(el) {
        if (!el || !el.isConnected) return false;

        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
            return false;
        }

        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }


    /* =====================================================================
       CUSTOMER REVIEWS — PINNED NATIVE HEADER / FILTERS
       =====================================================================

       The user-facing goal is stronger than ordinary CSS "sticky": the
       review title/summary/filter chrome must stay visually frozen at the top
       while ONLY the review stream appears to move underneath it.

       Why v69 failed on some games:
       --------------------------------
       Some Steam review templates render the filter controls as siblings above
       #app_reviews_hash. v69 limited discovery to descendants of that hash, so
       it could return no candidate at all. In addition, Steam occasionally
       places overflow/contain rules on wrappers that can break position:sticky.

       v72 fixes both problems without moving React-owned children:
         1. Discover controls across the complete native review root.
         2. Find their compact common header ancestor by geometry/structure.
         3. Keep that existing element pinned with one transform update per RAF
            while the existing #uw-review-viewport scrolls.

       No header/filter node is cloned, wrapped, removed, or reparented. Steam
       keeps full React ownership and all native dropdown event handlers.
       Discovery remains language-independent; visible labels are not required.
       ===================================================================== */

    function reviewFilterAnchors(root) {
        if (!root) return [];

        /*
          Semantic controls are still the preferred path when Steam exposes
          them. These selectors do not depend on the displayed language.
        */
        const selector = [
            ".user_reviews_filter_options",
            ".review_filter",
            "[id*='review_filter']",
            "select",
            "[role='combobox']",
            "[aria-haspopup='listbox']",
            "[aria-haspopup='menu']",
            "input[type='radio']",
            "input[type='checkbox']"
        ].join(", ");

        return Array.from(root.querySelectorAll(selector)).filter(el => {
            if (!elementIsVisible(el)) return false;

            /* Never mistake controls inside an individual review card for filters. */
            return !el.closest(
                ".review_box, " +
                "[id^='ReviewContent'], " +
                "[id^='Review']:not(#app_reviews_hash)"
            );
        });
    }

    function commonAncestorWithin(elements, boundary) {
        if (!elements.length || !boundary) return null;

        let node = elements[0];
        while (node && node !== boundary.parentElement) {
            if (
                boundary.contains(node) &&
                elements.every(el => node === el || node.contains(el))
            ) {
                return node;
            }
            if (node === boundary) break;
            node = node.parentElement;
        }

        return boundary;
    }

    /*
      REVIEW-CARD DISCOVERY

      The current Steam review UI often uses generated class names, so V73 does
      not make its primary boundary decision from English labels or one hashed
      class. We first try long-lived review hooks, then use the presence of a
      Steam Community profile link inside a card as a language-neutral signal.
    */
    function findFirstNativeReviewCard(root) {
        if (!root) return null;

        const rootRect = root.getBoundingClientRect();

        const known = Array.from(
            root.querySelectorAll(
                ".review_box, " +
                "[id^='ReviewContent'], " +
                "[id^='Review']:not(#app_reviews_hash)"
            )
        )
            .filter(elementIsVisible)
            .sort(
                (a, b) =>
                    a.getBoundingClientRect().top -
                    b.getBoundingClientRect().top
            );

        if (known.length) return known[0];

        const profileLinks = Array.from(
            root.querySelectorAll(
                "a[href*='steamcommunity.com/id/'], " +
                "a[href*='steamcommunity.com/profiles/'], " +
                "a[href^='/id/'], a[href^='/profiles/'], " +
                "[data-miniprofile]"
            )
        ).filter(elementIsVisible);

        const cardCandidates = [];

        for (const link of profileLinks) {
            let node = link;

            while (
                node &&
                node.parentElement &&
                node.parentElement !== root
            ) {
                const rect = node.getBoundingClientRect();

                /*
                  Review cards in the ultrawide view are substantial blocks.
                  Stop at the smallest useful ancestor instead of swallowing an
                  entire stream/column.
                */
                if (
                    rect.height >= 90 &&
                    rect.height <= 1100 &&
                    rect.width >= rootRect.width * 0.22
                ) {
                    cardCandidates.push(node);
                    break;
                }

                node = node.parentElement;
            }
        }

        if (!cardCandidates.length) return null;

        cardCandidates.sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();

            if (ar.top !== br.top) return ar.top - br.top;
            return ar.height - br.height;
        });

        return cardCandidates[0];
    }

    /*
      V80: Writing the same inline CSS custom property still produces a style
      attribute mutation in Chromium. Because the review root is observed, the
      old code could trigger itself continuously: pin update -> style mutation
      -> observer -> pin update. Only write when the value actually changes.
    */
    function setInlineStylePropertyIfChanged(element, name, value) {
        if (!element) return false;
        if (element.style.getPropertyValue(name) === value) return false;
        element.style.setProperty(name, value);
        return true;
    }

    /*
      V79 REVIEW-GRAPH DISCOVERY / PIN COVERAGE

      Steam's histogram is not guaranteed to be mounted at the same time as the
      rest of the review header. It may already exist with zero geometry, become
      visible through style/class changes, or be inserted later by React.

      Treat any large semantic role=img block that appears before the first
      native review card as review-header graphics. No localized aria-label or
      visible text is inspected. This is intentionally broader than V78's
      childList-only detector so a graph that becomes visible without a DOM
      insertion is still discovered.
    */
    function visiblePreReviewGraphs(root) {
        if (!root) return [];

        const firstCard = findFirstNativeReviewCard(root);
        const firstCardTop = firstCard
            ? firstCard.getBoundingClientRect().top
            : Number.POSITIVE_INFINITY;
        const rootRect = root.getBoundingClientRect();
        const minWidth = Math.max(220, rootRect.width * 0.18);

        return Array.from(root.querySelectorAll("[role='img']"))
            .filter(graph => {
                if (!elementIsVisible(graph)) return false;

                const rect = graph.getBoundingClientRect();
                if (rect.width < minWidth) return false;
                if (rect.height < 90 || rect.height > 900) return false;

                /* Header graphics must precede the first actual review card. */
                if (firstCard && rect.top >= firstCardTop + 24) return false;

                return true;
            });
    }

    /*
      Return the highest safe branch that contains a graph but does NOT contain
      the first review card. Pinning that branch keeps the graph's background,
      bars and companion 30-day panel together instead of translating only an
      inner drawing node.
    */
    function preReviewBranchForNode(node, root, firstCard) {
        if (!node || !root || !root.contains(node)) return null;

        let branch = node;

        while (branch.parentElement && branch.parentElement !== root) {
            const parent = branch.parentElement;

            if (
                firstCard &&
                (parent === firstCard || parent.contains(firstCard))
            ) {
                break;
            }

            branch = parent;
        }

        if (branch === root) return null;
        if (firstCard && branch.contains(firstCard)) return null;

        return branch;
    }

    /* Keep pinned branches disjoint so nested elements never receive the same
       inverse-scroll transform twice. Prefer the outer safe ancestor. */
    function normalizePinnedReviewPieces(candidates, root, firstCard) {
        const list = Array.from(new Set(candidates))
            .filter(el =>
                el &&
                el !== root &&
                el.isConnected &&
                root.contains(el) &&
                (elementIsVisible(el) || knownReviewGraphBranches.has(el)) &&
                !(firstCard && el.contains(firstCard))
            );

        return list
            .filter(el =>
                !list.some(other =>
                    other !== el &&
                    other.contains(el) &&
                    !(firstCard && other.contains(firstCard))
                )
            )
            .sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                if (ar.top !== br.top) return ar.top - br.top;
                return ar.left - br.left;
            });
    }

    /*
      A visible pre-review graph MUST be contained by one of the cached pinned
      pieces. If not, the opaque backing plate can cover it even at scrollTop=0,
      or the graph can scroll above the viewport while the rest of the header is
      frozen. This invariant check is cheap and makes late/style-only graph
      mounts deterministic.
    */
    function reviewGraphPinCoverageNeedsRediscovery(root) {
        if (!root || !pinnedReviewPieces.length) return false;

        const graphs = visiblePreReviewGraphs(root);
        if (!graphs.length) return false;

        return graphs.some(graph =>
            !pinnedReviewPieces.some(piece =>
                piece === graph || piece.contains(graph)
            )
        );
    }

    /*
      PRE-REVIEW CHROME DISCOVERY

      Starting at the first review card, walk toward the native review root.
      Every visible preceding sibling along that path is a separate DOM branch
      that appears before the actual review stream. This naturally captures
      Steam's title/summary/filter/filter-chip rows even when React splits them
      into unrelated generated DIV wrappers.

      Crucially, the resulting branches are disjoint siblings, not parent/child
      duplicates, so applying the same inverse scroll transform to each block
      keeps the whole header together without double-moving anything.
    */
    function collectPreReviewChromePieces(root, viewport) {
        if (!root || !viewport) return [];

        const firstCard = findFirstNativeReviewCard(root);
        const rootRect = root.getBoundingClientRect();

        if (!firstCard) {
            /*
              Fallback for unusual templates with no discoverable profile/card.
              Semantic controls can still identify one compact header ancestor.
            */
            const anchors = reviewFilterAnchors(root);
            if (anchors.length) {
                const one = commonAncestorWithin(anchors, root);
                return one && one !== root ? [one] : [];
            }
            return [];
        }

        const firstCardRect = firstCard.getBoundingClientRect();
        const maxChromeBottom =
            rootRect.top +
            Math.min(
                560,
                Math.max(360, viewport.clientHeight * 0.42)
            );

        const collected = new Set();
        let pathNode = firstCard;

        while (pathNode && pathNode !== root) {
            let sibling = pathNode.previousElementSibling;

            while (sibling) {
                if (elementIsVisible(sibling)) {
                    const rect = sibling.getBoundingClientRect();

                    if (
                        rect.bottom <= firstCardRect.top + 24 &&
                        rect.top < firstCardRect.top &&
                        rect.top < maxChromeBottom
                    ) {
                        /*
                          Avoid grabbing a preceding review card from a masonry
                          stream. Profile links are a language-neutral review
                          signal; long-lived review hooks cover older templates.
                        */
                        const containsReviewSignal =
                            sibling.matches(
                                ".review_box, " +
                                "[id^='ReviewContent'], " +
                                "[id^='Review']:not(#app_reviews_hash)"
                            ) ||
                            !!sibling.querySelector(
                                ".review_box, " +
                                "[id^='ReviewContent'], " +
                                "[id^='Review']:not(#app_reviews_hash), " +
                                "a[href*='steamcommunity.com/id/'], " +
                                "a[href*='steamcommunity.com/profiles/'], " +
                                "a[href^='/id/'], a[href^='/profiles/'], " +
                                "[data-miniprofile]"
                            );

                        if (!containsReviewSignal) {
                            collected.add(sibling);
                        }
                    }
                }

                sibling = sibling.previousElementSibling;
            }

            pathNode = pathNode.parentElement;
        }

        /*
          V79: Explicitly include any large pre-review graph branch even when
          Steam mounted it outside the generic geometry window. This closes the
          case where the graph existed but was left underneath our backdrop.
        */
        for (const graph of visiblePreReviewGraphs(root)) {
            const branch = preReviewBranchForNode(graph, root, firstCard);
            if (branch) {
                knownReviewGraphBranches.add(branch);
                branch.setAttribute("data-uw-review-graph-branch", "1");
                collected.add(branch);
            }
        }

        /*
          A collapsed histogram can have zero geometry and no visible role=img
          descendants. Keep its already-known native wrapper in the candidate
          set so Hide graph -> Show graph never loses the branch merely because
          Steam made it temporarily invisible.
        */
        for (const branch of Array.from(knownReviewGraphBranches)) {
            if (!branch?.isConnected || !root.contains(branch)) {
                knownReviewGraphBranches.delete(branch);
                continue;
            }
            if (firstCard && branch.contains(firstCard)) continue;
            collected.add(branch);
        }

        return normalizePinnedReviewPieces(
            Array.from(collected),
            root,
            firstCard
        );
    }

    function ensureReviewPinBackdrop(viewport) {
        if (!viewport) return null;

        let backdrop =
            viewport.querySelector(":scope > #uw-review-pin-backdrop");

        if (!backdrop) {
            backdrop = document.createElement("div");
            backdrop.id = "uw-review-pin-backdrop";
            backdrop.setAttribute("aria-hidden", "true");
            viewport.prepend(backdrop);
        }

        pinnedReviewBackdrop = backdrop;
        return backdrop;
    }

    function clearPinnedReviewHeader(viewport) {
        if (!viewport) return;

        viewport.querySelectorAll(".uw-review-pinned-piece").forEach(el => {
            el.classList.remove("uw-review-pinned-piece");
            el.removeAttribute("data-uw-review-pinned");
            el.removeAttribute("data-uw-review-pin-source");
            el.style.removeProperty("--uw-review-pin-y");
        });

        viewport.querySelectorAll(".uw-review-pin-chain").forEach(el => {
            el.classList.remove("uw-review-pin-chain");
        });

        const backdrop =
            viewport.querySelector(":scope > #uw-review-pin-backdrop");
        if (backdrop) {
            backdrop.style.removeProperty("--uw-review-pin-y");
            backdrop.style.removeProperty("--uw-review-pin-h");
            backdrop.hidden = true;
        }

        /* V76: clear the live scroll-padding/backdrop height as well. */
        viewport.style.removeProperty("--uw-review-pin-h");

        pinnedReviewPieces = [];
        pinnedReviewChromeHeight = 0;
    }

    function pinnedPiecesStillValid(root) {
        return (
            pinnedReviewPieces.length > 0 &&
            pinnedReviewPieces.every(
                piece =>
                    piece &&
                    piece.isConnected &&
                    root.contains(piece)
            )
        );
    }

    /*
      V76 LIVE PIN HEIGHT

      Steam's graph toggle changes #review_histograms_container between the
      expanded and collapsed states without replacing the review tree. V73-V75
      cached the backing-plate height from the expanded state, so after
      "Hide graph" the oversized plate could continue covering reviews and
      look like a large empty gap.

      Re-measure the *painted* pinned chrome after its inverse-scroll transform
      has been applied. When the native histogram is collapsed, descendants of
      that collapsed histogram are intentionally ignored for the plate-height
      calculation; the summary/filter rows below still define the true visible
      bottom edge. This uses Steam's structural IDs/classes, not localized text.
    */
    function measurePinnedReviewChromeHeight(viewport, root) {
        if (!viewport || !root) return 0;

        const viewportRect = viewport.getBoundingClientRect();
        const collapsedHistogram = root.querySelector(
            "#review_histograms_container.collapsed"
        );

        let chromeBottom = 0;
        let fallbackBottom = 0;

        for (const piece of pinnedReviewPieces) {
            if (!piece || !piece.isConnected || !elementIsVisible(piece)) {
                continue;
            }

            const rect = piece.getBoundingClientRect();
            const bottom = rect.bottom - viewportRect.top;
            fallbackBottom = Math.max(fallbackBottom, bottom);

            if (
                collapsedHistogram &&
                (piece === collapsedHistogram || collapsedHistogram.contains(piece))
            ) {
                continue;
            }

            chromeBottom = Math.max(chromeBottom, bottom);
        }

        /*
          Current Steam templates expose this stable structural hook whenever
          the histogram has been collapsed. Its bottom is the most reliable
          boundary for the filter chrome and eliminates the stale graph gap.
        */
        const collapsedFilters = root.querySelector(
            "#reviews_filter_options.graph_collapsed, " +
            ".user_reviews_filter_options.graph_collapsed"
        );
        if (collapsedFilters && elementIsVisible(collapsedFilters)) {
            const rect = collapsedFilters.getBoundingClientRect();
            chromeBottom = Math.max(
                chromeBottom,
                rect.bottom - viewportRect.top
            );
        }

        if (chromeBottom <= 0) chromeBottom = fallbackBottom;

        return Math.min(
            Math.max(80, chromeBottom),
            Math.max(320, viewport.clientHeight * 0.48)
        );
    }

    function updatePinnedReviewHeader(viewport, root) {
        if (
            !viewport ||
            !root ||
            !viewport.isConnected ||
            !root.isConnected ||
            !pinnedPiecesStillValid(root)
        ) {
            return;
        }

        /*
          Every pinned block keeps its normal layout slot. Translating the
          painted blocks by +scrollTop exactly cancels the internal viewport's
          -scrollTop movement, so the native controls remain at their original
          screen position from the first pixel of review scrolling.
        */
        const pinY = viewport.scrollTop;
        const value = `${Math.round(pinY * 100) / 100}px`;

        for (const piece of pinnedReviewPieces) {
            setInlineStylePropertyIfChanged(
                piece,
                "--uw-review-pin-y",
                value
            );
        }

        /*
          Measure AFTER setting the transform. This makes the result represent
          the actual visible bottom of the frozen chrome, independent of the
          current internal scrollTop.
        */
        pinnedReviewChromeHeight = measurePinnedReviewChromeHeight(
            viewport,
            root
        );
        const pinHeightValue = `${Math.ceil(pinnedReviewChromeHeight)}px`;
        setInlineStylePropertyIfChanged(
            viewport,
            "--uw-review-pin-h",
            pinHeightValue
        );

        if (pinnedReviewBackdrop) {
            pinnedReviewBackdrop.hidden = false;
            setInlineStylePropertyIfChanged(
                pinnedReviewBackdrop,
                "--uw-review-pin-y",
                value
            );
            setInlineStylePropertyIfChanged(
                pinnedReviewBackdrop,
                "--uw-review-pin-h",
                pinHeightValue
            );
        }
    }

    function syncStickyReviewHeader(root, viewport, force = false) {
        if (!root || !viewport) return;

        /*
          V72 re-ran geometry discovery on every React mutation. Once a block
          had been translated, its getBoundingClientRect() no longer resembled
          the original header geometry, so a later mutation could make the
          detector lose it. V73 caches the chosen native branches and re-detects
          only if Steam truly replaces one of them.
        */
        /*
          V79: Valid cached pieces are not sufficient if Steam has since made a
          graph visible outside those pieces. Enforce graph coverage before the
          normal cached fast path. This catches child insertion, style-only
          reveal and zero-size-to-full-size layout transitions alike.
        */
        if (
            !force &&
            pinnedPiecesStillValid(root) &&
            !reviewGraphPinCoverageNeedsRediscovery(root)
        ) {
            updatePinnedReviewHeader(viewport, root);
            return;
        }

        clearPinnedReviewHeader(viewport);

        const pieces = collectPreReviewChromePieces(root, viewport);
        if (!pieces.length) return;

        for (const piece of pieces) {
            piece.classList.add("uw-review-pinned-piece");
            piece.setAttribute("data-uw-review-pinned", "1");
            piece.setAttribute(
                "data-uw-review-pin-source",
                "pre-review-tree"
            );
            setInlineStylePropertyIfChanged(
                piece,
                "--uw-review-pin-y",
                "0px"
            );

            if (knownReviewGraphBranches.has(piece)) {
                piece.setAttribute("data-uw-review-graph-branch", "1");
            }

            let ancestor = piece.parentElement;
            while (ancestor && ancestor !== viewport) {
                ancestor.classList.add("uw-review-pin-chain");
                ancestor = ancestor.parentElement;
            }
        }

        pinnedReviewPieces = pieces;

        /*
          V76 no longer trusts a one-time cached height here. The live update
          below measures the actual painted header on every relevant mutation
          and review-scroll frame, so graph expand/collapse cannot leave a stale
          backing-plate gap.
        */
        pinnedReviewChromeHeight = 0;

        ensureReviewPinBackdrop(viewport);
        updatePinnedReviewHeader(viewport, root);
    }

    /*
      Prefer Steam's structural loader hooks. The visible-English check is only
      a last-resort compatibility fallback for templates without those hooks.
    */
    function findNativeMoreReviewsControl(root) {
        if (!root) return null;

        const known = root.querySelector(
            "#LoadMoreReviewsall, " +
            "[id^='LoadMoreReviews'], " +
            ".load_more_reviews_btn, " +
            ".load_more_reviews, " +
            "[data-panel*='LoadMoreReviews']"
        );

        if (known && elementIsVisible(known)) return known;

        return Array.from(
            root.querySelectorAll("button, a, [role='button']")
        ).find(el => {
            if (!elementIsVisible(el)) return false;

            const text = (el.textContent || "")
                .replace(/\s+/g, " ")
                .trim();

            /* Language-specific fallback only. */
            return /^(?:Load More|Load More Reviews|More Reviews|Show More Reviews)$/i.test(text);
        }) || null;
    }

    /* =====================================================================
       CUSTOMER REVIEWS — FULL-REVIEWS DESTINATION
       =====================================================================

       The theme's primary action is "See More Reviews", but Millennium's
       usability rules discourage removing native core functionality. We keep
       Steam's original full-reviews destination available as a secondary
       "Open Full Reviews" link.

       Detection is URL/structure-first. English text is only the final fallback.
       ===================================================================== */

    function getAppId() {
        const match = location.pathname.match(/\/app\/(\d+)/i);
        return match ? match[1] : "";
    }

    function isFullReviewsHref(href, appid) {
        if (!href || !appid) return false;

        try {
            const url = new URL(href, location.href);
            const path = url.pathname.replace(/\/+$/, "").toLowerCase();
            const expected = `/app/${appid}/reviews`;
            return path === expected || path.endsWith(expected);
        } catch (_) {
            return false;
        }
    }

    function findFullReviewsControl(root) {
        if (!root) return null;

        const appid = getAppId();
        const anchors = Array.from(root.querySelectorAll("a[href]"));

        /* Most robust signal: destination URL for this app's full reviews. */
        const byHref = anchors.find(a =>
            isFullReviewsHref(a.getAttribute("href") || a.href, appid)
        );
        if (byHref) return byHref;

        /* Stable/semantic class and data hooks used by older Steam templates. */
        const byStructure = root.querySelector(
            "a.view_all_reviews_btn[href], " +
            "a[class*='view_all_reviews'][href], " +
            "a[data-panel*='ViewAllReviews'][href]"
        );
        if (byStructure) return byStructure;

        /* Last-resort English fallback for an unknown Steam template. */
        return anchors.find(a => {
            const text = (a.textContent || "")
                .replace(/\s+/g, " ")
                .trim();
            return /^Browse All Reviews$/i.test(text);
        }) || null;
    }

    function apiLanguageFromLocale(locale) {
        const key = String(locale || "")
            .toLowerCase()
            .replace(/_/g, "-");

        const table = {
            "en": "english", "en-us": "english", "en-gb": "english",
            "de": "german", "fr": "french", "it": "italian",
            "es": "spanish", "es-es": "spanish", "es-419": "latam",
            "pt": "portuguese", "pt-pt": "portuguese", "pt-br": "brazilian",
            "ru": "russian", "pl": "polish", "tr": "turkish",
            "ja": "japanese", "ko": "koreana",
            "zh-cn": "schinese", "zh-sg": "schinese",
            "zh-tw": "tchinese", "zh-hk": "tchinese",
            "th": "thai", "uk": "ukrainian", "cs": "czech",
            "da": "danish", "nl": "dutch", "fi": "finnish",
            "no": "norwegian", "sv": "swedish", "hu": "hungarian",
            "ro": "romanian", "bg": "bulgarian", "el": "greek",
            "vi": "vietnamese", "id": "indonesian"
        };

        if (table[key]) return table[key];
        return table[key.split("-")[0]] || "english";
    }

    /*
      Read checked/selected controls using machine-facing attributes only.
      This is a localization-safe fallback when Steam's full-reviews URL does
      not contain every active filter parameter.
    */
    function selectedMachineControls(root) {
        if (!root) return [];

        const selected = root.querySelectorAll(
            "input:checked, option:checked, select, " +
            "[aria-checked='true'], [aria-selected='true']"
        );

        return Array.from(selected).map(el => ({
            key: [
                el.getAttribute("name"),
                el.id,
                el.getAttribute("data-name"),
                el.getAttribute("data-filter"),
                el.getAttribute("data-param")
            ].filter(Boolean).join(" ").toLowerCase(),
            value: [
                el.value,
                el.getAttribute("value"),
                el.getAttribute("data-value"),
                el.getAttribute("data-option"),
                el.getAttribute("data-filter-value")
            ].filter(Boolean).join(" ").toLowerCase()
        }));
    }

    function machineValue(controls, keyRegex) {
        const match = controls.find(item => keyRegex.test(item.key));
        return match ? match.value : "";
    }

    /* =====================================================================
       CUSTOMER REVIEWS — FILTER STATE
       =====================================================================

       Query parameters from Steam's own full-reviews link are the primary
       source because they are language-independent. Selected input values are
       the structural fallback. We do not depend on localized labels such as
       "Positive", "Steam Purchasers", or "All Languages".
       ===================================================================== */

    function getReviewState(root) {
        const appid = getAppId();
        const fullReviews = findFullReviewsControl(root);

        let href = "";
        if (fullReviews?.href) href = fullReviews.href;
        else if (fullReviews?.getAttribute) href = fullReviews.getAttribute("href") || "";

        let query = new URLSearchParams();
        try {
            if (href) query = new URL(href, location.href).searchParams;
        } catch (_) {
            /* The defaults below are deliberately safe. */
        }

        const controls = selectedMachineControls(root);

        const browseFilter = (
            query.get("browsefilter") ||
            query.get("filter") ||
            machineValue(controls, /(?:^|\s)(?:browse)?filter(?:\s|$)/) ||
            "all"
        ).toLowerCase();

        let filter = "all";
        if (/recent|newest|mostrecent/.test(browseFilter)) filter = "recent";
        else if (/updated/.test(browseFilter)) filter = "updated";

        let reviewType = (
            query.get("filterReview") ||
            query.get("review_type") ||
            machineValue(controls, /review[_ -]?type|filterreview/) ||
            "all"
        ).toLowerCase();

        if (!/^(all|positive|negative)$/.test(reviewType)) reviewType = "all";

        let purchaseType = (
            query.get("filterPurchaseType") ||
            query.get("purchase_type") ||
            machineValue(controls, /purchase[_ -]?type|filterpurchasetype/) ||
            "all"
        ).toLowerCase();

        if (/other|non[_ -]?steam/.test(purchaseType)) {
            purchaseType = "non_steam_purchase";
        } else if (/steam/.test(purchaseType) && purchaseType !== "all") {
            purchaseType = "steam";
        } else if (!/^(all|steam|non_steam_purchase)$/.test(purchaseType)) {
            purchaseType = "all";
        }

        let language = (
            query.get("filterLanguage") ||
            query.get("language") ||
            machineValue(controls, /filterlanguage|(?:^|\s)language(?:\s|$)/) ||
            ""
        ).toLowerCase();

        if (!language || language === "default") {
            language = apiLanguageFromLocale(
                document.documentElement.lang || navigator.language
            );
        }

        let dayRange = (
            query.get("day_range") ||
            query.get("dayrange") ||
            machineValue(controls, /day[_ -]?range|daterange/) ||
            "9223372036854775807"
        );

        if (!/^\d+$/.test(dayRange)) dayRange = "9223372036854775807";

        return {
            appid,
            href,
            filter,
            language,
            reviewType,
            purchaseType,
            dayRange
        };
    }

    function reviewStateSignature(state) {
        return [
            state.appid,
            state.filter,
            state.language,
            state.reviewType,
            state.purchaseType,
            state.dayRange
        ].join("|");
    }

    /* =====================================================================
       CUSTOMER REVIEWS — THEME-OWNED CONTINUATION CONTROLS
       =====================================================================

       These nodes live OUTSIDE Steam's React root. "See More Reviews" appends
       another cursor batch to the theme-owned grid. "Open Full Reviews" keeps
       Steam's original full-reviews destination available at all times.
       ===================================================================== */

    function ensureReviewContinuation(viewport, sentinel) {
        let extra = document.getElementById("uw-extra-reviews");
        let controls = document.getElementById("uw-review-controls");
        let button = document.getElementById("uw-see-more-reviews");
        let fullLink = document.getElementById("uw-open-full-reviews");
        let status = document.getElementById("uw-review-status");

        if (!extra) {
            extra = document.createElement("div");
            extra.id = "uw-extra-reviews";
            generated.add(extra);
        }

        if (!controls) {
            controls = document.createElement("div");
            controls.id = "uw-review-controls";
            generated.add(controls);

            button = document.createElement("button");
            button.id = "uw-see-more-reviews";
            button.type = "button";
            button.textContent = "See More Reviews";

            fullLink = document.createElement("a");
            fullLink.id = "uw-open-full-reviews";
            fullLink.textContent = "Open Full Reviews";

            status = document.createElement("span");
            status.id = "uw-review-status";
            status.setAttribute("aria-live", "polite");

            controls.append(button, fullLink, status);
        }

        button ||= controls.querySelector("#uw-see-more-reviews");
        fullLink ||= controls.querySelector("#uw-open-full-reviews");
        status ||= controls.querySelector("#uw-review-status");

        if (extra.parentElement !== viewport) {
            viewport.insertBefore(extra, sentinel || null);
        }

        if (controls.parentElement !== viewport) {
            viewport.insertBefore(controls, sentinel || null);
        } else if (sentinel && controls.nextElementSibling !== sentinel) {
            viewport.insertBefore(controls, sentinel);
        }

        return { extra, controls, button, fullLink, status };
    }

    function resetReviewContinuation(extra, button, status, signature) {
        extra?.replaceChildren();

        reviewCursor = "*";
        reviewFilterSignature = signature || "";
        reviewLoading = false;
        reviewExhausted = false;
        seenReviewCursors.clear();
        seenRecommendationIds.clear();

        if (button) {
            button.disabled = false;
            button.textContent = "See More Reviews";
        }

        if (status) status.textContent = "";
    }

    function normalizeReviewText(text) {
        return String(text || "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .replace(/[^\p{L}\p{N}\s]/gu, "")
            .trim();
    }

    function reviewFingerprint(text) {
        const normalized = normalizeReviewText(text);
        return normalized.length >= 50 ? normalized.slice(0, 110) : "";
    }

    function formatHours(minutes) {
        const value = Number(minutes || 0);
        return (value / 60).toLocaleString(undefined, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1
        });
    }

    function formatReviewDate(timestamp) {
        const value = Number(timestamp || 0);
        if (!value) return "";

        try {
            return new Date(value * 1000).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric"
            });
        } catch (_) {
            return "";
        }
    }

    function buildReviewCard(review) {
        const card = document.createElement("article");
        card.className = "uw-extra-review-card";

        const head = document.createElement("div");
        head.className = "uw-review-head";

        const profile = document.createElement("a");
        profile.className = "uw-review-profile";
        profile.textContent = "Steam User";
        profile.href = `https://steamcommunity.com/profiles/${review?.author?.steamid || ""}`;

        const verdict = document.createElement("span");
        verdict.className = review?.voted_up
            ? "uw-review-verdict positive"
            : "uw-review-verdict negative";
        verdict.textContent = review?.voted_up ? "Recommended" : "Not Recommended";

        head.append(profile, verdict);

        const meta = document.createElement("div");
        meta.className = "uw-review-meta";

        const parts = [];
        if (review?.author?.playtime_forever != null) {
            parts.push(`${formatHours(review.author.playtime_forever)} hrs on record`);
        }

        const date = formatReviewDate(review?.timestamp_created);
        if (date) parts.push(`Posted ${date}`);
        if (review?.received_for_free) parts.push("Product received for free");
        if (review?.written_during_early_access) parts.push("Early Access review");
        meta.textContent = parts.join(" • ");

        const body = document.createElement("div");
        body.className = "uw-review-body";
        body.textContent = review?.review || "";

        const foot = document.createElement("div");
        foot.className = "uw-review-foot";

        const votes = [];
        if (Number(review?.votes_up || 0) > 0) {
            votes.push(`${Number(review.votes_up).toLocaleString()} helpful`);
        }
        if (Number(review?.votes_funny || 0) > 0) {
            votes.push(`${Number(review.votes_funny).toLocaleString()} funny`);
        }
        foot.textContent = votes.join(" • ");

        card.append(head, meta, body, foot);
        return card;
    }

    /*
      Fetches only JSON data from Steam's SAME ORIGIN. No foreign executable
      JavaScript/CSS is loaded and no user data is sent to a third party.
    */
    async function loadMoreReviews(root, viewport, sentinel) {
        if (reviewLoading || reviewExhausted) return;

        const state = getReviewState(root);
        if (!state.appid) return;

        const signature = reviewStateSignature(state);
        const { extra, button, status } = ensureReviewContinuation(viewport, sentinel);

        if (reviewFilterSignature !== signature) {
            resetReviewContinuation(extra, button, status, signature);
        }

        reviewLoading = true;
        button.disabled = true;
        button.textContent = "Loading Reviews…";
        status.textContent = "";

        const nativeText = normalizeReviewText(root.textContent || "");
        let added = 0;
        let attempts = 0;

        try {
            while (added === 0 && attempts < 4 && !reviewExhausted) {
                attempts += 1;

                const cursor = reviewCursor || "*";
                if (seenReviewCursors.has(cursor)) {
                    reviewExhausted = true;
                    break;
                }
                seenReviewCursors.add(cursor);

                const params = new URLSearchParams({
                    json: "1",
                    filter: state.filter,
                    language: state.language,
                    day_range: state.dayRange,
                    review_type: state.reviewType,
                    purchase_type: state.purchaseType,
                    num_per_page: "40",
                    cursor
                });

                const response = await fetch(
                    `/appreviews/${encodeURIComponent(state.appid)}?${params.toString()}`,
                    {
                        method: "GET",
                        credentials: "same-origin",
                        headers: { "Accept": "application/json" }
                    }
                );

                if (!response.ok) {
                    throw new Error(`Steam reviews request failed (${response.status})`);
                }

                const data = await response.json();
                const reviews = Array.isArray(data?.reviews) ? data.reviews : [];
                const nextCursor = String(data?.cursor || "");
                reviewCursor = nextCursor;

                if (!reviews.length || !nextCursor) reviewExhausted = true;

                const fragment = document.createDocumentFragment();

                for (const review of reviews) {
                    const id = String(review?.recommendationid || "");
                    if (id && seenRecommendationIds.has(id)) continue;
                    if (id) seenRecommendationIds.add(id);

                    const fingerprint = reviewFingerprint(review?.review);
                    if (fingerprint && nativeText.includes(fingerprint)) continue;

                    fragment.appendChild(buildReviewCard(review));
                    added += 1;
                }

                extra.appendChild(fragment);

                if (seenReviewCursors.has(nextCursor)) reviewExhausted = true;
            }

            if (reviewExhausted) {
                button.disabled = true;
                button.textContent = "No More Reviews";
                status.textContent = added
                    ? `Loaded ${added} more reviews.`
                    : "You've reached the end of this review set.";
            } else {
                button.disabled = false;
                button.textContent = "See More Reviews";
                status.textContent = added
                    ? `Loaded ${added} more reviews.`
                    : "No new reviews in that batch; try again for the next batch.";
            }
        } catch (error) {
            console.warn("[Ultrawide] Review continuation failed", error);
            button.disabled = false;
            button.textContent = "See More Reviews";
            status.textContent = "Could not load more reviews. Click to try again.";
        } finally {
            reviewLoading = false;
        }
    }

    function syncReviewControls(root, viewport, sentinel) {
        if (!root || !viewport) return;

        const fullReviews = findFullReviewsControl(root);
        if (!fullReviews) return;

        const href = fullReviews.href || fullReviews.getAttribute("href") || "";

        /*
          Hide only the duplicate presentation of Steam's native link. Its exact
          destination is preserved in our visible "Open Full Reviews" action.
          We never remove or reparent the React-owned native control.
        */
        fullReviews.classList.add("uw-native-browse-hidden");
        fullReviews.setAttribute("aria-hidden", "true");

        const state = getReviewState(root);
        const signature = reviewStateSignature(state);
        const { extra, button, fullLink, status } =
            ensureReviewContinuation(viewport, sentinel);

        if (href) {
            fullLink.href = href;
            fullLink.hidden = false;
        } else {
            fullLink.removeAttribute("href");
            fullLink.hidden = true;
        }

        if (reviewFilterSignature && reviewFilterSignature !== signature) {
            resetReviewContinuation(extra, button, status, signature);
        } else if (!reviewFilterSignature) {
            reviewFilterSignature = signature;
        }

        if (!button.dataset.uwBound) {
            button.dataset.uwBound = "1";
            button.addEventListener("click", () => {
                const currentRoot = findReviewRoot() || root;
                loadMoreReviews(currentRoot, viewport, sentinel);
            });
        }
    }

    /* =====================================================================
       CUSTOMER REVIEWS — NATIVE LAZY-LOAD BRIDGE
       =====================================================================

       Steam sometimes provides its own load-more control/sentinel in the
       embedded review app. We gently wake it as the INTERNAL viewport nears
       bottom. Calls are throttled and never run more than once per animation
       frame from scrolling.
       ===================================================================== */

    function wakeNativeReviewLoader(viewport, root) {
        if (!viewport || !root || !root.isConnected) return;

        const now = performance.now();
        if (now - lastReviewLoaderWake < 450) return;
        lastReviewLoaderWake = now;

        /* Let Steam's existing listeners observe the nested-scroll progress. */
        try {
            viewport.dispatchEvent(new Event("scroll"));
            document.dispatchEvent(new Event("scroll"));
            window.dispatchEvent(new Event("scroll"));
        } catch (_) {
            /* Event construction is non-critical; continue to control lookup. */
        }

        const more = findNativeMoreReviewsControl(root);
        if (more && elementIsVisible(more) && !more.disabled) {
            try {
                more.click();
            } catch (_) {
                /* Steam may replace the control between discovery and click. */
            }
        }
    }

    function bindReviewViewport(viewport, root, sentinel) {
        if (!viewport || boundReviewViewports.has(viewport)) return;
        boundReviewViewports.add(viewport);
        reviewLoadViewport = viewport;
        reviewLoadSentinel = sentinel;

        viewport.addEventListener(
            "scroll",
            () => {
                if (reviewScrollRAF) return;

                reviewScrollRAF = requestAnimationFrame(() => {
                    reviewScrollRAF = 0;
                    if (!viewport.isConnected) return;

                    const currentRoot = findReviewRoot() || root;

                    /* Pin native review chrome every animation frame of scroll. */
                    updatePinnedReviewHeader(viewport, currentRoot);

                    const remaining =
                        viewport.scrollHeight -
                        viewport.scrollTop -
                        viewport.clientHeight;

                    if (remaining < 1100) {
                        wakeNativeReviewLoader(viewport, currentRoot);
                    }
                });
            },
            { passive: true }
        );

        if ("IntersectionObserver" in window && sentinel) {
            reviewLoadObserver?.disconnect();

            reviewLoadObserver = new IntersectionObserver(
                entries => {
                    if (!entries.some(entry => entry.isIntersecting)) return;

                    const currentRoot = findReviewRoot() || root;
                    wakeNativeReviewLoader(viewport, currentRoot);
                },
                {
                    root: viewport,
                    rootMargin: "0px 0px 900px 0px",
                    threshold: 0
                }
            );

            reviewLoadObserver.observe(sentinel);
        }
    }

    /*
      V78 LATE GRAPH MOUNT DETECTION

      Steam does not always mount the review histogram at the same time as the
      summary/filter chrome. On a cold or busy app page UltraWide can discover
      and pin the header first, then React inserts the graph a few frames later.

      Existing pinned pieces are still perfectly valid in that situation, so the
      normal fast path intentionally does not rediscover the header. The late
      graph would therefore remain an ordinary scrolling child and could slide
      above the viewport while the rest of the header stayed frozen.

      Detect a newly inserted large role=img subtree before the review stream and
      request ONE full pin rediscovery on the next animation frame. This uses the
      semantic ARIA role plus DOM order/geometry only; it does not depend on the
      localized graph label. clearPinnedReviewHeader() runs before rediscovery,
      so measurements are taken from Steam's natural, untransformed layout.
    */
    function reviewChromeMutationNeedsRediscovery(mutations, root, viewport) {
        if (!root || !viewport || !mutations?.length) return false;

        const firstCard = findFirstNativeReviewCard(root);
        const firstCardTop = firstCard
            ? firstCard.getBoundingClientRect().top
            : Number.POSITIVE_INFINITY;
        const rootRect = root.getBoundingClientRect();

        const looksLikeLateGraph = node => {
            if (!(node instanceof Element) || !root.contains(node)) return false;

            const graph = node.matches("[role='img']")
                ? node
                : node.querySelector("[role='img']");
            if (!graph) return false;

            const rect = graph.getBoundingClientRect();
            if (rect.width < Math.max(220, rootRect.width * 0.20)) return false;
            if (rect.height < 90 || rect.height > 900) return false;

            /* The review histogram belongs to the chrome only when it precedes
               the first native review card in document/paint order. */
            if (firstCard && rect.top >= firstCardTop + 24) return false;

            return true;
        };

        for (const mutation of mutations) {
            if (mutation.type !== "childList") continue;

            for (const node of mutation.addedNodes) {
                if (looksLikeLateGraph(node)) return true;
            }

            /* If React removes a branch that contained one of our pinned pieces,
               force a clean rebuild rather than retaining a partial pin set. */
            for (const node of mutation.removedNodes) {
                if (!(node instanceof Element)) continue;
                if (
                    node.classList?.contains("uw-review-pinned-piece") ||
                    node.querySelector?.(".uw-review-pinned-piece")
                ) {
                    return true;
                }
            }
        }

        return false;
    }

    /*
      V80 GRAPH TOGGLE SETTLING

      Steam animates the native histogram by changing the wrapper class and
      then allowing its geometry to settle. Do not force a full rediscovery in
      the middle of that transition. Keep the known branch pinned and perform a
      few cheap height-only syncs after the class change. Repeated toggles cancel
      the previous finite timers; there is no permanent polling.
    */
    function scheduleReviewGraphToggleSettling(root, viewport) {
        for (const timer of reviewGraphToggleTimers) {
            clearTimeout(timer);
        }
        reviewGraphToggleTimers = [];

        for (const delay of [0, 80, 180, 360]) {
            reviewGraphToggleTimers.push(
                window.setTimeout(() => {
                    if (
                        !root?.isConnected ||
                        !viewport?.isConnected ||
                        !isUltraWideAppPage()
                    ) {
                        return;
                    }

                    syncStickyReviewHeader(root, viewport, false);
                }, delay)
            );
        }
    }

    function observeReviewRoot(root, viewport) {
        if (!root || !viewport) return;

        if (reviewObservedRoot === root && reviewObserver) return;

        reviewObserver?.disconnect();
        reviewObservedRoot = root;

        reviewObserver = new MutationObserver(mutations => {
            /*
              Ignore our own pin-offset writes. In V79 those writes were fed
              straight back into this observer, creating a several-hundred-Hz
              mutation loop that could race Steam's histogram animation. Steam's
              meaningful graph state is expressed through class changes on the
              wrapper and geometry/style changes on descendants, so ignoring the
              theme-only style variable on pinned pieces is safe.
            */
            const meaningfulMutations = mutations.filter(mutation => {
                if (mutation.type === "childList") return true;
                if (mutation.type !== "attributes") return false;

                if (
                    mutation.attributeName === "style" &&
                    mutation.target instanceof Element &&
                    mutation.target.classList.contains("uw-review-pinned-piece")
                ) {
                    return false;
                }

                return true;
            });

            if (!meaningfulMutations.length) return;

            const graphBranchClassChanged = meaningfulMutations.some(
                mutation =>
                    mutation.type === "attributes" &&
                    mutation.attributeName === "class" &&
                    mutation.target instanceof Element &&
                    knownReviewGraphBranches.has(mutation.target)
            );

            requestAnimationFrame(() => {
                const currentRoot = findReviewRoot() || root;
                const sentinel = document.getElementById("uw-review-sentinel");

                /*
                  Only genuinely new/replaced graph branches need a full header
                  rediscovery. A Hide/Show class transition on an already-known
                  graph branch stays cached so Steam can complete its animation
                  without UltraWide removing/re-adding the branch mid-toggle.
                */
                const forcePinRediscovery =
                    reviewChromeMutationNeedsRediscovery(
                        meaningfulMutations,
                        currentRoot,
                        viewport
                    ) ||
                    reviewGraphPinCoverageNeedsRediscovery(currentRoot);

                syncReviewControls(currentRoot, viewport, sentinel);
                syncStickyReviewHeader(
                    currentRoot,
                    viewport,
                    forcePinRediscovery
                );

                if (graphBranchClassChanged) {
                    scheduleReviewGraphToggleSettling(
                        currentRoot,
                        viewport
                    );
                }

                if (
                    viewport.scrollHeight <= viewport.clientHeight + 900 ||
                    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 1100
                ) {
                    wakeNativeReviewLoader(viewport, currentRoot);
                }
            });
        });

        reviewObserver.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            /*
              Include inline style because Valve's graph toggle can change
              visibility/geometry without replacing any DOM nodes.
            */
            attributeFilter: [
                "class", "style", "href", "value", "checked",
                "aria-checked", "aria-selected"
            ]
        });
    }

    function scheduleReviewGraphSettling(root, viewport) {
        if (
            !root ||
            !viewport ||
            reviewGraphSettlingRoots.has(root)
        ) {
            return;
        }

        reviewGraphSettlingRoots.add(root);

        for (const delay of [120, 350, 800, 1600, 3000]) {
            window.setTimeout(() => {
                if (
                    !root.isConnected ||
                    !viewport.isConnected ||
                    !isUltraWideAppPage()
                ) {
                    return;
                }

                syncStickyReviewHeader(
                    root,
                    viewport,
                    reviewGraphPinCoverageNeedsRediscovery(root)
                );
            }, delay);
        }
    }

    function applyReviewViewport(hero) {
        const reviewRoot = findReviewRoot();
        if (!reviewRoot) return;

        const { viewport, sentinel } = ensureReviewSection(hero);

        /*
          This is the only Steam review node moved by the theme. Moving the
          OUTER root keeps every React-owned child relationship intact.
        */
        if (reviewRoot.parentElement !== viewport) {
            moveNode(reviewRoot, viewport, "uw-native-review-root");
        } else {
            reviewRoot.classList.add("uw-native-review-root");
        }

        if (sentinel.parentElement !== viewport) {
            viewport.appendChild(sentinel);
        } else if (viewport.lastElementChild !== sentinel) {
            viewport.appendChild(sentinel);
        }

        bindReviewViewport(viewport, reviewRoot, sentinel);
        observeReviewRoot(reviewRoot, viewport);
        syncReviewControls(reviewRoot, viewport, sentinel);
        syncStickyReviewHeader(reviewRoot, viewport);
        scheduleReviewGraphSettling(reviewRoot, viewport);

        /* A short first native batch gets one initial chance to fill the pane. */
        requestAnimationFrame(() => {
            if (!viewport.isConnected) return;
            if (viewport.scrollHeight <= viewport.clientHeight + 900) {
                wakeNativeReviewLoader(viewport, reviewRoot);
            }
        });
    }

    /* ---------------------------------------------------------------------
       BELOW-HERO CONTINUATION LANES
       Continue long-form game content below each independent lane instead of
       forcing every module to wait for one shared grid row to finish.
       --------------------------------------------------------------------- */

    function moveMasonryContinuation(hero, mainCol, middle, aux) {
        const media = hero.querySelector(":scope > .leftcol");
        if (!media) return;

        const leftCont = ensureContinuation(
            media,
            LEFT_CONT_ID
        );

        const midCont = ensureContinuation(
            middle,
            MID_CONT_ID
        );

        const auxCont = ensureContinuation(
            aux,
            AUX_CONT_ID
        );

        /*
          LEFT LANE:
          Move the entire remaining long-form game-description column
          directly under the trailer/thumbnails. Since pre-About modules
          were already routed to middle/right earlier in apply(), this
          begins at About This Game.
        */
        if (
            mainCol &&
            !leftCont.contains(mainCol)
        ) {
            moveNode(
                mainCol,
                leftCont,
                "uw11-packed-module"
            );
        }

        /*
          Publisher / "More from..." content is conceptually long-form,
          so keep it in the left lane under About/System Requirements.
        */
        const moreFrom = findSectionByHeading(
            /^more from\b/i
        );

        if (
            moreFrom &&
            !leftCont.contains(moreFrom) &&
            !midCont.contains(moreFrom) &&
            !auxCont.contains(moreFrom) &&
            !middle.contains(moreFrom) &&
            !aux.contains(moreFrom)
        ) {
            moveNode(
                moreFrom,
                leftCont,
                "uw11-packed-module"
            );
        }

        /*
          Curators:
          put this in whichever information lane is shorter.
        */
        const curators =
            document.querySelector(".steam_curators_block") ||
            findSectionByHeading(/^what curators say$/i);

        if (
            curators &&
            !leftCont.contains(curators) &&
            !midCont.contains(curators) &&
            !auxCont.contains(curators)
        ) {
            const target =
                shorterInfoContinuation(
                    middle,
                    aux,
                    midCont,
                    auxCont
                );

            moveNode(
                curators,
                target,
                "uw11-packed-module"
            );
        }


        /*
          CUSTOMER REVIEWS:
          Keep Steam's complete React-owned review tree intact and place the
          whole native module in the dedicated scrollable review viewport.
        */
        applyReviewViewport(hero);

        /*
          Kill/remove the legacy V9 lower grid if one was created by an
          earlier observer pass or survives from a hot reload.
        */
        const oldLower = document.getElementById(LOWER_ID);
        if (oldLower) {
            oldLower.classList.add(
                "uw11-disabled-lower-grid"
            );
        }
    }

    /* =====================================================================
       V73 — APP-PAGE COLD-START STATUS
       ===================================================================== */

    function removeAppLoadingNotice() {
        if (appLoadingNoticeTimer) {
            clearTimeout(appLoadingNoticeTimer);
            appLoadingNoticeTimer = 0;
        }

        if (appLoadingNotice) {
            appLoadingNotice.remove();
            appLoadingNotice = null;
        }
    }

    function showAppLoadingNotice() {
        if (
            appLoadingNotice ||
            document.querySelector("#game_highlights")
        ) {
            return;
        }

        const notice = document.createElement("div");
        notice.id = "uw-cold-start-notice";
        notice.setAttribute("role", "status");
        notice.setAttribute("aria-live", "polite");

        const title = document.createElement("div");
        title.textContent = "Loading Steam Store…";
        title.style.cssText =
            "font-size:18px;font-weight:600;color:#fff;margin-bottom:6px;";

        const detail = document.createElement("div");
        detail.textContent = "UltraWide is waiting for Steam to finish loading this game page.";
        detail.style.cssText =
            "font-size:13px;line-height:1.4;color:#b8c7d9;";

        notice.append(title, detail);

        /*
          Inline styles keep this safety notice independent of the app-page
          layout CSS. It is intentionally small, pointer-events:none, and does
          not cover Steam's own navigation or any content that appears later.
        */
        notice.style.cssText =
            "position:fixed;left:50%;top:48%;transform:translate(-50%,-50%);" +
            "z-index:2147483000;max-width:520px;padding:18px 22px;" +
            "box-sizing:border-box;border:1px solid rgba(255,255,255,.12);" +
            "border-radius:4px;background:rgba(27,40,56,.96);" +
            "box-shadow:0 12px 32px rgba(0,0,0,.45);" +
            "font-family:Arial,Helvetica,sans-serif;text-align:center;" +
            "pointer-events:none;";

        /*
          V79: This notice may need to appear before DOMContentLoaded. Append to
          <body> when available, otherwise directly to <html>; a fixed-position
          element renders correctly there and avoids an eight-second black gap
          simply because Valve has not created body content yet.
        */
        const host = document.body || document.documentElement;
        if (!host) return;

        host.appendChild(notice);
        appLoadingNotice = notice;
    }

    function scheduleAppLoadingNotice() {
        if (appLoadingNoticeTimer || appLoadingNotice) return;

        appLoadingNoticeTimer = window.setTimeout(() => {
            appLoadingNoticeTimer = 0;

            if (!document.querySelector("#game_highlights")) {
                showAppLoadingNotice();
            }
        }, 450);
    }

    /* =====================================================================
       MAIN APP-PAGE LAYOUT PASS
       =====================================================================
       All mutations are funneled through this single RAF-coalesced pass.
       ===================================================================== */

    function apply() {
        raf = 0;

        if (window.innerWidth < MIN_WIDTH) {
            restoreEverything();
            return;
        }

        const hero = document.querySelector("#game_highlights");
        if (!hero) return;

        /* Native app content is now present; remove the cold-start status. */
        removeAppLoadingNotice();

        const media =
            hero.querySelector(":scope > .leftcol");

        const summary =
            hero.querySelector(":scope > .rightcol");

        if (!media) return;

        const titleArea = findTitleArea();
        const headerExtras =
            findHeaderExtras(hero, titleArea);

        /*
          Capture the live broadcast while it is still in Valve's original
          top-of-page position. It will be appended LAST to the middle rail.
        */
        const liveBroadcast =
            findLiveBroadcast(hero);

        const { middle, aux } =
            ensureTopColumns(hero);

        /*
          LIVE BROADCAST:
          Put the live broadcast at the VERY TOP of the middle column.
          moveNode() appends, so after moving it we explicitly prepend it
          to guarantee it stays above the title/header and every later module.
        */
        if (
            liveBroadcast &&
            !middle.contains(liveBroadcast) &&
            !aux.contains(liveBroadcast)
        ) {
            moveNode(
                liveBroadcast,
                middle,
                "uw10-live-broadcast"
            );

            middle.prepend(
                liveBroadcast
            );
        } else if (
            liveBroadcast &&
            middle.contains(liveBroadcast) &&
            middle.firstElementChild !== liveBroadcast
        ) {
            /*
              MutationObserver / hot-reload safety:
              if Steam rebuilds part of the page, keep Live pinned first.
            */
            middle.prepend(
                liveBroadcast
            );
        }

        if (
            titleArea &&
            !middle.contains(titleArea)
        ) {
            moveNode(titleArea, middle);
        }

        for (const extra of headerExtras) {
            if (!middle.contains(extra)) {
                moveNode(
                    extra,
                    middle,
                    "uw9-header-extra"
                );
            }
        }

        if (
            summary &&
            summary.parentElement !== middle
        ) {
            moveNode(summary, middle);
        }

        const queue =
            document.querySelector(".queue_overflow_ctn") ||
            document.querySelector(".queue_ctn");

        if (
            queue &&
            !middle.contains(queue) &&
            !aux.contains(queue)
        ) {
            moveNode(queue, middle);
        }

        const mainCol =
            document.querySelector(
                ".leftcol.game_description_column"
            ) ||
            document.querySelector(
                ".game_description_column"
            );

        if (mainCol) {
            const preAbout =
                collectPreAboutNodes(mainCol);

            for (const el of preAbout) {
                if (
                    middle.contains(el) ||
                    aux.contains(el)
                ) {
                    continue;
                }

                moveNode(
                    el,
                    belongsInAux(el)
                        ? aux
                        : middle
                );
            }
        }

        /*
          PURCHASE ROUTING FINAL AUTHORITY: regardless of which pre-About wrapper Steam used
          (or what an earlier observer pass did), the purchase container belongs
          at the top of the RIGHT/AUX column.
        */
        pinPurchaseToAux(aux);

        const meta =
            document.querySelector(
                ".rightcol.game_meta_data"
            ) ||
            document.querySelector(
                ".game_meta_data"
            );

        if (
            meta &&
            !middle.contains(meta) &&
            !aux.contains(meta)
        ) {
            moveNode(meta, aux);
        }
        hero.classList.add(SHELL);
        document.documentElement.classList.add(ACTIVE);

        const wrapper = hero.parentElement;

        if (wrapper) {
            wrapper.style.setProperty(
                "margin-top",
                "0",
                "important"
            );

            wrapper.style.setProperty(
                "padding-top",
                "0",
                "important"
            );
        }

        calculateWidths(hero);

        /*
          CONTINUATION LANES:
          Continue the page inside the three independent vertical lanes
          rather than waiting for one giant grid row to finish.
        */
        moveMasonryContinuation(
            hero,
            mainCol,
            middle,
            aux
        );
    }

    /* ---------------------------------------------------------------------
       LIFECYCLE / MUTATION SCHEDULING
       Steam can rebuild app-page modules asynchronously. One broad observer
       schedules a single animation-frame pass rather than doing layout work
       directly inside MutationObserver callbacks.
       --------------------------------------------------------------------- */

    function schedule() {
        /*
          Runtime isolation for reused Steam browser views. If this script was
          injected while an app page was open and Steam later navigates the same
          document away from /app/<id>, immediately restore every relocated node
          and stop observing. This prevents app-page layout code from ever
          interfering with the main Store homepage/infinite feed.
        */
        if (!isUltraWideAppPage()) {
            if (raf) {
                cancelAnimationFrame(raf);
                raf = 0;
            }

            removeAppLoadingNotice();
            restoreEverything();

            if (observer) {
                observer.disconnect();
                observer = null;
            }
            return;
        }

        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(apply);
    }

    window.addEventListener(
        "resize",
        schedule,
        { passive: true }
    );

    function start() {
        if (!isUltraWideAppPage()) return;

        scheduleAppLoadingNotice();

        if (!observer) {
            observer =
                new MutationObserver(() => schedule());

            observer.observe(
                document.documentElement,
                {
                    childList: true,
                    subtree: true
                }
            );
        }

        schedule();
    }

    /*
      V79: Schedule the visual loading state as soon as Millennium injects this
      script. Waiting for DOMContentLoaded defeated the purpose on the exact cold
      starts where Steam's browser view sat black for several seconds.
    */
    if (isUltraWideAppPage()) {
        scheduleAppLoadingNotice();
    }

    if (document.readyState === "loading") {
        document.addEventListener(
            "DOMContentLoaded",
            start,
            { once: true }
        );
    } else {
        start();
    }
})();

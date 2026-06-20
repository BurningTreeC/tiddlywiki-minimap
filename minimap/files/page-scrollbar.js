/*\
title: $:/plugins/BurningTreeC/minimap/page-scrollbar.js
type: application/javascript
module-type: startup

Publish the page (document root) vertical scrollbar width as the
--tv-page-scrollbar-width CSS variable on <html>, always - independent of the
minimap widget. The minimap's grip handle sits at the right edge when the
minimap is hidden, so it needs to clear the body/page scrollbar even though the
widget (which publishes the host scroller's scrollbar width) is not mounted then.

\*/
"use strict";

exports.name = "minimap-page-scrollbar-tracker";
exports.platforms = ["browser"];
exports.after = ["startup"];
exports.synchronous = true;

exports.startup = function() {
	var root = document.documentElement;
	if(!root || !root.style) {
		return;
	}

	function update() {
		var win = document.defaultView || window,
			// innerWidth includes the scrollbar; documentElement.clientWidth excludes
			// it, so the difference is the page's vertical scrollbar width.
			width = Math.max(0, win.innerWidth - root.clientWidth);
		root.style.setProperty("--tv-page-scrollbar-width", width + "px");
		// An overlay scrollbar is present only when the page actually overflows AND
		// no classic gutter is reserved (width === 0). A reserved gutter (width > 0)
		// or a non-overflowing page must NOT count - otherwise the grip would widen
		// when there's no scrollbar over it at all.
		var overflows = root.scrollHeight > root.clientHeight,
			hasOverlay = width === 0 && overflows;
		root.classList.toggle("tc-minimap-overlay-scrollbar",hasOverlay);
	}

	update();

	window.addEventListener("resize", update);

	// The scrollbar appears/disappears as page content grows/shrinks, which
	// changes documentElement's client width without a window resize.
	if(typeof ResizeObserver !== "undefined") {
		var ro = new ResizeObserver(update);
		ro.observe(root);
		if(document.body) {
			ro.observe(document.body);
		}
	}

	// Re-check after wiki changes (DOM updates land after the refresh cycle).
	$tw.wiki.addEventListener("change", function() {
		$tw.utils.nextTick(update);
	});
};

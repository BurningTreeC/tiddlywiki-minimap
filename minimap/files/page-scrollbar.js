/*\
title: $:/plugins/BurningTreeC/minimap/page-scrollbar.js
type: application/javascript
module-type: startup

Toggle the tc-minimap-overlay-scrollbar class on <html> when the page is scrolled
by an overlay scrollbar (the page overflows but reserves no scrollbar gutter).
The minimap's edge grip is widened in that case so it stays grabbable to the left
of the scrollbar that paints on top of it. A classic scrollbar reserves a gutter,
so a fixed `right: 0` element already clears it and no adjustment is needed.

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
			// a classic (space-reserving) scrollbar. So a difference means a classic
			// gutter is reserved; zero means an overlay scrollbar or none.
			gutter = Math.max(0, win.innerWidth - root.clientWidth),
			// An overlay scrollbar is present only when the page actually overflows
			// AND no classic gutter is reserved. A reserved gutter or a
			// non-overflowing page must NOT count - otherwise the grip would widen
			// when there's no scrollbar painting over it at all.
			hasOverlay = gutter === 0 && root.scrollHeight > root.clientHeight;
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

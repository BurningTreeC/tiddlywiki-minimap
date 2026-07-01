/*\
title: $:/plugins/BurningTreeC/minimap/menubar-height.js
type: application/javascript
module-type: startup

Publish the --tv-menubar-height CSS variable (used to offset the minimap below a
fixed menubar) if no other plugin already provides it. Mirrors the codemirror-6
editor's menubar-height tracker, and defers to it when that plugin is installed.

\*/
"use strict";

exports.name = "minimap-menubar-height-tracker";
exports.platforms = ["browser"];
exports.after = ["startup","cm6-menubar-height-tracker"];
exports.synchronous = true;

exports.startup = function() {
	// If the menubar height is already published (e.g. by the codemirror-6
	// plugin), leave it alone.
	var existing = window.getComputedStyle(document.documentElement).getPropertyValue("--tv-menubar-height");
	if(existing && existing.trim() !== "") {
		return;
	}

	var menubarObserver = null;
	var isTracking = false;
	// Last published value, so we skip no-op writes that would needlessly invalidate
	// layout and feed the ResizeObserver another notification.
	var lastMenubarHeight = null;

	function updateMenubarHeight(menubar) {
		var computedStyle = window.getComputedStyle(menubar);
		var position = computedStyle.position;
		var isOverlapping = position === "fixed" || position === "sticky" || position === "absolute";
		var value = isOverlapping ? (menubar.getBoundingClientRect().height + "px") : "0px";
		if(value !== lastMenubarHeight) {
			lastMenubarHeight = value;
			document.documentElement.style.setProperty("--tv-menubar-height", value);
		}
	}

	// Batch the measure-and-write into an animation frame and coalesce bursts, so the
	// DOM write happens outside the ResizeObserver's synchronous delivery cycle. This
	// avoids the "ResizeObserver loop completed with undelivered notifications"
	// warning when the menubar is resized rapidly.
	var rafPending = false,
		raf = window.requestAnimationFrame ?
			window.requestAnimationFrame.bind(window) :
			function(cb) { return setTimeout(cb,16); };
	function scheduleUpdate(menubar) {
		if(rafPending) {
			return;
		}
		rafPending = true;
		raf(function() {
			rafPending = false;
			updateMenubarHeight(menubar);
		});
	}

	function setupMenubarTracking(menubar) {
		if(isTracking) return;
		isTracking = true;

		updateMenubarHeight(menubar);

		if(typeof ResizeObserver !== "undefined") {
			menubarObserver = new ResizeObserver(function() {
				scheduleUpdate(menubar);
			});
			menubarObserver.observe(menubar);
		}

		window.addEventListener("resize", function() {
			scheduleUpdate(menubar);
		});
	}

	function checkForMenubar() {
		var menubar = document.querySelector(".tc-menubar.tc-adjust-top-of-scroll");
		if(menubar) {
			setupMenubarTracking(menubar);
		} else {
			document.documentElement.style.setProperty("--tv-menubar-height", "0px");
		}
	}

	// Initial check
	checkForMenubar();

	// Re-check after wiki changes (DOM updates after refresh cycle)
	if(!isTracking) {
		$tw.wiki.addEventListener("change", function() {
			if(!isTracking) {
				$tw.utils.nextTick(checkForMenubar);
			}
		});
	}
};

/*\
title: $:/plugins/BurningTreeC/minimap/widget.js
type: application/javascript
module-type: widget

A generic minimap widget, in the style of the CodeMirror 6 minimap.

It renders a vertically-scaled overview of a scroll container's content and a
draggable overlay marking the visible viewport. It is generic: the scroll
container and the elements that make up the map are both selected with CSS
selectors, so it is not tied to any particular layout.

Usage:

	<$minimap
		container=".tc-story-river"
		selector=".tc-tiddler-frame"
		width="120"
		mode="clone"
	/>

Attributes:

	container : CSS selector for the element whose content is mapped. When
	            omitted the nearest scrollable ancestor of the widget is used.
	scroller  : CSS selector for the element that actually scrolls. Defaults to
	            the container. Use this when the container itself does not scroll
	            but an ancestor does.
	selector  : CSS selector (resolved within the container) for the elements
	            that make up the map. Defaults to the container's element
	            children.
	width     : Minimap width in pixels (default 120).
	mode      : "clone" (default) renders scaled clones of the matched elements;
	            "blocks" renders lightweight coloured rectangles.
	class     : Extra class name(s) added to the minimap panel.
	tooltips  : "yes" to give each mapped block a native title tooltip (default
	            "no"). The text is read from the attribute named by
	            tooltipAttribute on the matched element.
	tooltipAttribute : Attribute on the matched element to read the tooltip text
	            from (default "data-tiddler-title").
	blockBorder : On-screen border width in px drawn around each mapped block, for
	            visibility (default 1; 0 disables). The colour is set in CSS via
	            the .tc-minimap-block border-color (overridable with the
	            --tv-minimap-block-border-color custom property).

\*/

"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;

var DEFAULT_WIDTH = 120;
var MIN_OVERLAY_HEIGHT = 8;
var RESOLVE_RETRIES = 30;

var MinimapWidget = function(parseTreeNode,options) {
	this.initialise(parseTreeNode,options);
};

MinimapWidget.prototype = new Widget();

MinimapWidget.prototype.render = function(parent,nextSibling) {
	this.parentDomNode = parent;
	this.computeAttributes();
	this.execute();
	var doc = this.document;
	// The minimap panel. Height/placement is left to CSS so the widget can be
	// dropped into any layout (sidebar, fixed column, flex child, ...).
	var panel = doc.createElement("div");
	panel.className = "tc-minimap" + (this.minimapClass ? " " + this.minimapClass : "");
	panel.setAttribute("aria-hidden","true");
	panel.style.width = this.minimapWidth + "px";
	// Publish the width as a CSS custom property on the document root so
	// stylesheets (e.g. the story-river spacing) can reserve room for the minimap
	// without hardcoding a value: width: calc(... - var(--tv-minimap-width)).
	this.publishWidth();
	// Inner wrapper - translated vertically to "scroll" the map when the mapped
	// content is taller than the minimap itself.
	var inner = doc.createElement("div");
	inner.className = "tc-minimap-inner";
	// Scaler - holds the (absolutely positioned) blocks/clones at their real
	// coordinates and scales the whole lot down with a single transform.
	var scaler = doc.createElement("div");
	scaler.className = "tc-minimap-scaler";
	inner.appendChild(scaler);
	// Overlay marking the visible viewport. Sits in panel (un-translated)
	// coordinates so it can be dragged independently of the mapped content.
	var overlayContainer = doc.createElement("div");
	overlayContainer.className = "tc-minimap-overlay-container";
	var overlay = doc.createElement("div");
	overlay.className = "tc-minimap-overlay";
	overlayContainer.appendChild(overlay);
	panel.appendChild(inner);
	panel.appendChild(overlayContainer);
	parent.insertBefore(panel,nextSibling);
	this.domNodes.push(panel);
	// Keep references for the geometry/interaction code
	this.panel = panel;
	this.inner = inner;
	this.scaler = scaler;
	this.overlayContainer = overlayContainer;
	this.overlay = overlay;
	// Interaction state
	this.scale = 1;
	this.isDragging = false;
	this.dragStartY = 0;
	this.dragStartTop = 0;
	this.rafPending = false;
	this.rebuildTimer = null;
	this.resolveAttempts = 0;
	// The id of the pointer currently dragging the overlay (null when not dragging).
	this.dragPointerId = null;
	// Whether this widget owns (publishes) the scrollbar-width variable. Decided in
	// attachListeners once the root is known; false until then so no stray writes.
	this.ownsScrollbarVar = false;
	// Cached overlay height used to avoid redundant style writes. Reset here so the
	// first updateView() after a (re-)render always writes the height to the freshly
	// created overlay element - otherwise a refreshSelf() (e.g. on a settings
	// change) would leave the new overlay at height 0 because the cached value still
	// matched the unchanged geometry.
	this._lastOverlayH = null;
	// The mapped elements currently watched for size changes (kept in sync with
	// the rendered set so the map updates live as tiddlers grow/shrink).
	this._observedEls = [];
	// Cache of resolved video-provider poster URLs (e.g. Vimeo, looked up
	// asynchronously) keyed by video id, so repeated rebuilds don't refetch.
	this._posterCache = Object.create(null);
	// Bind handlers once so we can remove them again
	this.boundScroll = this.onScroll.bind(this);
	this.boundResize = this.onResize.bind(this);
	this.boundPointerDown = this.onPointerDown.bind(this);
	this.boundPointerMove = this.onPointerMove.bind(this);
	this.boundPointerUp = this.onPointerUp.bind(this);
	// Fired when an embedded resource inside the mapped content finishes loading.
	this.boundContentLoad = this.scheduleRebuild.bind(this);
	// Resolve the container/scroller and wire everything up
	this.setup();
};

/*
Compute the internal state of the widget
*/
MinimapWidget.prototype.execute = function() {
	this.containerSelector = this.getAttribute("container","");
	this.scrollerSelector = this.getAttribute("scroller","");
	this.elementSelector = this.getAttribute("selector","");
	this.minimapClass = this.getAttribute("class","");
	this.minimapMode = this.getAttribute("mode","clone");
	// Opt-in tooltips: when "yes", each mapped block gets a native title tooltip
	// read from a (configurable, generic) attribute on the matched element - e.g.
	// data-tiddler-title for TiddlyWiki tiddler frames.
	this.tooltipsEnabled = this.getAttribute("tooltips","no") === "yes";
	this.tooltipAttribute = this.getAttribute("tooltipAttribute","data-tiddler-title");
	// On-screen border width (px) drawn around each mapped block, for visibility.
	// The blocks are inside a scaled container, so the actual border width is
	// compensated by the scale at build time (see rebuild). 0 disables the border.
	var border = parseFloat(this.getAttribute("blockBorder","1"));
	this.blockBorder = (isFinite(border) && border >= 0) ? border : 1;
	var width = parseInt(this.getAttribute("width",""),10);
	this.minimapWidth = (width && width > 0) ? width : DEFAULT_WIDTH;
	// CSS custom property names to publish on the document root (configurable).
	this.widthVariable = this.normaliseCssVar(this.getAttribute("widthVariable","--tv-minimap-width"));
	this.scrollbarVariable = this.normaliseCssVar(this.getAttribute("scrollbarVariable","--tv-minimap-scrollbar-width"));
};

/*
Ensure a CSS custom property name starts with "--" so it can be used both with
setProperty() and var() (accepts "name" or "--name").
*/
MinimapWidget.prototype.normaliseCssVar = function(name) {
	name = (name || "").trim();
	if(!name) {
		return "";
	}
	return name.indexOf("--") === 0 ? name : "--" + name;
};

/*
Find a scrollable ancestor of the given node
*/
MinimapWidget.prototype.findScrollableAncestor = function(node) {
	var doc = this.document,
		win = doc.defaultView || window;
	while(node && node !== doc.body && node.nodeType === 1) {
		var style = win.getComputedStyle(node),
			overflowY = style.overflowY;
		if((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
			return node;
		}
		node = node.parentNode;
	}
	return doc.scrollingElement || doc.documentElement;
};

/*
Find the nearest ancestor that is a scroll container (overflow auto/scroll),
regardless of whether it currently overflows. Used to locate the container whose
scrollbar the minimap should clear - that scrollbar may only appear later, so it
must not be gated on the current overflow state.
*/
MinimapWidget.prototype.findScrollContainer = function(node) {
	var doc = this.document,
		win = doc.defaultView || window;
	while(node && node !== doc.body && node.nodeType === 1) {
		var overflowY = win.getComputedStyle(node).overflowY;
		if(overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
			return node;
		}
		node = node.parentNode;
	}
	return doc.scrollingElement || doc.documentElement;
};

/*
Resolve the container and scroller elements, then build the map. Retries for a
few animation frames because the target may not be laid out (or may not yet
exist) when the widget first renders.
*/
MinimapWidget.prototype.setup = function() {
	var self = this,
		doc = this.document;
	if(this.containerSelector) {
		this.container = doc.querySelector(this.containerSelector);
	} else {
		this.container = this.findScrollableAncestor(this.parentDomNode);
	}
	if(this.container && this.scrollerSelector) {
		this.scroller = doc.querySelector(this.scrollerSelector) || this.container;
	} else if(this.container) {
		// Default the scroller to the nearest scrollable ancestor of the
		// container (which may be the container itself). The content container
		// (e.g. .tc-story-river) is frequently NOT the element that scrolls - an
		// ancestor (the page) is - so reading scrollTop from the container would
		// leave the overlay out of sync with the actual scrolling.
		this.scroller = this.findScrollableAncestor(this.container);
	}
	// The scroll container the minimap itself is placed inside (e.g. the sidebar).
	// Its scrollbar width is published so stylesheets can position the minimap
	// just clear of that scrollbar. Resolved by overflow style (not current
	// overflow state) so we still pick it when its scrollbar appears later.
	this.hostScroller = this.findScrollContainer(this.parentDomNode);
	if(!this.container || !this.scroller || !this.panel) {
		// The target elements aren't in the DOM yet - retry on the next frame for a
		// little while (they may not exist or be laid out when we first render).
		if(this.resolveAttempts < RESOLVE_RETRIES) {
			this.resolveAttempts += 1;
			var win = doc.defaultView || window;
			this.resolveRaf = win.requestAnimationFrame(function() {
				self.setup();
			});
		}
		return;
	}
	// Attach as soon as the elements exist, even if the panel is currently hidden
	// (e.g. the window started below the sidebar breakpoint, where the minimap is
	// display:none). rebuild() early-returns while hidden, and the ResizeObserver on
	// the panel then fires a rebuild the moment it becomes visible again - without
	// this, a wiki opened narrow would never wire up its observers and the minimap
	// would stay empty until toggled off and on.
	this.attachListeners();
	this.rebuild();
};

MinimapWidget.prototype.getWindow = function() {
	var doc = this.document;
	return doc.defaultView || window;
};

/*
Publish (or clear) the minimap width as a CSS custom property (named by the
widthVariable attribute) on the document's root element, so stylesheets can size
around it.
*/
MinimapWidget.prototype.publishWidth = function(clear) {
	var doc = this.document,
		root = doc.documentElement;
	if(!root || !root.style || !this.widthVariable) {
		return;
	}
	if(clear) {
		root.style.removeProperty(this.widthVariable);
	} else {
		root.style.setProperty(this.widthVariable,this.minimapWidth + "px");
	}
};

/*
Is the scroller the document's root scrolling element? The root scrolls
differently from an overflow container: scroll events fire on the window/document
(not the element) and the element's own bounding rect moves with the scroll.
*/
MinimapWidget.prototype.isRootScroller = function() {
	var doc = this.document;
	return this.scroller === doc.scrollingElement ||
		this.scroller === doc.documentElement ||
		this.scroller === doc.body;
};

/*
The element that fires scroll events for the scroller (the window for a root
scroller, otherwise the scroller element itself).
*/
MinimapWidget.prototype.getScrollEventTarget = function() {
	return this.isRootScroller() ? this.getWindow() : this.scroller;
};

/*
Height of any position:fixed toolbar that overlays the top of the page (marked
with the `tc-adjust-top-of-scroll` class, e.g. a sticky menubar). Content scrolls
underneath it, so the usable viewport - and therefore the overlay's height, the
overlay's position and the targets we scroll to - must be offset by this height,
matching TiddlyWiki's own PageScroller.scrollIntoView. The toolbar is fixed to the
viewport, so it only applies when the page itself is the scroller.
*/
MinimapWidget.prototype.getTopOffset = function() {
	if(!this.isRootScroller()) {
		return 0;
	}
	var bar = this.document.querySelector(".tc-adjust-top-of-scroll");
	return bar ? bar.offsetHeight : 0;
};

MinimapWidget.prototype.attachListeners = function() {
	var self = this,
		win = this.getWindow();
	this.scrollEventTarget = this.getScrollEventTarget();
	this.scrollEventTarget.addEventListener("scroll",this.boundScroll,{passive: true});
	win.addEventListener("resize",this.boundResize);
	// Pointer events (mouse/touch/pen). Pointer capture during a drag delivers all
	// move/up events to the panel even when the pointer leaves it, so no
	// window-level listeners are needed.
	this.panel.addEventListener("pointerdown",this.boundPointerDown);
	this.panel.addEventListener("pointermove",this.boundPointerMove);
	this.panel.addEventListener("pointerup",this.boundPointerUp);
	this.panel.addEventListener("pointercancel",this.boundPointerUp);
	// Rebuild when the mapped content changes size or when elements are added
	// or removed (e.g. tiddlers opened/closed in the story river).
	if(typeof win.ResizeObserver === "function") {
		this.resizeObserver = new win.ResizeObserver(this.scheduleRebuild.bind(this));
		this.resizeObserver.observe(this.scroller);
		if(this.container !== this.scroller) {
			this.resizeObserver.observe(this.container);
		}
		// Also observe the panel so that hiding/showing the minimap (e.g. toggling
		// a sidebar it lives in) re-triggers a rebuild when it becomes visible.
		if(this.panel !== this.scroller && this.panel !== this.container) {
			this.resizeObserver.observe(this.panel);
		}
		// Dedicated, lightweight observer for the host scroll container: its size
		// (and scrollbar) changing only needs the scrollbar variable republished,
		// not a full re-clone of the mapped content.
		if(this.hostScroller) {
			this.scrollbarObserver = new win.ResizeObserver(function() {
				self.publishScrollbarWidth();
			});
			this.scrollbarObserver.observe(this.hostScroller);
		}
	}
	// Decide whether this widget owns the scrollbar-width variable. If it is already
	// present on the root, something else is managing it (in the bundled plugin, the
	// always-on startup module that keeps it measured even while the minimap is
	// hidden) - so defer to that owner and never write it, to avoid two writers and
	// to avoid clearing the always-present value on destroy. If it is absent (a
	// generic standalone <$minimap> with no startup module), take ownership and
	// publish/maintain it ourselves.
	var doc = this.document,
		root = doc.documentElement;
	this.ownsScrollbarVar = !!(this.scrollbarVariable && root && root.style &&
		!root.style.getPropertyValue(this.scrollbarVariable));
	// Publish the width and scrollbar variables now that everything is resolved.
	this.publishWidth();
	this.publishScrollbarWidth();
	if(typeof win.MutationObserver === "function") {
		this.mutationObserver = new win.MutationObserver(this.scheduleRebuild.bind(this));
		this.mutationObserver.observe(this.container,{childList: true, subtree: true});
	}
	// Embedded resources (iframes such as SoundCloud/YouTube, videos, images) often
	// finish loading *after* the first build - at wiki startup the iframe isn't laid
	// out and a cross-origin embed's poster/oEmbed lookup hasn't resolved, so the
	// initial clone captures an empty, zero-sized placeholder. Their `load` events
	// neither bubble nor mutate/resize the host DOM, so the Mutation/ResizeObservers
	// never see them. Listen in the capture phase on the mapped container (capture
	// reaches non-bubbling load events) and rebuild once the content has actually
	// loaded. Videos signal readiness with `loadeddata` rather than `load`.
	this.container.addEventListener("load",this.boundContentLoad,true);
	this.container.addEventListener("loadeddata",this.boundContentLoad,true);
};

/*
Reconcile which mapped elements are observed for size changes: observe newly
added ones, unobserve removed ones. Only observing *new* elements (rather than
re-observing all every rebuild) avoids a feedback loop, since observe() fires an
initial callback.
*/
MinimapWidget.prototype.observeElements = function(elements) {
	if(!this.resizeObserver) {
		return;
	}
	var current = [];
	for(var i = 0; i < elements.length; i++) {
		current.push(elements[i].el);
	}
	for(var o = 0; o < this._observedEls.length; o++) {
		if(current.indexOf(this._observedEls[o]) === -1) {
			this.resizeObserver.unobserve(this._observedEls[o]);
		}
	}
	for(var n = 0; n < current.length; n++) {
		if(this._observedEls.indexOf(current[n]) === -1) {
			this.resizeObserver.observe(current[n]);
		}
	}
	this._observedEls = current;
};

/*
Collect the elements that make up the map, measured relative to the scroller's
scroll content.
*/
MinimapWidget.prototype.collectElements = function() {
	var nodes;
	if(this.elementSelector) {
		nodes = this.container.querySelectorAll(this.elementSelector);
	} else {
		nodes = this.container.children;
	}
	var scrollTop = this.scroller.scrollTop,
		scrollLeft = this.scroller.scrollLeft,
		result = [];
	// Reference point that an element's content position is measured from. For a
	// root scroller the "viewport" top is 0; for an overflow container it is the
	// container's (border-box) top in viewport coordinates. (Using the root's own
	// bounding rect would be wrong - it moves with the scroll.)
	var refTop = 0,
		refLeft = 0;
	if(!this.isRootScroller()) {
		var scrollerRect = this.scroller.getBoundingClientRect();
		refTop = scrollerRect.top;
		refLeft = scrollerRect.left;
	}
	for(var i = 0; i < nodes.length; i++) {
		var el = nodes[i],
			rect = el.getBoundingClientRect();
		result.push({
			el: el,
			top: rect.top - refTop + scrollTop,
			left: rect.left - refLeft + scrollLeft,
			width: rect.width,
			height: rect.height
		});
	}
	return result;
};

/*
Prepare a freshly cloned subtree for the map: strip ids (to avoid duplicates),
remove nodes that would load resources, and replace iframes with a static
snapshot (cloneNode does not reproduce an iframe's document).
*/
MinimapWidget.prototype.processClone = function(original, clone) {
	if(clone.removeAttribute) {
		clone.removeAttribute("id");
	}
	// Drop nodes that would load/run resources. Iframes are handled separately.
	var drop = clone.querySelectorAll ? clone.querySelectorAll("script,object,embed") : [];
	for(var i = drop.length - 1; i >= 0; i--) {
		if(drop[i].parentNode) {
			drop[i].parentNode.removeChild(drop[i]);
		}
	}
	// Copy each <canvas>'s pixels across, then replace each <iframe> with a
	// snapshot. The cloned and original trees have the same structure, so the
	// elements line up by index. Canvases are done first, while the clone still
	// mirrors the original 1:1 - replacing iframes can insert extra nodes (a
	// same-origin iframe's body) that would otherwise throw the index off.
	var origCanvases = this.matchingElements(original,"canvas"),
		cloneCanvases = this.matchingElements(clone,"canvas");
	for(var c = 0; c < cloneCanvases.length && c < origCanvases.length; c++) {
		this.snapshotCanvas(origCanvases[c],cloneCanvases[c]);
	}
	var origVideos = this.matchingElements(original,"video"),
		cloneVideos = this.matchingElements(clone,"video");
	for(var v = 0; v < cloneVideos.length && v < origVideos.length; v++) {
		this.replaceVideo(origVideos[v],cloneVideos[v]);
	}
	var origFrames = this.matchingElements(original,"iframe"),
		cloneFrames = this.matchingElements(clone,"iframe");
	for(var f = 0; f < cloneFrames.length && f < origFrames.length; f++) {
		this.replaceIframe(origFrames[f],cloneFrames[f]);
	}
	var withId = clone.querySelectorAll ? clone.querySelectorAll("[id]") : [];
	for(var j = 0; j < withId.length; j++) {
		withId[j].removeAttribute("id");
	}
	return clone;
};

/*
All descendants of root matching the tag name, plus root itself when it matches.
Used so a cloned subtree whose own root is an <iframe>/<canvas> is handled too,
not only nested ones.
*/
MinimapWidget.prototype.matchingElements = function(root,tag) {
	var list = root.querySelectorAll ? Array.prototype.slice.call(root.querySelectorAll(tag)) : [];
	if(root.tagName && root.tagName.toLowerCase() === tag) {
		list.unshift(root);
	}
	return list;
};

/*
Copy a <canvas>'s drawn pixels onto its clone. cloneNode copies the element and
its width/height attributes but not the bitmap (the backing store is not part of
the DOM), so a cloned canvas is blank - draw the original onto it. A canvas
tainted by cross-origin data throws on read, and a WebGL canvas without
preserveDrawingBuffer reads blank; in both cases fall back to a neutral block.
*/
MinimapWidget.prototype.snapshotCanvas = function(origCanvas,cloneCanvas) {
	try {
		var w = origCanvas.width,
			h = origCanvas.height;
		if(!w || !h) {
			return;
		}
		cloneCanvas.width = w;
		cloneCanvas.height = h;
		var ctx = cloneCanvas.getContext("2d");
		if(ctx) {
			ctx.drawImage(origCanvas,0,0);
		}
	} catch(e) {
		if(cloneCanvas.classList) {
			cloneCanvas.classList.add("tc-minimap-canvas-blank");
		}
	}
};

/*
Replace a cloned <video> with a static snapshot. cloneNode keeps the poster/src
but not the decoded frame, and a live <video> clone would needlessly fetch the
media, so swap it for: the current frame painted onto a canvas (works even for a
cross-origin video - drawing only taints the canvas, which we never read back),
or the poster image when no frame is decoded yet, or a neutral placeholder.
*/
MinimapWidget.prototype.replaceVideo = function(origVideo,cloneVideo) {
	var doc = this.document;
	if(!cloneVideo.parentNode) {
		return;
	}
	var rect = origVideo.getBoundingClientRect(),
		repl = doc.createElement("div");
	repl.className = "tc-minimap-video";
	var cls = cloneVideo.getAttribute("class");
	if(cls) {
		repl.className += " " + cls;
	}
	repl.setAttribute("style",cloneVideo.getAttribute("style") || "");
	repl.style.width = rect.width + "px";
	repl.style.height = rect.height + "px";
	repl.style.overflow = "hidden";
	repl.style.boxSizing = "border-box";
	var done = false;
	try {
		var vw = origVideo.videoWidth,
			vh = origVideo.videoHeight;
		if(vw && vh) {
			var canvas = doc.createElement("canvas");
			canvas.width = vw;
			canvas.height = vh;
			canvas.className = "tc-minimap-video-frame";
			var ctx = canvas.getContext("2d");
			if(ctx) {
				ctx.drawImage(origVideo,0,0,vw,vh);
				repl.appendChild(canvas);
				done = true;
			}
		}
	} catch(e) {
		// Fall back to the poster image / placeholder below
	}
	if(!done) {
		var poster = origVideo.getAttribute("poster");
		if(poster) {
			this.setPosterImage(repl,poster);
		} else {
			repl.className += " tc-minimap-iframe-blank";
		}
	}
	cloneVideo.parentNode.replaceChild(repl,cloneVideo);
};

/*
Replace a cloned <iframe> with a div snapshot. For a same-origin iframe (e.g.
TiddlyWiki's framed text editor, or a local embed) the iframe's document body is
cloned in so its content is shown. For a cross-origin iframe the browser forbids
reading the content, so a correctly-sized blank placeholder is used instead -
which still preserves the layout height so the surrounding tiddler doesn't
collapse.
*/
MinimapWidget.prototype.replaceIframe = function(origIframe,cloneIframe) {
	var doc = this.document;
	if(!cloneIframe.parentNode) {
		return;
	}
	var rect = origIframe.getBoundingClientRect(),
		repl = doc.createElement("div");
	repl.className = "tc-minimap-iframe";
	// Carry over the iframe's own class/style so margins and sizing are preserved
	var cls = cloneIframe.getAttribute("class");
	if(cls) {
		repl.className += " " + cls;
	}
	repl.setAttribute("style",cloneIframe.getAttribute("style") || "");
	repl.style.width = rect.width + "px";
	repl.style.height = rect.height + "px";
	repl.style.overflow = "hidden";
	repl.style.boxSizing = "border-box";
	var handled = false;
	try {
		var idoc = origIframe.contentDocument;
		if(idoc && idoc.body) {
			var bodyClone = idoc.body.cloneNode(true);
			// Drop scripts from the snapshot
			var snapScripts = bodyClone.querySelectorAll ? bodyClone.querySelectorAll("script") : [];
			for(var s = snapScripts.length - 1; s >= 0; s--) {
				if(snapScripts[s].parentNode) {
					snapScripts[s].parentNode.removeChild(snapScripts[s]);
				}
			}
			// Sync live form values (textarea/input) - cloneNode captures the
			// default value, not text typed since load, so copy it across.
			this.syncFieldValues(idoc.body,bodyClone);
			repl.appendChild(bodyClone);
			handled = true;
		}
	} catch(e) {
		// Cross-origin: the document can't be read - fall through to a poster image
		// (derived from the embed URL) or a neutral placeholder.
	}
	// For an iframe we couldn't read (cross-origin, e.g. a YouTube/Vimeo embed),
	// try to show the provider's poster thumbnail - that's just loading a public
	// image from the src URL, which is allowed, unlike reading the frame itself.
	if(!handled && !this.addProviderPoster(origIframe,repl)) {
		// Unknown cross-origin embed: keep the sized neutral placeholder
		repl.className += " tc-minimap-iframe-blank";
	}
	cloneIframe.parentNode.replaceChild(repl,cloneIframe);
};

/*
Provider table for deriving a poster thumbnail from a (cross-origin) embed URL.
Each entry has a `re` to match/extract an id and exactly one resolver:
  thumb(m,src)   -> a poster image URL, derivable synchronously (no network read).
  api(m,src)     -> {url,pick} to fetch as JSON (oEmbed or a public lookup API),
                    pick(data) returning the thumbnail URL; or null to skip.
  jsonp(m,src)   -> {url,param,pick} to load via JSONP, for a public API with no
                    CORS (used only for the opt-in Apple Music provider below).
The first matching provider for a candidate URL wins. Providers whose thumbnail
needs authentication or carries no derivable image (Twitch, Bandcamp, Google/OSM
maps) are deliberately absent - they fall through to the neutral placeholder like
any other cross-origin embed. JSFiddle is also absent: no CORS-safe thumbnail.
*/
MinimapWidget.prototype.posterProviders = function(raw) {
	var self = this;
	var providers = [
		{	// YouTube: .../embed/<id>, .../v/<id>, youtu.be/<id> (also -nocookie)
			re: /(?:youtube(?:-nocookie)?\.com\/(?:embed|v)\/|youtu\.be\/)([A-Za-z0-9_-]{11})/,
			thumb: function(m) {
				return "https://img.youtube.com/vi/" + m[1] + "/hqdefault.jpg";
			}
		},
		{	// Vimeo: player.vimeo.com/video/<id> or vimeo.com/<id>
			re: /(?:player\.)?vimeo\.com\/(?:video\/)?(\d+)/,
			api: function(m) {
				return {
					url: "https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F" + m[1],
					pick: function(d) { return d && d.thumbnail_url; }
				};
			}
		},
		{	// Dailymotion: embed/video/<id>, geo.dailymotion player ?video=<id>, dai.ly/<id>
			re: /dailymotion\.com\/(?:embed\/)?video\/([A-Za-z0-9]+)|geo\.dailymotion\.com\/player[^?]*\?(?:[^#]*&)?video=([A-Za-z0-9]+)|dai\.ly\/([A-Za-z0-9]+)/,
			thumb: function(m) {
				return "https://www.dailymotion.com/thumbnail/video/" + (m[1] || m[2] || m[3]);
			}
		},
		{	// Spotify: open.spotify.com/[embed/]<type>/<id>
			re: /open\.spotify\.com\/(?:embed\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/,
			api: function(m) {
				return {
					url: "https://open.spotify.com/oembed?url=" + encodeURIComponent("https://open.spotify.com/" + m[1] + "/" + m[2]),
					pick: function(d) { return d && d.thumbnail_url; }
				};
			}
		},
		{	// SoundCloud: w.soundcloud.com/player/?url=<track>, or a track page URL
			re: /soundcloud\.com/,
			api: function(m,src) {
				// The real track URL lives in the player's `url` query param; fall back
				// to the matched URL when the embed is a bare track page.
				var track = self.queryParam(raw,"url") || self.queryParam(src,"url") || src,
					host = self.urlHost(track);
				// Only accept a clean soundcloud.com track/page URL. The literal
				// "soundcloud.com" survives percent-encoding, so the raw proxy URL also
				// matches `re` - reject it (and the player URL itself) by host so the
				// loop falls through to the candidate carrying the real track URL.
				if(!host || !/(^|\.)soundcloud\.com$/.test(host) || /\/player(\/|\?|$)/.test(track)) {
					return null;
				}
				// Newer embeds carry a URN id (.../tracks/soundcloud:tracks:<n>, often
				// double-encoded) which 404s at oEmbed; reduce it to the plain numeric
				// track id oEmbed expects. Public /user/slug URLs are left untouched.
				var dec = track;
				try {
					dec = decodeURIComponent(track);
				} catch(e) {
					// keep track as-is
				}
				var idm = dec.match(/\/tracks\/(?:soundcloud:tracks:)?(\d+)/);
				if(idm) {
					track = "https://api.soundcloud.com/tracks/" + idm[1];
				}
				return {
					url: "https://soundcloud.com/oembed?format=json&url=" + encodeURIComponent(track),
					pick: function(d) {
						var t = d && d.thumbnail_url;
						// SoundCloud returns a grey placeholder image for art-less tracks;
						// treat that as "no thumbnail" so our own neutral placeholder shows.
						return (t && !/\/images\/[^\/]*placeholder/i.test(t)) ? t : "";
					}
				};
			}
		},
		{	// CodePen: codepen.io/<user>/embed|pen/<hash>, also team pens. Use the
			// direct screenshot image (shots.codepen.io) instead of oEmbed: CodePen's
			// oEmbed sends no CORS header, so a browser fetch - especially from a
			// file:// wiki (Origin: null), e.g. TiddlyDesktop - is blocked. The image
			// loads as a plain <img> regardless of origin.
			re: /codepen\.io\/((?:team\/)?[^\/]+)\/(?:embed|pen|details|full)\/([A-Za-z0-9]+)/,
			thumb: function(m) {
				return "https://shots.codepen.io/" + m[1] + "/pen/" + m[2] + "-512.jpg";
			}
		},
		{	// CodeSandbox: codesandbox.io/embed|s|p/sandbox/<id> -> screenshot endpoint
			re: /codesandbox\.io\/(?:embed|s|p\/sandbox)\/([A-Za-z0-9\-]+)/,
			thumb: function(m) {
				return "https://codesandbox.io/api/v1/sandboxes/" + m[1] + "/screenshot.png";
			}
		},
		// JSFiddle is intentionally absent: its oEmbed sends no CORS header and exposes
		// no thumbnail_url, and there is no public screenshot image endpoint - so there
		// is no CORS-safe way to get a preview. Such embeds use the neutral placeholder.
		{	// Internet Archive: archive.org/embed/<identifier> -> services/img/<identifier>
			re: /archive\.org\/embed\/([^\/?#]+)/,
			thumb: function(m) {
				return "https://archive.org/services/img/" + m[1];
			}
		}
	];
	// Apple Music is opt-in (default off). Its only no-auth artwork source is the
	// iTunes lookup API, which sends no CORS header and so can only be read via JSONP
	// - which executes a script from itunes.apple.com. Enabling that is the user's
	// informed choice, gated on $:/config/BurningTreeC/minimap/apple-music. The album
	// id is digits-only and the host/callback are fixed, so a malicious embed cannot
	// influence the request beyond the numeric id it already controls.
	if(self.appleMusicEnabled()) {
		providers.push({
			// embed.music.apple.com/<cc>/album|song/<name>/<id> (numeric id only -
			// playlists use non-numeric ids the lookup API can't resolve)
			re: /music\.apple\.com\/[a-z]{2}\/(?:album|song|music-video)\/[^\/]+\/(\d+)/,
			jsonp: function(m) {
				return {
					url: "https://itunes.apple.com/lookup?id=" + m[1],
					param: "callback",
					pick: function(d) {
						var r = d && d.results && d.results[0],
							a = r && (r.artworkUrl100 || r.artworkUrl60 || r.artworkUrl30);
						return a ? a.replace(/\/\d+x\d+bb\./,"/600x600bb.") : "";
					}
				};
			}
		});
	}
	return providers;
};

/*
Whether the opt-in Apple Music (JSONP) provider is enabled. Off unless the config
tiddler is explicitly "yes" - see the note in posterProviders for why it is gated.
*/
MinimapWidget.prototype.appleMusicEnabled = function() {
	return !!(this.wiki && this.wiki.getTiddlerText("$:/config/BurningTreeC/minimap/apple-music","no") === "yes");
};

/*
Given a (cross-origin) iframe, try to render a known provider's poster thumbnail
into the replacement node. Returns true when a provider was recognised (synchronous
thumbnails set immediately, async lookups filled in when they resolve), false for an
unrecognised embed so the caller can use a neutral placeholder.
*/
MinimapWidget.prototype.addProviderPoster = function(origIframe,repl) {
	var raw = origIframe.getAttribute("src") || origIframe.src || "";
	if(!raw) {
		return false;
	}
	// An embed may be proxied (e.g. TiddlyDesktop reroutes embeds through a local
	// server so they load), so test the proxy URL, any real URL unwrapped from a
	// src=/url= query param, and any URL recovered for a configured embed host.
	var candidates = this.embedUrlCandidates(raw)
			.concat(this.proxyHostCandidates(raw,this.getEmbedHosts())),
		providers = this.posterProviders(raw);
	for(var i = 0; i < candidates.length; i++) {
		var src = candidates[i];
		for(var p = 0; p < providers.length; p++) {
			var prov = providers[p],
				m = src.match(prov.re);
			if(!m) {
				continue;
			}
			if(prov.thumb) {
				this.setPosterImage(repl,prov.thumb(m,src));
				return true;
			}
			if(prov.jsonp) {
				var js = prov.jsonp(m,src);
				if(js) {
					// Neutral placeholder until (and if) the JSONP lookup resolves.
					repl.className += " tc-minimap-iframe-blank";
					this.fetchJsonp(repl,js.url,js.param,js.pick);
					return true;
				}
				continue;
			}
			if(prov.api) {
				var spec = prov.api(m,src);
				if(spec) {
					// Neutral placeholder until (and if) the async lookup resolves.
					repl.className += " tc-minimap-iframe-blank";
					this.fetchThumbnail(repl,spec);
					return true;
				}
				continue;
			}
		}
	}
	return false;
};

/*
Hosts listed in $:/config/TiddlyDesktop/EmbedHosts (one per line, or comma/space
separated). TiddlyDesktop reroutes embeds for these hosts through a local proxy;
we use the list to recover the real provider URL out of a proxy URL. Each entry is
normalised to a bare host (protocol and any path stripped, lower-cased).
*/
MinimapWidget.prototype.getEmbedHosts = function() {
	var text = this.wiki ? this.wiki.getTiddlerText("$:/config/TiddlyDesktop/EmbedHosts","") : "";
	if(!text) {
		return [];
	}
	var parts = text.split(/[\s,]+/),
		hosts = [];
	for(var i = 0; i < parts.length; i++) {
		var h = parts[i].trim().toLowerCase().replace(/^[a-z]+:\/\//,"").replace(/\/.*$/,"");
		if(h) {
			hosts.push(h);
		}
	}
	return hosts;
};

/*
Recover candidate real URLs from a proxy URL using the configured embed hosts: any
configured host found anywhere in the (decoded) src is turned into an absolute
https URL starting at that host. This covers both query-style proxying
(?src=<encoded url>) and path-style proxying (/<host>/<path>), so a host that maps
to a known provider still resolves its thumbnail whatever the proxy shape.
*/
MinimapWidget.prototype.proxyHostCandidates = function(src,hosts) {
	var extra = [];
	if(!hosts || !hosts.length) {
		return extra;
	}
	var decoded;
	try {
		decoded = decodeURIComponent(src);
	} catch(e) {
		decoded = src;
	}
	var lower = decoded.toLowerCase();
	for(var i = 0; i < hosts.length; i++) {
		var host = hosts[i],
			idx = lower.indexOf(host);
		while(idx !== -1) {
			// Use the original-case slice (the host index matches in the lower-cased
			// copy, but paths/ids can be case-sensitive).
			extra.push("https://" + decoded.slice(idx));
			idx = lower.indexOf(host,idx + host.length);
		}
	}
	return extra;
};

/*
Read a named query parameter from a URL string, tolerant of relative URLs and
parse failures (returns null).
*/
MinimapWidget.prototype.queryParam = function(url,name) {
	var win = this.getWindow(),
		URLctor = win.URL || (typeof URL !== "undefined" ? URL : null);
	if(!URLctor) {
		return null;
	}
	try {
		return new URLctor(url,this.document.baseURI).searchParams.get(name);
	} catch(e) {
		return null;
	}
};

/*
Lower-cased hostname of a URL string (no port), or null if it can't be parsed.
*/
MinimapWidget.prototype.urlHost = function(url) {
	var win = this.getWindow(),
		URLctor = win.URL || (typeof URL !== "undefined" ? URL : null);
	if(!URLctor) {
		return null;
	}
	try {
		return new URLctor(url,this.document.baseURI).hostname.toLowerCase();
	} catch(e) {
		return null;
	}
};

/*
Expand an iframe src into the list of URLs worth testing for a provider. Besides
the src itself this covers proxied embeds - e.g. TiddlyDesktop reroutes YouTube
embeds through a local server and carries the real URL in a `src=`/`url=` query
parameter (percent-encoded) - so provider detection still sees the real
youtube.com / vimeo.com address. A wholesale percent-decode is added as a final
fallback for other proxy shapes.
*/
MinimapWidget.prototype.embedUrlCandidates = function(src) {
	var list = [src],
		win = this.getWindow(),
		URLctor = win.URL || (typeof URL !== "undefined" ? URL : null);
	if(URLctor) {
		try {
			var url = new URLctor(src,this.document.baseURI),
				inner = url.searchParams.get("src") || url.searchParams.get("url");
			if(inner) {
				list.push(inner);
			}
		} catch(e) {
			// Not a parseable URL - the plain decode below may still help
		}
	}
	try {
		var decoded = decodeURIComponent(src);
		if(decoded !== src) {
			list.push(decoded);
		}
	} catch(e) {
		// Malformed escape sequence - ignore
	}
	return list;
};

/*
Insert a poster <img> into a replacement node, covering it. If the image fails to
load, fall back to the neutral placeholder look.
*/
MinimapWidget.prototype.setPosterImage = function(repl,url) {
	var doc = this.document,
		img = doc.createElement("img");
	img.className = "tc-minimap-iframe-poster-img";
	img.setAttribute("alt","");
	img.style.width = "100%";
	img.style.height = "100%";
	img.style.objectFit = "cover";
	img.style.display = "block";
	img.onerror = function() {
		if(img.parentNode) {
			img.parentNode.removeChild(img);
		}
		if(repl.classList) {
			repl.classList.add("tc-minimap-iframe-blank");
		}
	};
	if(repl.classList) {
		repl.classList.remove("tc-minimap-iframe-blank");
		repl.classList.add("tc-minimap-iframe-poster");
	}
	img.setAttribute("src",url);
	repl.appendChild(img);
	this.warmPosterImage(url);
};

/*
Warm the browser cache for a poster URL with a persistent, off-DOM Image. A rebuild
clears the scaler and re-clones from scratch, so the cloned <img> above can be
removed mid-download - which drops the in-flight request, and for a slow CDN the
image then never appears until some later rebuild coincides with a completed load
(e.g. after scrolling). The detached preloader is never removed, so it always
finishes loading; once it does, the URL is cached and one rebuild is scheduled so
the poster shows immediately (the rebuilt <img> loads instantly from cache). Kept
per-URL so each image warms and schedules at most once.
*/
MinimapWidget.prototype.warmPosterImage = function(url) {
	var self = this,
		cache = this._imgCache || (this._imgCache = Object.create(null));
	if(!url || cache[url] !== undefined) {
		return;
	}
	var win = this.getWindow();
	if(!win || !win.Image) {
		return;
	}
	var pre = new win.Image();
	// Keep a reference so the load can't be garbage-collected/aborted.
	cache[url] = pre;
	pre.onload = function() {
		cache[url] = true;
		// Reflect the now-cached image in case rebuild churn orphaned the live <img>.
		self.scheduleRebuild();
	};
	pre.onerror = function() {
		// Remember the failure so we don't retry it every rebuild this session.
		cache[url] = false;
	};
	pre.src = url;
};

/*
Fetch a thumbnail described by a spec ({url, pick}) - an oEmbed or public lookup
endpoint returning JSON, with pick(data) extracting the image URL - and, when it
resolves, set it as the replacement node's image. Results (including failures) are
cached by endpoint URL on the widget so repeated rebuilds don't refetch; concurrent
rebuilds chain onto the in-flight request. Any cross-origin/CORS or parse failure
degrades quietly to the neutral placeholder already on the node.
*/
MinimapWidget.prototype.fetchThumbnail = function(repl,spec) {
	if(!spec || !spec.url) {
		return;
	}
	var self = this,
		win = this.getWindow(),
		cache = this._posterCache,
		key = spec.url,
		cached = cache[key];
	if(cached !== undefined) {
		if(typeof cached === "string") {
			if(cached) {
				this.setPosterImage(repl,cached);
			}
		} else if(cached && cached.then) {
			cached.then(function(url) {
				if(url) {
					self.setPosterImage(repl,url);
				}
			});
		}
		return;
	}
	if(!win.fetch) {
		cache[key] = "";
		return;
	}
	var p = win.fetch(spec.url)
		.then(function(response) {
			return response.json();
		})
		.then(function(data) {
			var url = "";
			try {
				url = spec.pick(data) || "";
			} catch(e) {
				url = "";
			}
			cache[key] = url;
			return url;
		})
		.catch(function() {
			cache[key] = "";
			return "";
		});
	cache[key] = p;
	p.then(function(url) {
		if(url) {
			self.setPosterImage(repl,url);
		}
	});
};

/*
Load a thumbnail from a CORS-less public API via JSONP (only used by the opt-in
Apple Music provider). A <script> is appended whose URL is built entirely by us -
fixed host, a numeric id, and a generated callback name - so a malicious embed
can't influence it. The global callback and the script node are removed as soon as
it fires (or errors, or times out), and results are cached by endpoint like
fetchThumbnail. Any failure (CSP blocking the script, network, timeout) degrades
quietly to the neutral placeholder already on the node.
*/
MinimapWidget.prototype.fetchJsonp = function(repl,endpoint,callbackParam,pick) {
	if(!endpoint || !callbackParam) {
		return;
	}
	var self = this,
		win = this.getWindow(),
		doc = this.document,
		cache = this._posterCache,
		key = endpoint,
		cached = cache[key];
	if(cached !== undefined) {
		if(typeof cached === "string") {
			if(cached) {
				this.setPosterImage(repl,cached);
			}
		} else if(cached && cached.then) {
			cached.then(function(url) {
				if(url) {
					self.setPosterImage(repl,url);
				}
			});
		}
		return;
	}
	var head = doc && (doc.head || doc.documentElement);
	if(!win || !doc || !doc.createElement || !head) {
		cache[key] = "";
		return;
	}
	var resolveFn,
		promise = new Promise(function(resolve) { resolveFn = resolve; });
	cache[key] = promise;
	promise.then(function(url) {
		if(url) {
			self.setPosterImage(repl,url);
		}
	});
	MinimapWidget._jsonpSeq = (MinimapWidget._jsonpSeq || 0) + 1;
	var cbName = "_tcMinimapJsonp" + MinimapWidget._jsonpSeq,
		script = doc.createElement("script"),
		settled = false,
		timer;
	function finish(url) {
		if(settled) {
			return;
		}
		settled = true;
		cache[key] = url || "";
		try {
			delete win[cbName];
		} catch(e) {
			win[cbName] = undefined;
		}
		if(timer) {
			win.clearTimeout(timer);
		}
		if(script.parentNode) {
			script.parentNode.removeChild(script);
		}
		resolveFn(url || "");
	}
	win[cbName] = function(data) {
		var url = "";
		try {
			url = pick(data) || "";
		} catch(e) {
			url = "";
		}
		finish(url);
	};
	script.onerror = function() {
		finish("");
	};
	// Give up if the callback never fires (e.g. blocked by CSP, or the network hangs).
	timer = win.setTimeout(function() {
		finish("");
	},10000);
	script.src = endpoint + (endpoint.indexOf("?") === -1 ? "?" : "&") + callbackParam + "=" + cbName;
	head.appendChild(script);
};

/*
Copy live <textarea>/<input>/<select> values from a source subtree onto the
matching (same structure, same order) elements of a cloned subtree.
*/
MinimapWidget.prototype.syncFieldValues = function(source,clone) {
	if(!source.querySelectorAll || !clone.querySelectorAll) {
		return;
	}
	var sel = "textarea,input,select",
		src = source.querySelectorAll(sel),
		dst = clone.querySelectorAll(sel);
	for(var i = 0; i < src.length && i < dst.length; i++) {
		var sNode = src[i],
			dNode = dst[i];
		if(dNode.tagName === "TEXTAREA") {
			// Render the live text by setting it as the textarea's content
			dNode.textContent = sNode.value;
		} else if(dNode.tagName === "INPUT") {
			dNode.setAttribute("value",sNode.value);
		}
	}
};

/*
(Re)build the contents of the map from the current DOM, then update positions.
This is the expensive path; it only runs on layout/structure changes, not on
every scroll.
*/
MinimapWidget.prototype.rebuild = function() {
	if(!this.container || !this.scroller || !this.panel) {
		return;
	}
	// Don't rebuild while the container or the minimap is hidden/collapsed: the
	// measurements would be zero and poison the scale. The ResizeObserver will
	// fire again - and re-run the rebuild - once everything is visible.
	if(this.container.clientWidth === 0 || this.scroller.clientHeight === 0 || this.panel.clientHeight === 0) {
		return;
	}
	var doc = this.document,
		elements = this.collectElements();
	// Keep each mapped element observed for size changes, so the map updates live
	// as a tiddler grows or shrinks (typing in an editor, images loading,
	// folding). The container/scroller's own box size doesn't change when a child
	// frame grows - only its scrollHeight does, which ResizeObserver ignores - so
	// the elements themselves must be observed.
	this.observeElements(elements);
	// Scale to the width actually occupied by the mapped elements rather than to
	// the full container width. The matched elements (e.g. tiddler frames) are
	// often centred with horizontal margins; mapping the whole container width
	// would leave them narrow and offset. Using their bounding box - and shifting
	// off the left margin - makes the widest element fill the minimap while
	// preserving each element's aspect ratio (uniform scale).
	var minLeft = Infinity,
		maxRight = -Infinity,
		minTop = Infinity,
		maxBottom = -Infinity;
	for(var k = 0; k < elements.length; k++) {
		minLeft = Math.min(minLeft, elements[k].left);
		maxRight = Math.max(maxRight, elements[k].left + elements[k].width);
		minTop = Math.min(minTop, elements[k].top);
		maxBottom = Math.max(maxBottom, elements[k].top + elements[k].height);
	}
	if(!isFinite(minLeft) || maxRight <= minLeft) {
		minLeft = 0;
		maxRight = this.scroller.clientWidth || this.scroller.offsetWidth || 1;
	}
	if(!isFinite(minTop) || maxBottom <= minTop) {
		minTop = 0;
		maxBottom = this.scroller.scrollHeight || 1;
	}
	// The map's vertical axis spans the extent actually occupied by the matched
	// elements - not the scroller's full scrollHeight, which may include a header
	// offset, bottom padding or gaps with no matched elements. Mapping the full
	// scrollHeight would leave large empty regions and let scrolling translate
	// the content off into blank space.
	this._contentTop = minTop;
	this._contentBottom = maxBottom;
	var contentWidth = maxRight - minLeft;
	this.scale = this.minimapWidth / contentWidth;
	this.scaler.style.width = contentWidth + "px";
	this.scaler.style.transform = "scale(" + this.scale + ")";
	// Clear previous content
	while(this.scaler.firstChild) {
		this.scaler.removeChild(this.scaler.firstChild);
	}
	for(var i = 0; i < elements.length; i++) {
		var info = elements[i],
			block = doc.createElement("div");
		block.className = "tc-minimap-block";
		block.style.position = "absolute";
		block.style.top = (info.top - minTop) + "px";
		block.style.left = (info.left - minLeft) + "px";
		block.style.width = info.width + "px";
		block.style.height = info.height + "px";
		block.style.margin = "0";
		block.style.pointerEvents = "none";
		// Border for visibility. Width is compensated by the scale so it renders at
		// the configured on-screen pixel width despite the scaled parent; colour
		// comes from CSS (.tc-minimap-block border-color). box-sizing keeps the
		// border inside the measured block so it doesn't shift positions.
		if(this.blockBorder > 0 && this.scale > 0) {
			block.style.boxSizing = "border-box";
			block.style.borderStyle = "solid";
			block.style.borderWidth = (this.blockBorder / this.scale) + "px";
		}
		// Optional tooltip from a configurable attribute on the matched element.
		// A native title needs hover, so re-enable pointer events on this block
		// (the clone inside stays inert; clicks still bubble to the panel and
		// scroll-to-position because the block isn't the overlay).
		if(this.tooltipsEnabled && this.tooltipAttribute && info.el.getAttribute) {
			var tip = info.el.getAttribute(this.tooltipAttribute);
			if(tip) {
				block.title = tip;
				block.style.pointerEvents = "auto";
			}
		}
		if(this.minimapMode === "clone") {
			var clone = this.processClone(info.el,info.el.cloneNode(true));
			clone.style.margin = "0";
			clone.style.width = info.width + "px";
			clone.style.boxSizing = "border-box";
			clone.style.pointerEvents = "none";
			block.appendChild(clone);
		} else {
			block.className += " tc-minimap-block-filled";
		}
		this.scaler.appendChild(block);
	}
	this.measure();
	this.updateView();
};

/*
Cheap path: reposition the inner content and the overlay to reflect the current
scroll position. Runs on every scroll (throttled to animation frames).
*/
MinimapWidget.prototype.updateView = function() {
	if(!this.scroller || !this.panel) {
		return;
	}
	// Only the scroll position is read here (the cheap, per-frame path). Every
	// other measurement is cached by measure() at rebuild/resize time, so
	// scrolling never forces a reflow of the (potentially large, absolutely
	// positioned) minimap.
	var scrollTop = this.scroller.scrollTop,
		clientH = this._clientH || 0,
		// A fixed top toolbar covers the top of the viewport, so the usable
		// (visible) viewport starts that much lower and is that much shorter.
		topOffset = this._topOffset || 0,
		visibleH = Math.max(0, clientH - topOffset),
		scale = this.scale,
		contentTop = this._contentTop || 0,
		contentBottom = this._contentBottom || 0,
		mapViewH = this._mapViewH || 0,
		// Total scaled height of the mapped elements
		mapContentH = (contentBottom - contentTop) * scale,
		// The viewport (overlay), anchored to the actual scroll position within
		// the element extent - sized and positioned for the usable viewport, so it
		// marks what is actually visible below the toolbar.
		overlayH = Math.max(MIN_OVERLAY_HEIGHT, Math.min(visibleH * scale, mapViewH)),
		overlayTopMap = (scrollTop + topOffset - contentTop) * scale,
		panelTravel = Math.max(0, mapViewH - overlayH),
		translate,
		overlayTop,
		// The range the overlay top actually moves within. Drag mapping must use
		// this same range so dragging matches wheel scrolling.
		overlayTravel;
	if(mapContentH <= mapViewH) {
		// All mapped content fits in the panel: don't translate, just slide the
		// overlay over the static content. The overlay only travels across the
		// filled region (mapContentH - overlayH), not the whole panel, otherwise
		// dragging would feel slow and the overlay would detach from the content.
		translate = 0;
		overlayTravel = Math.max(0, mapContentH - overlayH);
		overlayTop = Math.min(Math.max(0, overlayTopMap), overlayTravel);
	} else {
		// Content taller than the panel: translate the inner content so the
		// overlay tracks the scroll position while staying inside the panel.
		overlayTravel = panelTravel;
		var progressDenom = Math.max(0, mapContentH - overlayH),
			progress = progressDenom > 0 ? overlayTopMap / progressDenom : 0;
		progress = Math.min(Math.max(progress, 0), 1);
		overlayTop = progress * overlayTravel;
		translate = overlayTop - overlayTopMap;
	}
	this.inner.style.transform = "translateY(" + translate + "px)";
	// Position the overlay with a compositor transform (changing `top` would
	// trigger layout) and only write its height when it actually changes.
	this.overlay.style.transform = "translateY(" + overlayTop + "px)";
	if(overlayH !== this._lastOverlayH) {
		this.overlay.style.height = overlayH + "px";
		this._lastOverlayH = overlayH;
	}
	// Cache values used by the interaction handlers
	this._overlayTop = overlayTop;
	this._overlayH = overlayH;
	this._overlayTravel = overlayTravel;
	this._translate = translate;
};

/*
Cache the geometry that only changes on rebuild/resize, so the per-frame scroll
path (updateView) doesn't have to read it (and force a reflow) every frame.
*/
MinimapWidget.prototype.measure = function() {
	if(!this.scroller || !this.panel) {
		return;
	}
	this._clientH = this.scroller.clientHeight;
	this._mapViewH = this.panel.clientHeight;
	this._topOffset = this.getTopOffset();
	this.publishScrollbarWidth();
};

/*
Publish the host scroll container's vertical scrollbar width as a CSS custom
property (named by the scrollbarVariable attribute), so a stylesheet can offset
the minimap just clear of the scrollbar of whatever container it lives in.

Only writes when this widget owns the variable (see attachListeners): if something
else already manages it - the always-on startup module in the bundled plugin - we
must not write or clear it, so the value stays present and accurate at all times.
*/
MinimapWidget.prototype.publishScrollbarWidth = function(clear) {
	var doc = this.document,
		root = doc.documentElement;
	if(!root || !root.style || !this.scrollbarVariable || !this.ownsScrollbarVar) {
		return;
	}
	if(clear) {
		root.style.removeProperty(this.scrollbarVariable);
		return;
	}
	var host = this.hostScroller,
		width = host ? Math.max(0, host.offsetWidth - host.clientWidth) : 0;
	root.style.setProperty(this.scrollbarVariable,width + "px");
};

MinimapWidget.prototype.onScroll = function() {
	var self = this,
		win = this.getWindow();
	if(this.rafPending) {
		return;
	}
	this.rafPending = true;
	win.requestAnimationFrame(function() {
		self.rafPending = false;
		self.updateView();
	});
};

MinimapWidget.prototype.onResize = function() {
	// Update the scrollbar variable immediately (cheap); the rebuild is debounced.
	this.publishScrollbarWidth();
	this.scheduleRebuild();
};

/*
Debounced rebuild - coalesces bursts of mutations/resizes into a single rebuild.
*/
MinimapWidget.prototype.scheduleRebuild = function() {
	var self = this,
		win = this.getWindow();
	if(this.rebuildTimer) {
		win.clearTimeout(this.rebuildTimer);
	}
	this.rebuildTimer = win.setTimeout(function() {
		self.rebuildTimer = null;
		self.rebuild();
	},100);
};

MinimapWidget.prototype.onPointerDown = function(event) {
	// Primary button/contact only (ignore right/middle click and secondary touches).
	if(event.button > 0) {
		return;
	}
	if(event.target === this.overlay) {
		// Begin dragging the overlay. Capture the pointer so move/up keep arriving
		// at the panel even if the pointer strays outside it during the drag.
		this.isDragging = true;
		this.dragPointerId = event.pointerId;
		this.dragStartY = event.clientY;
		this.dragStartTop = this._overlayTop || 0;
		this.panel.classList.add("tc-minimap-active");
		// Scroll instantly for the whole drag so the page tracks the pointer
		this.beginInstantScroll();
		if(this.panel.setPointerCapture) {
			try {
				this.panel.setPointerCapture(event.pointerId);
			} catch(e) {
				// Ignore - capture is an optimisation, not required for correctness
			}
		}
		event.preventDefault();
		return;
	}
	// Click on the map body: scroll so the clicked position is centred in the
	// usable viewport (the part visible below any fixed top toolbar)
	var panelRect = this.panel.getBoundingClientRect(),
		panelY = event.clientY - panelRect.top,
		// Map panel coordinates back to scroll-content coordinates
		contentY = (panelY - (this._translate || 0)) / this.scale + (this._contentTop || 0),
		clientH = this.scroller.clientHeight,
		topOffset = this._topOffset || 0,
		target = contentY - (clientH + topOffset) / 2;
	// Jump instantly to the clicked position. Only manage the override if a drag
	// isn't already doing so (e.g. a second touch), so we never end it early.
	var manageInstant = !this._instantScrollActive;
	if(manageInstant) {
		this.beginInstantScroll();
	}
	this.scrollTo(target);
	if(manageInstant) {
		this.endInstantScroll();
	}
};

MinimapWidget.prototype.onPointerMove = function(event) {
	if(!this.isDragging || (this.dragPointerId !== null && event.pointerId !== this.dragPointerId)) {
		return;
	}
	event.preventDefault();
	var travel = this._overlayTravel || 0,
		delta = event.clientY - this.dragStartY,
		newTop = Math.min(Math.max(0, this.dragStartTop + delta), travel),
		frac = travel > 0 ? newTop / travel : 0,
		clientH = this.scroller.clientHeight,
		// A fixed top toolbar shortens the usable viewport, and content lands that
		// much lower; mirror the overlay maths in updateView so dragging tracks it.
		topOffset = this._topOffset || 0,
		// Map the overlay's travel onto the scroll range covered by the elements
		contentTop = this._contentTop || 0,
		contentBottom = this._contentBottom || 0,
		scrollRange = Math.max(0, (contentBottom - contentTop) - (clientH - topOffset));
	this.scrollTo(contentTop + frac * scrollRange - topOffset);
};

MinimapWidget.prototype.onPointerUp = function(event) {
	if(!this.isDragging) {
		return;
	}
	if(event && this.dragPointerId !== null && event.pointerId !== this.dragPointerId) {
		return;
	}
	this.isDragging = false;
	// Restore the scroller's previous scroll-behavior now the drag is over
	this.endInstantScroll();
	if(this.panel.releasePointerCapture && this.dragPointerId !== null) {
		try {
			this.panel.releasePointerCapture(this.dragPointerId);
		} catch(e) {
			// Ignore - the pointer may already have been released
		}
	}
	this.dragPointerId = null;
	this.panel.classList.remove("tc-minimap-active");
};

/*
While the minimap is driving the scroll position (dragging the overlay, or a
click on the map body), the page must scroll instantly so it tracks the pointer
exactly. A theme may set `scroll-behavior: smooth` on the scroller, which would
otherwise turn every scrollTop write into an animated scroll - the page lags
behind the pointer and overshoots, and dragging feels imprecise. We force
instant scrolling for the duration of the gesture by overriding the property
inline on the scroller itself. `scroll-behavior` is not inherited, so the
scrolling box is the only element that matters; we save and restore whatever was
set inline before so we never clobber another value.
*/
MinimapWidget.prototype.beginInstantScroll = function() {
	if(this._instantScrollActive || !this.scroller || !this.scroller.style) {
		return;
	}
	this._instantScrollActive = true;
	this._prevScrollBehavior = this.scroller.style.scrollBehavior;
	this.scroller.style.scrollBehavior = "auto";
};

MinimapWidget.prototype.endInstantScroll = function() {
	if(!this._instantScrollActive) {
		return;
	}
	this._instantScrollActive = false;
	if(this.scroller && this.scroller.style) {
		this.scroller.style.scrollBehavior = this._prevScrollBehavior || "";
	}
	this._prevScrollBehavior = undefined;
};

MinimapWidget.prototype.scrollTo = function(top) {
	var maxScroll = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
	this.scroller.scrollTop = Math.min(Math.max(0, top), maxScroll);
	// The scroll listener updates the view; update immediately too so dragging
	// feels responsive even if the scroll event is throttled.
	this.updateView();
};

/*
Selectively refreshes the widget if needed.
*/
MinimapWidget.prototype.refresh = function(changedTiddlers) {
	var changedAttributes = this.computeAttributes();
	if(changedAttributes.container || changedAttributes.scroller || changedAttributes.selector ||
		changedAttributes.width || changedAttributes.mode || changedAttributes["class"] ||
		changedAttributes.widthVariable || changedAttributes.scrollbarVariable ||
		changedAttributes.tooltips || changedAttributes.tooltipAttribute ||
		changedAttributes.blockBorder) {
		// Tear down listeners/observers first: refreshSelf() re-renders but does not
		// call destroy(), so they would otherwise leak (and keep firing).
		this.detachListeners();
		this.refreshSelf();
		return true;
	}
	return false;
};

/*
Remove all event listeners, observers and pending timers/frames. Used both by
onDestroy and before a refreshSelf() re-render - the base widget's refreshSelf()
does not call destroy(), so without this each re-render (e.g. on a settings
change) would leak the previous listeners and observers.
*/
MinimapWidget.prototype.detachListeners = function() {
	var win = this.getWindow();
	// Make sure a drag interrupted by teardown doesn't leave the override behind
	this.endInstantScroll();
	if(this.resolveRaf) {
		win.cancelAnimationFrame(this.resolveRaf);
		this.resolveRaf = null;
	}
	if(this.rebuildTimer) {
		win.clearTimeout(this.rebuildTimer);
		this.rebuildTimer = null;
	}
	if(this.scrollEventTarget) {
		this.scrollEventTarget.removeEventListener("scroll",this.boundScroll);
		this.scrollEventTarget = null;
	}
	if(this.panel) {
		this.panel.removeEventListener("pointerdown",this.boundPointerDown);
		this.panel.removeEventListener("pointermove",this.boundPointerMove);
		this.panel.removeEventListener("pointerup",this.boundPointerUp);
		this.panel.removeEventListener("pointercancel",this.boundPointerUp);
	}
	win.removeEventListener("resize",this.boundResize);
	if(this.resizeObserver) {
		this.resizeObserver.disconnect();
		this.resizeObserver = null;
	}
	if(this.scrollbarObserver) {
		this.scrollbarObserver.disconnect();
		this.scrollbarObserver = null;
	}
	if(this.mutationObserver) {
		this.mutationObserver.disconnect();
		this.mutationObserver = null;
	}
	if(this.container) {
		this.container.removeEventListener("load",this.boundContentLoad,true);
		this.container.removeEventListener("loadeddata",this.boundContentLoad,true);
	}
};

/*
Cleanup - called by the base widget's destroy().
*/
MinimapWidget.prototype.onDestroy = function() {
	this.publishWidth(true);
	this.publishScrollbarWidth(true);
	this.detachListeners();
};

exports.minimap = MinimapWidget;

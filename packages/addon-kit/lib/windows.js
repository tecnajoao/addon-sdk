/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

if (!require("api-utils/xul-app").is("Firefox")) {
  throw new Error([
    "The windows module currently supports only Firefox. In the future",
    " we would like it to support other applications, however.  Please see ",
    "https://bugzilla.mozilla.org/show_bug.cgi?id=571449 for more information."
  ].join(""));
}

const { Cc, Ci, Cr } = require('chrome'),
      { Trait } = require('api-utils/traits'),
      { List } = require('api-utils/list'),
      { EventEmitter } = require('api-utils/events'),
      { WindowTabs, WindowTabTracker } = require('api-utils/windows/tabs'),
      { WindowDom } = require('api-utils/windows/dom'),
      { WindowLoader } = require('api-utils/windows/loader'),
      { isBrowser } = require('api-utils/window/utils'),
      { Options } = require('api-utils/tabs/tab'),
      apiUtils = require('api-utils/api-utils'),
      unload = require('api-utils/unload'),
      windowUtils = require('api-utils/window-utils'),
      { WindowTrackerTrait } = windowUtils,
      { ns } = require('api-utils/namespace'),
      { observer: windowObserver } = require("api-utils/windows/observer"),
      { isWindowPBEnabled } = require('api-utils/private-browsing/utils');

/**
 * Window trait composes safe wrappers for browser window that are E10S
 * compatible.
 */
const BrowserWindowTrait = Trait.compose(
  EventEmitter,
  WindowDom.resolve({ close: '_close' }),
  WindowTabs,
  WindowTabTracker,
  WindowLoader,
  /* WindowSidebars, */
  Trait.compose({
    _emit: Trait.required,
    _close: Trait.required,
    _load: Trait.required,
    /**
     * Constructor returns wrapper of the specified chrome window.
     * @param {nsIWindow} window
     */
    constructor: function BrowserWindow(options) {
      // Register this window ASAP, in order to avoid loop that would try
      // to create this window instance over and over (see bug 648244)
      windows.push(this);

      // make sure we don't have unhandled errors
      this.on('error', console.exception.bind(console));

      if ('onOpen' in options)
        this.on('open', options.onOpen);
      if ('onClose' in options)
        this.on('close', options.onClose);
      if ('onActivate' in options)
        this.on('activate', options.onActivate);
      if ('onDeactivate' in options)
        this.on('deactivate', options.onDeactivate);
      if ('window' in options)
        this._window = options.window;
      if ('tabs' in options) {
        this._tabOptions = Array.isArray(options.tabs) ?
                           options.tabs.map(Options) :
                           [ Options(options.tabs) ];
      }
      else if ('url' in options) {
        this._tabOptions = [ Options(options.url) ];
      }
      this._load();
      return this;
    },
    destroy: function () this._onUnload(),
    _tabOptions: [],
    _onLoad: function() {
      try {
        this._initWindowTabTracker();
      } catch(e) {
        this._emit('error', e)
      }

      this._initWindowPrivateBrowser();

      this._emitOnObject(browserWindows, 'open', this._public);
    },
    _onUnload: function() {
      if (!this._window)
        return;
      this._destroyWindowTabTracker();
      this._emitOnObject(browserWindows, 'close', this._public);
      this._window = null;
      // Removing reference from the windows array.
      windows.splice(windows.indexOf(this), 1);
      this._removeAllListeners();
    },
    _privateBrowsingObserver: {},
    _initWindowPrivateBrowser: function() {
      let unloaded = false;
      let emitPBChange = (function() {
        // need this check because there will be a delay between the moment
        // that our reference to this observer is removed, and the moment
        // that the observer is garbage collected
        if (unloaded) return;
        let browserWindowsPrivate = browser(browserWindows).internals;
        this._emitOnObject(browserWindows, 'private-browsing', this._public);
        browserWindowsPrivate._emit('private-browsing', this._public);
      }.bind(this));

      // check that per-window private browsing events is implemented
      if (isWindowPBEnabled(this._window)) {
        // create the observer and keep a reference to it
        this._privateBrowsingObserver = {
          QueryInterface: function(iid) {
            if (Ci.nsIPrivacyTransitionObserver.equals(iid) ||
                Ci.nsISupportsWeakReference.equals(iid) ||
                Ci.nsISupports.equals(iid))
              return this;
            throw Cr.NS_ERROR_NO_INTERFACE;
          },
          privateModeChanged: emitPBChange
        };

        // add the observer
        this._window.gBrowser.docShell.addWeakPrivacyTransitionObserver(this._privateBrowsingObserver);
      }
      else {
        let pb = require('./private-browsing');
        pb.on('start', emitPBChange);
        pb.on('stop', emitPBChange);

        // on close cleanup
        this.once('close', function onUnload(window) {
          pb.removeListener('start', emitPBChange);
          pb.removeListener('stop', emitPBChange);
        });
      }

      this.once('close', function onUnload() {
        unloaded = true;
        this._privateBrowsingObserver = {};
      }.bind(this));
    },
    close: function close(callback) {
      // maybe we should deprecate this with message ?
      if (callback) this.on('close', callback);
      return this._close();
    }
  })
);

/**
 * Gets a `BrowserWindowTrait` for the given `chromeWindow` if previously
 * registered, `null` otherwise.
 */
function getRegisteredWindow(chromeWindow) {
  for each (let window in windows) {
    if (chromeWindow === window._window)
      return window;
  }

  return null;
}

/**
 * Wrapper for `BrowserWindowTrait`. Creates new instance if wrapper for
 * window doesn't exists yet. If wrapper already exists then returns it
 * instead.
 * @params {Object} options
 *    Options that are passed to the the `BrowserWindowTrait`
 * @returns {BrowserWindow}
 * @see BrowserWindowTrait
 */
function BrowserWindow(options) {
  let window = null;

  if ("window" in options)
    window = getRegisteredWindow(options.window);

  return (window || BrowserWindowTrait(options))._public;
}
// to have proper `instanceof` behavior will go away when #596248 is fixed.
BrowserWindow.prototype = BrowserWindowTrait.prototype;
exports.BrowserWindow = BrowserWindow;

const windows = [];

const browser = ns();

function onWindowActivation (chromeWindow, event) {
  if (!isBrowser(chromeWindow)) return; // Ignore if it's not a browser window.

  let window = getRegisteredWindow(chromeWindow);

  if (window)
    window._emit(event.type, window._public);
  else
    window = BrowserWindowTrait({ window: chromeWindow });

  browser(browserWindows).internals._emit(event.type, window._public);
}

windowObserver.on("activate", onWindowActivation);
windowObserver.on("deactivate", onWindowActivation);

/**
 * `BrowserWindows` trait is composed out of `List` trait and it represents
 * "live" list of currently open browser windows. Instance mutates itself
 * whenever new browser window gets opened / closed.
 */
// Very stupid to resolve all `toStrings` but this will be fixed by #596248
const browserWindows = Trait.resolve({ toString: null }).compose(
  List.resolve({ constructor: '_initList' }),
  EventEmitter.resolve({ toString: null }),
  WindowTrackerTrait.resolve({ constructor: '_initTracker', toString: null }),
  Trait.compose({
    _emit: Trait.required,
    _add: Trait.required,
    _remove: Trait.required,

    // public API

    /**
     * Constructor creates instance of `Windows` that represents live list of open
     * windows.
     */
    constructor: function BrowserWindows() {
      browser(this._public).internals = this;

      this._trackedWindows = [];
      this._initList();
      this._initTracker();
      unload.ensure(this, "_destructor");
    },
    _destructor: function _destructor() {
      this._removeAllListeners('open');
      this._removeAllListeners('close');
      this._removeAllListeners('activate');
      this._removeAllListeners('deactivate');
      this._clear();

      delete browser(this._public).internals;
    },
    /**
     * This property represents currently active window.
     * Property is non-enumerable, in order to preserve array like enumeration.
     * @type {Window|null}
     */
    get activeWindow() {
      let window = windowUtils.activeBrowserWindow;

      return window ? BrowserWindow({window: window}) : null;
    },
    open: function open(options) {
      if (typeof options === "string")
        // `tabs` option is under review and may be removed.
        options = { tabs: [Options(options)] };
      return BrowserWindow(options);
    },

     /**
      * Internal listener which is called whenever new window gets open.
      * Creates wrapper and adds to this list.
      * @param {nsIWindow} chromeWindow
      */
    _onTrack: function _onTrack(chromeWindow) {
      if (!isBrowser(chromeWindow)) return;
      let window = BrowserWindow({ window: chromeWindow });
      this._add(window);
      this._emit('open', window);
    },
    /**
     * Internal listener which is called whenever window gets closed.
     * Cleans up references and removes wrapper from this list.
     * @param {nsIWindow} window
     */
    _onUntrack: function _onUntrack(chromeWindow) {
      if (!isBrowser(chromeWindow)) return;
      let window = BrowserWindow({ window: chromeWindow });
      this._remove(window);
      this._emit('close', window);

      // Bug 724404: do not leak this module and linked windows:
      // We have to do it on untrack and not only when `_onUnload` is called
      // when windows are closed, otherwise, we will leak on addon disabling.
      window.destroy();
    }
  }).resolve({ toString: null })
)();

exports.browserWindows = browserWindows;


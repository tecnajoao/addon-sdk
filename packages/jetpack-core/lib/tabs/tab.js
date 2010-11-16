/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Jetpack.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Irakli Gozalishvili <gozala@mozilla.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */
"use strict";

const { Trait } = require("traits");
const { EventEmitter } = require("events");
const dataUtils = require("utils/data");
const thumbnailUtils = require("utils/thumbnail");
const { validateOptions } = require("api-utils");
const { Enqueued } = require("utils/function");
const { EVENTS } = require("tabs/events");

// Array the inner instances of all the wrapped tabs.
const TABS = [];

/**
 * Trait used to create tab wrappers.
 */
const TabTrait = Trait.compose(EventEmitter, {
  on: Trait.required,
  _emit: Trait.required,
  /**
   * Tab DOM element that is being wrapped.
   */
  _tab: null,
  /**
   * Window wrapper whose tab this object represents.
   */
  window: null,
  constructor: function Tab(options) {
    this._onReady = this._onReady.bind(this);
    this.on('error', this._onError = this._onError.bind(this));
    // In e10s focus won't be synchronous anyway and calling `focus` from
    // constructor will cause creation of two different tab wrappers.
    this.focus = Enqueued(this.focus);
    this._tab = options.tab;
    let window = this.window = options.window;
    // Setting event listener if was passed.
    for each (let type in EVENTS) {
      let listener = options[type.listener];
      if (listener)
        this.on(type.tab, options[type.listener]);
      if ('ready' != type.tab) // window spreads this event.
        window.on(type.window, this._onEvent.bind(this, type.tab));
    }

    this.on(EVENTS.close.tab, this.destroy.bind(this))
    this._browser.addEventListener(EVENTS.ready.dom, this._onReady, true);
    return this;
  },
  _onError: function _onError(error) {
    if (1 <= this._listeners('error').length)
      console.exception(error)
  },
  destroy: function destroy() {
    for each (let type in EVENTS)
      this._removeAllListeners(type.tab);
    this._browser.removeEventListener(EVENTS.ready.dom, this._onReady,
                                            true);
  },

  /**
   * Internal listener that emits public event 'ready' when the page of this
   * tab is loaded.
   */
  _onReady: function _onReady(event) {
    // IFrames events will bubble so we need to ignore those.
    if (event.target == this._contentDocument)
      this._emit(EVENTS.ready.tab, this._public);
  },
  /**
   * Internal tab event router. Window will emit tab related events for all it's
   * tabs, this listener will propagate all the events for this tab to it's
   * listeners.
   */
  _onEvent: function _onEvent(type, tab) {
    if (tab == this._public)
      this._emit(type, tab);
  },
  /**
   * Browser DOM element where page of this tab is currently loaded.
   */
  get _browser() this._window.gBrowser.getBrowserForTab(this._tab),
  /**
   * Window DOM element containing this tab.
   */
  get _window() this._tab.ownerDocument.defaultView,
  /**
   * Document object of the page that is currently loaded in this tab.
   */
  get _contentDocument() this._browser.contentDocument,
  /**
   * Window object of the page that is currently loaded in this tab.
   */
  get _contentWindow() this._browser.contentWindow,

  /**
   * The title of the page currently loaded in the tab.
   * Changing this property changes an actual title.
   * @type {String}
   */
  get title() this._contentDocument.title,
  set title(value) this._contentDocument.title = String(value),
  /**
   * Location of the page currently loaded in this tab.
   * Changing this property will loads page under under the specified location.
   * @type {String}
   */
  get location() String(this._contentDocument.location),
  set location(value) this._contentWindow.location = String(value),
  /**
   * URI of the favicon for the page currently loaded in this tab.
   * @type {String}
   */
  get faveicon() dataUtils.favicon(String(this.location)),
  /**
   * The CSS style for the tab
   */
  get style() null, // TODO
  /**
   * The index of the tab relative to other tabs in the application window.
   * Changing this property will change order of the actual position of the tab.
   * @type {Number}
   */
  get index()
    this._window.gBrowser.getBrowserIndexForDocument(this._contentDocument),
  set index(value) this._window.gBrowser.moveTabTo(this._tab, value),
  /**
   * Thumbnail data URI of the page currently loaded in this tab.
   * @type {String}
   */
  get thumbnail() thumbnailUtils.thumbnailURI(this._contentWindow),
  /**
   * Weather or not tab is pinned (Is an app-tab).
   * Changing value will pin / unpin tab.
   * @type {Boolean}
   */
  get pinned() this._tab.pinned,
  set pinned(value) {
    if (!!value) this._window.gBrowser.pinTab(this._tab);
    else this._window.gBrowser.unpinTab(this._tab);
  },
  /**
   * Make this tab active.
   */
  focus: function focus() {
    this._window.gBrowser.selectedTab = this._tab;
  },
  /**
   * Close the tab
   */
  close: function close() this._window.gBrowser.removeTab(this._tab)
});

function Tab(options) {
  let chromeTab = options.tab;
  for each (let tab in TABS) {
    if (chromeTab == tab._tab)
      return tab._public
  }
  let tab = TabTrait(options);
  TABS.push(tab);
  return tab._public;
}
Tab.prototype = TabTrait.prototype
exports.Tab = Tab

function Options(options) {
  if ("string" === typeof options)
    options = { url: options };

  return validateOptions(options, {
    url: { is: ["string"] },
    inBackground: { is: ["undefined", "boolean"] },
    pinned: { is: ["undefined", "boolean"] },
    onOpen: { is: ["undefined", "function"] },
    onClose: { is: ["undefined", "function"] },
    onReady: { is: ["undefined", "function"] },
    onActivate: { is: ["undefined", "function"] },
    onDeactivate: { is: ["undefined", "function"] }
  });
}
exports.Options = Options;

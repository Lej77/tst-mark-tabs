'use strict';

import {
    DisposableCollection,
} from '../common/disposables.js';

import {
    EventListener,
    EventManager,
    PassthroughEventManager,
} from '../common/events.js';


/**
 * @typedef {import('../common/utilities.js').BrowserTab} BrowserTab
 */
null;

/**
 * @typedef {import('../common/events.js').EventSubscriber<T>} EventSubscriber<T>
 * @template {any[]} T
 */
null;

/**
 * @typedef SessionDataChangeInfo Info about a session value that was changed.
 * @property {number} Info.entryId Id for the entry whose session data was changed. (This can be a `windowId` or `tabId` depending on the context.)
 * @property {string | undefined} Info.key The key for the value that was changed.
 * @property {string | object | undefined} [Info.newValue] The value that is currently stored in the key.
 */
null;

/**
 * Holds info about the session data for a resource (such as a tab or window). Each key in this object represents data for the corresponding session key.
 *
 * @typedef { { [key: string]: string | Object } } StorageEntry
 */
/**
 * Maps a unique id for a resource that can hold session data such as a tab or window to an object that holds information about that resource's session data.
 *
 * @typedef { { [entryId: number]: StorageEntry } } Storage
 */

/**
 * @typedef {Object} CacheChange
 * @property {number} entryId
 * @property {string} [key]
 * @property {string} [value]
 */


/**
 * Cache session data.
 *
 * This is an abstract storage that can be used with different real storages:
 * - Tab session data. See {@link TabSessionDataCache}.
 * - Window session data. (This storage isn't currently used by this addon.)
 * - Data that isn't actually stored in the browser's session data. (To mimic
 *   the same API.)
 *
 * The entry ids referred to throughout the class documentation is the ids of
 * tabs or windows in these storages. Each such entry can have multiple
 * key-values associated with them.
 *
 * Note that this cache only stores data for specific keys in the session
 * storage.
 *
 * @export
 * @class SessionDataCache
 */
export class SessionDataCache {

    /**
     * Creates an instance of SessionDataCache.
     *
     * @param {Object} config Configure the cache.
     * @param {EventSubscriber<[number]> | null} config.onEntryCreated Event for created entry id.
     * @param {EventSubscriber<[number]> | null} config.onEntryRemoved Event for removed entry id.
     * @param {EventSubscriber<[SessionDataChangeInfo]> | null} config.onEntryChanged Event for changed storage value.
     * @param {null | function(): Promise<number[]>} config.getEntryIds Get all entry ids.
     * @param {null | function(number, string): Promise<string | Object>} config.getStorageValue Get the `storageValue` for a `storageKey` and a `entryId`.
     * @param {string[]} config.monitoredKeys An array of `storageKey` that should be monitored by this cache.
     * @param {null | Storage} config.initialStorage Use this object as storage.
     * @memberof SessionDataCache
     */
    constructor({
        onEntryCreated = null,
        onEntryRemoved = null,
        onEntryChanged = null,
        getEntryIds = null,
        getStorageValue = null,
        monitoredKeys,
        initialStorage = null,
    }) {

        this._isDisposed = false;
        this._onDisposed = new EventManager();
        this._disposables = new DisposableCollection([
            onEntryCreated && new EventListener(onEntryCreated, this._onEntryCreated.bind(this)),
            onEntryRemoved && new EventListener(onEntryRemoved, this._onEntryRemoved.bind(this)),
            onEntryChanged && new EventListener(onEntryChanged, this._onEntryChanged.bind(this)),
        ]);

        /** @type {EventManager<[CacheChange]>} */
        this._onDataChanged = new EventManager();

        this._getEntryIds = getEntryIds;
        this._getStorageValue = getStorageValue;
        this._monitoredKeys = Array.isArray(monitoredKeys) ? monitoredKeys : [];

        /** @type {Storage} */
        this._storage = initialStorage && typeof initialStorage === 'object' ? initialStorage : {};  // Storage{Key: entryId, Value: Data{Key: storageKey, Value: storageValue}}
        this._asyncStorage = new WeakMap();  // {Key: Data, Value: Promise<Data>}

        this._isStarted = false;
        this.start = this._start();
    }

    /** Notify that cached data changed.
     *
     * @param {number} entryId
     * @param {string} [key=undefined] Undefined if the entry was deleted.
     * @param {any} [value=undefined]
     * @memberof SessionDataCache
     */
    _notifyDataChange(entryId, key = undefined, value = undefined) {
        if (this.isDisposed) return;
        /** @type {CacheChange} */
        const details = { entryId };
        if (key) details.key = key;
        if (value) details.value = value;
        this._onDataChanged.fire(details);
    }

    /**
     * Get the data for a new entry.
     *
     * @param {Object} Info Info about the new entry.
     * @param {number} Info.entryId Id for the entry.
     * @param {Object} [Info.data] The data object to use. Can include initial values.
     * @param {boolean} [Info.addToStorage] Add the data object to the cached storage.
     * @param {boolean} [Info.addToAsyncStorage] Add the promise that will get the initial values for the monitored keys to the async storage.
     * @returns {Promise<Object>} The data for the new entry.
     * @memberof SessionDataCache
     */
    _createDataForEntry({ entryId, data = null, addToStorage = true, addToAsyncStorage = true }) {
        if (!data)
            data = {};
        if (addToStorage)
            this._storage[entryId] = data;


        const promise = this._getStorageValue ? Promise.all(this._monitoredKeys.map(async key => {
            const value = await this._getStorageValue(entryId, key);
            if (value) {
                data[key] = value;
                this._notifyDataChange(entryId, key, value);
            }
        })).then(() => data) : Promise.resolve(data);

        if (addToAsyncStorage)
            this._asyncStorage.set(data, promise);

        return promise;
    }

    async _start() {
        try {
            if (this._getEntryIds && typeof this._getEntryIds === 'function') {
                const entryIds = await this._getEntryIds();
                await Promise.all(entryIds.map(entryId => this._createDataForEntry({ entryId, data: this._storage[entryId] /* Preserve initial storage */ })));
            }
            return true;
        } catch (error) {
            console.error('Failed to start session data cache.\nError:\n', error);
        }
        return false;
    }

    /**
     * Determine if an event should be suppressed.
     *
     * @returns {Promise<boolean>} `true` if the event should be suppressed; otherwise `false`.
     * @memberof SessionDataCache
     */
    async _suppressEvent() {
        await this.start;
        if (this.isDisposed)
            return true;
        return false;
    }

    /**
     * Handles value changes for an `entry`.
     *
     * @param {SessionDataChangeInfo} changeInfo Info about entry value that was changed.
     * @memberof SessionDataCache
     */
    async _onEntryChanged({ entryId, key, newValue = undefined }) {
        if (!this._monitoredKeys.includes(key))
            return;
        if (await this._suppressEvent())
            return;

        const data = this._storage[entryId];
        if (!data)
            return; // Data has been removed.

        await this._asyncStorage.get(data); // Wait for data to be initiated.

        if (newValue !== undefined)
            data[key] = newValue;
        else
            delete data[key];

        this._notifyDataChange(entryId, key, newValue);
    }
    /**
     * Handles new entries.
     *
     * @param {number} entryId The id for the created entry.
     * @memberof SessionDataCache
     */
    async _onEntryCreated(entryId) {
        if (await this._suppressEvent())
            return;

        this._createDataForEntry({ entryId });
    }
    /**
     * Handles removed entries.
     *
     * @param {number} entryId The id of the entry that was removed.
     * @memberof SessionDataCache
     */
    async _onEntryRemoved(entryId) {
        if (await this._suppressEvent())
            return;

        const data = this._storage[entryId];
        if (!data)
            return;

        this._asyncStorage.delete(data);
        delete this._storage[entryId];

        this._notifyDataChange(entryId);
    }


    /**
     * Get data for an entry asynchronously to ensure that the data has been created.
     *
     * @param {number} entryId Id for the entry.
     * @returns {Promise<null | StorageEntry>} The data for the entry.
     * @memberof SessionDataCache
     */
    async getDataForEntryId(entryId) {
        await this.start;
        const data = this._storage[entryId];
        if (!data)
            return null;
        const promised = await this._asyncStorage.get(data);
        if (!promised)
            return data;
        return promised;
    }


    dispose() {
        if (this.isDisposed)
            return;

        this._disposables.dispose();
        this._storage = {};
        this._asyncStorage = new WeakMap();
        this._isDisposed = true;
    }
    get onDisposed() {
        return this._onDisposed.subscriber;
    }
    get isDisposed() {
        return this._isDisposed;
    }

    /**
     * Get access to the cached data. Each key is an entry id that holds a new object with that entries data.
     * The data is stored in key value pairs.
     *
     * @readonly
     * @memberof SessionDataCache
     * @returns {Storage} A storage with all cached data.
     */
    get storage() {
        return this._storage;
    }

    /** Get notified when the cached data is modified.
     *
     * @readonly
     * @memberof SessionDataCache
     * @returns {EventSubscriber<[CacheChange]>} An object that can be used to subscribe to the event.
     */
    get onDataChanged() {
        return this._onDataChanged.subscriber;
    }
}


/**
 * Cache session data that is stored in tabs.
 *
 * - Tabs moved between windows lose their session data.
 *
 * @export
 * @class TabSessionDataCache
 */
export class TabSessionDataCache extends SessionDataCache {

    /**
     * Creates an instance of TabSessionDataCache.
     *
     * @param {Object} config Configure the cache.
     * @param {EventSubscriber<[BrowserTab]> | null} [config.onTabCreated] Event for created tabs.
     * @param {EventSubscriber<[number]> | null} [config.onTabRemoved] Event for removed tabs.
     * @param {null | EventSubscriber<[number]>} [config.onTabAttached] Event for tabs attached to new windows. Used to re-set session data for tabs that are moved between windows.
     * @param {EventSubscriber<[SessionDataChangeInfo]> | null} [config.onTabDataChanged] Event for changed tab storage value.
     * @param {false | null | ((tabId: number, key: string) => string | Object)} [config.getTabData] `null` to get tab data via `browser.sessions.getTabValue`. `false` to don't get data. Otherwise a custom function to get data for a tab provided its id and the data key.
     * @param {string[]} config.monitoredKeys An array of `storageKey` that should be monitored by this cache.
     * @param {null | Object} [config.initialStorage] Use this object as storage.
     * @memberof TabSessionDataCache
     */
    constructor({
        onTabCreated = browser.tabs.onCreated,
        onTabRemoved = browser.tabs.onRemoved,
        onTabAttached = browser.tabs.onAttached,
        onTabDataChanged = null,
        getTabData = null,
        monitoredKeys,
        initialStorage = null,
    }) {
        super({
            getEntryIds: TabSessionDataCache.getTabIds,
            getStorageValue: getTabData === null ? TabSessionDataCache.getTabData : (getTabData || null),
            onEntryCreated: onTabCreated && new PassthroughEventManager(onTabCreated, null, (args) => TabSessionDataCache.onTabCreated(args[0])),
            onEntryRemoved: onTabRemoved && new PassthroughEventManager(onTabRemoved, null, (args) => TabSessionDataCache.onTabRemoved(...args)),
            onEntryChanged: onTabDataChanged,
            monitoredKeys,
            initialStorage,
        });
        if (onTabAttached)
            this._disposables.trackDisposables(new EventListener(onTabAttached, this._onTabAttached.bind(this)));
    }

    /**
     * Handles tabs attached to new windows.
     *
     * @param {number} tabId ID of the tab that closed.
     * @param {Object} attachInfo ID of the new window, and index of the tab within it.
     * @param {number} attachInfo.newWindowId ID of the new window.
     * @param {number} attachInfo.newPosition Index position that the tab has in the new window.
     * @memberof TabSessionDataCache
     */
    async _onTabAttached(tabId, { newWindowId, newPosition }) {
        let data;
        try {
            data = await this.getDataForEntryId(tabId);
            if (!data) return; // closed tab.
            if (Object.keys(data).length === 0) return; // No data.

            await Promise.all(Object.entries(data).map(([key, value]) => browser.sessions.setTabValue(tabId, key, value)));
        } catch (error) {
            console.error('Failed to fix session data for tab that was moved between windows.\ntabId: ', tabId, '\nData: ', data);
        }
    }

    /** Parse a tab id as a number
     *
     * @static
     * @param {string | number} tabId A tab id.
     * @return {number} The id as an integer.
     * @memberof TabSessionDataCache
     */
    static parseTabId(tabId) {
        return typeof tabId === 'string' ? parseInt(tabId) : tabId;
    }

    static async getTabIds() {
        return (await browser.tabs.query({})).map((/** @type {BrowserTab} */ tab) => tab.id);
    }

    /** Get a tabs data directly from the session storage.
     *
     * @static
     * @param {string | number} tabId
     * @param {string} key
     * @return {Promise<any>} The tab's data that was stored in the persisted session.
     * @memberof TabSessionDataCache
     */
    static async getTabData(tabId, key) {
        return browser.sessions.getTabValue(TabSessionDataCache.parseTabId(tabId), key);
    }

    /**
     * Handles new tabs.
     *
     * @param {BrowserTab} tab Details of the tab that was created.
     * @returns {[number]} Arguments to use for onEntryCreated event.
     * @memberof TabSessionDataCache
     */
    static onTabCreated(tab) {
        return [tab.id];
    }
    /**
     * Handles removed tabs.
     *
     * @param {number} tabId ID of the tab that closed.
     * @param {Object} [removeInfo] The tab's window ID, and a boolean indicating whether the window is also being closed.
     * @param {number} [removeInfo.windowId] The window whose tab is closed.
     * @param {boolean} [removeInfo.isWindowClosing] `true` if the tab is being closed because its window is being closed.
     * @returns {[number]} Arguments to use for onEntryRemoved event.
     * @memberof TabSessionDataCache
     */
    static onTabRemoved(tabId, { windowId, isWindowClosing } = {}) {
        return [tabId];
    }
}
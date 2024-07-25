'use strict';
/** This module defines global state to track what tabs are marked. This data
 * might optionally be saved to the browser's persistent session storage.
 * @module
 */

import {
    TabSessionDataCache,
    SessionDataCache,
} from '../common/session-data-cache.js';

import {
    kTAB_DATA_KEY_MARKED,
    kCOLORS,
    onTabSessionValueChanged,
    onTabTempValueChanged,
} from '../common/common.js';

import {
    Timeout,
} from '../common/delays.js';

import {
    deepCopy,
} from '../common/utilities.js';


export let timeToKeepCacheInMilliseconds = 20000;
export let useSessionStorage = false;

/** @type {TabSessionDataCache?} */
let sessionDataCache = null;
/** @type {Timeout?} */
let sessionTimeout = null;

/** Used when data isn't stored in the session. Data will be lost on extension restart
 *  @type {TabSessionDataCache?}
 */
let temporaryCache = null;

/** Parse a tab id as a number.
 *
 * @param {string | number} tabId The tab id as a number or string.
 * @return {number} The id as a number.
 */
function parseTabId(tabId) {
    return typeof tabId === 'string' ? parseInt(tabId) : tabId;
}

/** Specify how long cached values for the browser's session storage should be
 * remembered after we no longer need it before we free the cache to save memory.
 *
 * @export
 * @param {number} value Time in milliseconds.
 */
export function setTimeToKeepCacheInMilliseconds(value) {
    if (value < 0)
        value = -1;
    if (value === timeToKeepCacheInMilliseconds)
        return;

    timeToKeepCacheInMilliseconds = value;

    if (sessionTimeout && sessionTimeout.isActive) {
        sessionTimeout.dispose();
        sessionTimeout = new Timeout(sessionTimeout.callback, timeToKeepCacheInMilliseconds);
    }
}
/** Toggle if the browser's persistent session storage is used.
 *
 *
 * @export
 * @param {boolean} value `true` to start using the persistent session storage.
 */
export function setUseSessionStorage(value) {
    value = Boolean(value);
    if (value === useSessionStorage)
        return;

    useSessionStorage = value;

    if (sessionTimeout)
        sessionTimeout.dispose();

    if (useSessionStorage) {
        if (sessionDataCache) {
            // Will update session data with temp data info and notify listeners of session data that differs from temp data.
            migrateTempData();
        } else {
            // Init session cache to migrate temporary values into session data.
            // Will also load session data into temp data.
            getCache();
        }
    } else {
        if (sessionDataCache) {
            if (timeToKeepCacheInMilliseconds < 0)
                removeSessionCache();
            else
                sessionTimeout = new Timeout(removeSessionCache, timeToKeepCacheInMilliseconds);
        }
    }
}

function hasTempData() {
    return temporaryCache && Object.values(temporaryCache.storage).some(data => Object.keys(data).length > 0);
}

/**
 * Get the cache used to store data.
 *
 * @returns {SessionDataCache} The current data cache.
 */
function getCache() {
    if (useSessionStorage) {
        if (!sessionDataCache) {
            const cache = new TabSessionDataCache({
                monitoredKeys: [kTAB_DATA_KEY_MARKED],
                onTabDataChanged: onTabSessionValueChanged,
                // We set a custom getTabData function so that we can notify TST
                // to update its classes after we restore mark state from
                // session data (this ensures restored recently closed tabs get
                // correctly re-colored):
                getTabData: async (tabId, key) => {
                    const value = await TabSessionDataCache.getTabData(tabId, key);
                    if (value) {
                        onTabTempValueChanged.fire({ entryId: tabId, key, newValue: value });
                    }
                    return value;
                },
            });
            sessionDataCache = cache;
            // Previously used to notify TST when we load an old value from the session storage:
            //
            // cache.onDataChanged.addListener(({ entryId, key, value }) => {
            //     if (useSessionStorage && key) {
            //         const details = { entryId, key };
            //         if (value) details.newValue = value;
            //         onTabTempValueChanged.fire(details);
            //     }
            // });
            cache.start.then(async () => {
                if (sessionDataCache !== cache)
                    return;

                await migrateTempData();
            });
        }
        return sessionDataCache;
    } else {
        if (!temporaryCache) {
            const initialStorage = sessionDataCache && deepCopy(sessionDataCache.storage);
            temporaryCache = new TabSessionDataCache({
                initialStorage,
                monitoredKeys: [kTAB_DATA_KEY_MARKED],
                onTabDataChanged: onTabTempValueChanged,
                // Since we only pretend to store data we won't actually lose
                // that data when a tab is moved between windows, therefore we
                // ignore this event:
                onTabAttached: null,
                getTabData: false,
            });
        }
        return temporaryCache;
    }
}
/** Move temp data about marked tabs to the browser's persistent session storage. */
async function migrateTempData() {
    try {
        const cache = sessionDataCache;
        const tempStorage = temporaryCache && deepCopy(temporaryCache.storage);
        let promise = null;
        if (tempStorage) {
            // Migrate temp data to session storage:
            promise = Promise.all(Object.entries(tempStorage).map(([entryId, data]) => {
                const sessionData = cache.storage[entryId];
                // If there is a value in temp storage then save it to session storage.
                return Promise.all(Object.entries(data).map(async ([key, value]) => {
                    if (sessionData[key] !== value) {   // Only set value if not already set.
                        await browser.sessions.setTabValue(
                            parseTabId(entryId),    // integer
                            key,        // string
                            value       // string or object
                        );
                        onTabSessionValueChanged.fire({ entryId: parseInt(entryId), key, newValue: value });
                    }
                }));
            }));
        }
        // Update temp data to reflect session data (used by TST class sync):
        for (const [entryId, data] of Object.entries(cache.storage)) {
            const tempData = tempStorage && tempStorage[entryId];
            // If there is a value in session storage that doesn't exist in temp storage then notify listeners about it.
            for (const [key, value] of Object.entries(data)) {
                if (!tempData || !(key in tempData)) {
                    // Values that exist in temp data will be migrated to session data.
                    // Therefore we only need to consider values that doesn't exist in the temp data.
                    //
                    // These values should be notified to the temp event so that the changes are noticed
                    // by listeners.
                    onTabTempValueChanged.fire({ entryId: parseInt(entryId), key, newValue: value });
                }
            }
        }
        await promise;
    } catch (error) {
        console.error('Failed to migrate temporary data to session data.\nError:\n', error);
    }

    if (temporaryCache && useSessionStorage) {
        temporaryCache.dispose();
        temporaryCache = null;
    }
}
/** Disable the browser's persistent session data and clear all marker info from it. */
async function removeSessionCache() {
    if (sessionDataCache && !useSessionStorage) {
        try {
            getCache(); // Init temp cache with values from session cache.

            const savedData = deepCopy(sessionDataCache.storage);
            sessionDataCache.dispose();
            sessionDataCache = null;

            await Promise.all(Object.entries(savedData).map(([tabId, data]) => {
                return Promise.all(Object.keys(data).map(async (key) => {
                    const id = parseTabId(tabId);
                    await browser.sessions.removeTabValue(id, key);
                    onTabSessionValueChanged.fire({ entryId: id, key });
                }));
            }));
        } catch (error) {
            console.error('Failed to clear session data.\nError:\n', error);
        }
    }
}

export async function getMarkedTabIds() {
    try {
        const data = getCache();
        await data.start;
        return Object.entries(data.storage).filter(([, tabData]) => {
            const isMarked = Boolean(tabData[kTAB_DATA_KEY_MARKED]);
            return isMarked;
        }).map(([tabId,]) => String(tabId));
    } catch (error) {
        console.error('Failed to get tab ids that are marked.\nError:\n,', error);
        return null;
    }
}
/** Check if a tab is marked with a color.
 *
 * @export
 * @param {number} tabId Id of a tab.
 * @return {Promise<null | keyof kCOLORS>} The color of the tab.
 */
export async function getTabMark(tabId) {
    try {
        const cache = getCache();
        const keyValues = await cache.getDataForEntryId(tabId);
        const value = keyValues[kTAB_DATA_KEY_MARKED];
        return value || null;
    } catch (error) {
        console.error('Failed to get mark status for tab.', '\nTabId: ', tabId, '\nError:\n,', error);
        return null;
    }
}
/** Set the mark for a specific tab.
 *
 * @export
 * @param {number} tabId The id of the tab.
 * @param {keyof kCOLORS} color The color to mark the tab with.
 * @param {Object} Options
 * @param {boolean} [Options.forceSetSessionData = false]
 * @param {boolean} [Options.notifyChange = true]
 * @return {Promise<boolean>} `false` if the operation failed.
 */
export async function createTabMark(tabId, color, { forceSetSessionData = false, notifyChange = true } = {}) {
    try {
        if (!Object.keys(kCOLORS).includes(color)) {
            throw new Error(`Tried to mark a tab with the unknown color "${color}"`);
        }
        if (!forceSetSessionData && (await getTabMark(tabId)) === color) {
            return true;
        }
        const changeDetails = { entryId: tabId, key: kTAB_DATA_KEY_MARKED, newValue: color };
        if (useSessionStorage || forceSetSessionData) {
            await browser.sessions.setTabValue(
                parseTabId(tabId),          // integer
                kTAB_DATA_KEY_MARKED,       // string
                color                       // string or object
            );
            onTabSessionValueChanged.fire(changeDetails);
        }
        if (notifyChange) {
            onTabTempValueChanged.fire(changeDetails);
        }
        return true;
    } catch (error) {
        console.error(`Failed to mark tab with id ${tabId}.\nError:\n,`, error);
    }
    return false;
}
/** Remove a mark from a tab.
 *
 * @export
 * @param {number | number[]} tabId
 * @param {Object} [Options={}]
 * @param {boolean} [Options.forceSetSessionData = false] If this is `true` then the browser's persistent session storage is always updated.
 * @param {boolean} [Options.notifyChange = true] `true` if we should update TST state as well. We can sometimes skip this if we are clearing session data but session data isn't kept in sync with marker state.
 * @return {Promise<boolean>} `false` if the function failed.
 */
export async function removeTabMark(tabId, { forceSetSessionData = false, notifyChange = true } = {}) {
    try {
        if (Array.isArray(tabId)) {
            await Promise.all(tabId.map(tabId => removeTabMark(tabId, { forceSetSessionData, notifyChange })));
        } else {
            if (!forceSetSessionData && (await getTabMark(tabId)) === null) {
                return true;
            }
            const changeDetails = { entryId: tabId, key: kTAB_DATA_KEY_MARKED };
            if (useSessionStorage || forceSetSessionData) {
                await browser.sessions.removeTabValue(
                    parseTabId(tabId),    // integer
                    kTAB_DATA_KEY_MARKED, // string
                );
                onTabSessionValueChanged.fire(changeDetails);
            }
            if (notifyChange) {
                onTabTempValueChanged.fire(changeDetails);
            }
        }
        return true;
    } catch (error) {
        console.error(`Failed to un-mark tab with id ${JSON.stringify(tabId)}.\nError:\n,`, error);
    }
    return false;
}



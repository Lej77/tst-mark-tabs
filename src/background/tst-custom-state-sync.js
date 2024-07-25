'use strict';

/**
 * This module defines global state (using {@link TSTCustomStateCache}) to track
 * what classes are set in TST and syncs those classes with the wanted states by
 * listening to the {@link onTabTempValueChanged} event.
 *
 * This module also tracks what class names to use in TST's sidebar.
 *
 * @module
 */

import {
    TSTCustomStateCache,
} from '../tree-style-tab/custom-state-cache.js';

import {
    EventListener,
} from '../common/events.js';

import {
    kCOLORS,
    kTAB_DATA_KEY_MARKED,
    onTabTempValueChanged,
} from '../common/common.js';

import {
    getMarkedTabIds,
    getTabMark,
} from '../background/marker-tab-data.js';
import { notifyTabStateToTST } from '../tree-style-tab/custom-state.js';


/**
 * @typedef {Object} CacheEvent
 * @property {number} entryId
 * @property {string} className
 * @property {boolean} value
 */


/** @type {string | null} */
export let TSTMarkedState = null;
export let TSTSyncEnabled = false;


/** @type {TSTCustomStateCache | null} */
let cache = null;
/** @type {EventListener | null} Updates TST states when mark color is changed. */
let markChangeListener = null;

let currentOp = null;
let isStarting = false;

function stop() {
    if (isStarting) return;

    if (markChangeListener) {
        markChangeListener.dispose();
        markChangeListener = null;
    }
    if (cache) {
        const c = cache;
        cache = null;

        const lastOp = currentOp;
        currentOp = (async () => {
            try {
                await lastOp;
                await c.clear();    // Remove state from tree style tab.
                c.dispose();
            } catch (error) {
                console.error('Failed to stop Tree Style Tab custom state syncing.\nError:\n', error);
            }
        })();
        return currentOp;
    }
}
function start(clearTSTStates = true) {
    if (!TSTSyncEnabled) return;
    if (isStarting) return;

    isStarting = true;
    const lastOp = currentOp;
    currentOp = (async () => {
        try {
            try {
                await lastOp;
            } finally {
                isStarting = false;
            }
            if (!TSTSyncEnabled || !TSTMarkedState) return;
            if (cache) return;

            const statePrefix = TSTMarkedState;
            const c = new TSTCustomStateCache({
                classNames: Object.keys(kCOLORS).map(col => statePrefix + col),
            });
            cache = c;

            try {
                if (clearTSTStates) {
                    /** @type {import('../common/utilities.js').BrowserTab[]} */
                    const allTabs = await browser.tabs.query({});
                    await notifyTabStateToTST(allTabs.map(tab => tab.id), Object.keys(kCOLORS).map(col => statePrefix + col), false);
                }

                if (!markChangeListener) {
                    // Ensure TST state are updated when marked tabs are changed:
                    markChangeListener = new EventListener(onTabTempValueChanged, (args) => {
                        const { entryId, key, newValue = null } = args;

                        if (key !== kTAB_DATA_KEY_MARKED) return;

                        for (const color of Object.keys(kCOLORS)) {
                            c.set(entryId, statePrefix + color, color === newValue);
                        }
                    });
                }

                // Ensure TST classes are added for all marked tabs:
                const markedTabIds = await getMarkedTabIds();
                await Promise.all(markedTabIds.map(async (tabId) => c.set(parseInt(tabId), statePrefix + await getTabMark(parseInt(tabId)), true)));
            } catch (error) {
                console.error('Failed to set Tree Style Tab states for marked tabs.\nError:\n', error);
            }
        } catch (error) {
            console.error('Failed to start Tree Style Tab custom state syncing.\nError:\n', error);
        }
    })();
    return currentOp;
}

/** Assume TST lost its state and notify it about any marked tabs. */
export function forceNotifyTSTState() {
    if (cache) {
        stop();
        return start(
            // Don't try to remove classes that might already exist in TST:
            false
        );
    }
}


/** Set the name of the class that will be used in TST's sidebar for marked
 * tabs.
 *
 * @export
 * @param {string} value
 */
export function setTSTMarkedState(value) {
    if (!value) {
        value = null;
    } else if (typeof value !== 'string') {
        return;
    }

    if (value === TSTMarkedState) return;

    TSTMarkedState = value;

    // Restart:
    stop();
    start();
}

/** Toggle if we are setting TST classes for marked tabs.
 *
 * @export
 * @param {boolean} value
 */
export function setTSTSyncEnabled(value) {
    value = Boolean(value);
    if (TSTSyncEnabled === value) return;

    TSTSyncEnabled = value;

    if (TSTSyncEnabled)
        start();
    else
        stop();
}

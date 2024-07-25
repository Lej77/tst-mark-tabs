'use strict';

import {
    getTSTTabs,
} from '../tree-style-tab/utilities.js';

import {
    notifyTabStateToTST,
} from '../tree-style-tab/custom-state.js';

import {
    DisposableCollection,
} from '../common/disposables.js';

import {
    EventListener,
} from '../common/events.js';

import {
    delay,
} from '../common/delays.js';


/**
 * @typedef {import('../common/events.js').EventSubscriber<T>} EventSubscriber<T>
 * @template {any[]} T
 */
null;

/**
 * @typedef StateChangeEventArgs Info about a change of a custom Tree Style Tab state.
 * @property {number} Info.tabId Id for the affected tab.
 * @property {string} Info.className The name of the class that is affected.
 * @property {boolean} Info.value `true` if the state should be added and `false` if it should be removed.
 * @property {boolean} [Info.apply] `true` if the state should be applied to Tree Style Tab and `false` if it is already applied. Defaults to `true` if not defined.
 */
null;


/**
 * Cache tab states from Tree Style Tab. These "states" are simply classes that are added to a tab in Tree Style Tab's sidebar.
 *
 * - Tabs moved between windows lose their state
 * - Re opening sidebar doesn't remove state.
 *    - It might re-add it though if the tab lost it due to being moved between windows.
 * - Restarting Tree Style Tab resets the state for all tabs.
 *
 * @export
 * @class TSTCustomStateCache
 */
export class TSTCustomStateCache {

    /**
     * Creates an instance of TSTCustomStateCache.
     * @param {Object} config Configure how the cache in set up.
     * @param {null | string | string[]} config.classNames The name of the class that will be applied to tabs in Tree Style Tab's sidebar. `null` to cache all class names.
     * @param {null | EventSubscriber<[number]>} [config.onTabRemoved] Event for removed tabs.
     * @param {null | EventSubscriber<[number]>} [config.onTabAttached] Event for tabs attached to new windows.
     * @param {null | EventSubscriber<[StateChangeEventArgs]>} [config.onStateChanged] Event for state changes.
     * @memberof TSTCustomStateCache
     */
    constructor({
        classNames,
        onTabRemoved = browser.tabs.onRemoved,
        onTabAttached = browser.tabs.onAttached,
        onStateChanged = null,
    }) {
        /** @type {null | string[]} */
        this._classNames = (classNames || null) && (Array.isArray(classNames) ? classNames : [classNames]);

        /** @type { { [className: string]: { cache: Object, ops: Object } } } */
        this._statesCaches = {};
        // Key: className, Value: {
        //  cache: { Key: tabId, Value: boolean (true if class is present for the specified tab.) },
        //  ops: { Key: tabId, Value: Promise<void> (resolves when the last operation on the tab is completed.) }
        //  }

        this._disposables = new DisposableCollection([
            onTabRemoved && new EventListener(onTabRemoved, this._onTabRemoved.bind(this)),
            onStateChanged && new EventListener(onStateChanged, this._onStateChanged.bind(this)),
            onTabAttached && new EventListener(onTabAttached, this._onTabAttached.bind(this)),
        ]);
    }

    /**
     * Handles removed tabs.
     *
     * @param {number} tabId ID of the tab that closed.
     * @param {Object} removeInfo The tab's window ID, and a boolean indicating whether the window is also being closed.
     * @param {number} removeInfo.windowId The window whose tab is closed.
     * @param {boolean} removeInfo.isWindowClosing `true` if the tab is being closed because its window is being closed.
     * @memberof TabSessionDataCache
     */
    _onTabRemoved(tabId, { windowId, isWindowClosing }) {
        Object.keys(this._statesCaches).map(state => {
            this._queueOp({
                tabId,
                state,
                callback: () => {
                    const cache = this._getCache(state);
                    if (cache)
                        delete cache.cache[tabId];

                    return true;
                },
                setOpReturnValue: true
            });
        });
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
        let states;
        try {
            // Simpler method (worse performance, only one attempt):
            // this.forceNotifyTST(tabId, { remove: false });

            states = this.getTabStates(tabId);
            if (states.length === 0) return;

            for (let attempt = 0; attempt < 4; attempt++) {
                await delay(250 * (attempt + 1));

                states = this.getTabStates(tabId);
                if (states.length === 0) return;

                await notifyTabStateToTST(tabId, states, true);
            }
        } catch (error) {
            console.error('Failed to re-apply Tree Style Tab state for tab that was moved between windows.\ntabId: ', tabId, '\nStates: ', states, '\nError:\n', error);
        }
    }

    /**
     * Handles set state requests.
     *
     * @param {Partial<StateChangeEventArgs>} details Info about the changes that should be made.
     * @memberof TSTCustomStateCache
     */
    _onStateChanged({ tabId = null, className = null, value = null, apply = true } = {}) {
        if (tabId === null) {
            return;
        } else if (apply) {
            this.set(tabId, className, value);
        } else {
            const cache = this._getCache(className);
            if (!cache) return;
            cache.cache[tabId] = Boolean(value);
        }
    }

    /**
     * Get the cache for a specific class name.
     *
     * @param {string} state The class name for the state.
     * @returns {null | { cache: Object, ops: Object }} The cache for the state or `null` if the state isn't allowed.
     * @memberof TSTCustomStateCache
     */
    _getCache(state) {
        if (this.isDisposed || !state || (this._classNames && !this._classNames.includes(state)))
            return null;

        let cache = this._statesCaches[state];
        if (!cache) {
            cache = {
                ops: {},
                cache: {},
            };
            this._statesCaches[state] = cache;
        }
        return cache;
    }

    /**
     * Queue operations for the same tab after each other so that they are synchronous.
     *
     * @template T
     * @param {Object} details Info about the queued operation.
     * @param {number} details.tabId The id of the tab that the operation should be synchronized for.
     * @param {function(): Promise<T> | T} details.callback This callback will be called when the operation should be executed. It might not be called if the tab was closed before the op was queued.
     * @param {string} details.state The className that is affected.
     * @param {boolean} [details.setOpReturnValue] Indicates if the cached operation should return the same value as the callback.
     * @param {T} [details.defaultValue] If the callback isn't called then this value will be returned instead.
     * @returns {Promise<T>} The value returned from the callback.
     * @memberof TSTCustomStateCache
     */
    async _queueOp({ tabId, callback, state, setOpReturnValue = false, defaultValue = undefined }) {
        const cache = this._getCache(state);
        if (!cache) return defaultValue;

        let alreadyDone = false;
        /** @type {T} */
        let value = defaultValue;
        let outerError = null;

        const lastOp = cache.ops[tabId];
        const promise = (async () => {
            const lastResult = await lastOp;
            if (lastResult)
                return lastResult;

            if (this.isDisposed)
                return;

            try {
                value = await callback();
            } catch (error) {
                outerError = error;
            }
            alreadyDone = true;

            if (setOpReturnValue)
                return value;
        })();

        if (!alreadyDone) {
            cache.ops[tabId] = promise;
            await promise;
            if (cache.ops[tabId] === promise) {
                delete cache.ops[tabId];
            }
        }

        if (outerError)
            throw outerError;
        return value;
    }

    /**
     * Filter the states that should be affected. If the cache already has a filter then only entires that occur in both filters will be affected.
     *
     * @param {null | string | string[]} states The states that should be affected.
     * @returns {null | string[]} The states that are affected.
     * @memberof TSTCustomStateCache
     */
    _getAffectedStates(states) {
        let affectedStates = (states || null) && (Array.isArray(states) ? states.slice() : [states]);
        if (this._classNames) {
            if (affectedStates) {
                affectedStates = affectedStates.filter(state => this._classNames.includes(state));
            } else {
                affectedStates = this._classNames.slice();
            }
        }
        return affectedStates;
    }

    /**
     * Get tab states from Tree Style Tab. (Sometimes Tree Style Tab doesn't return the correct state information?)
     *
     * @param {null | number | number[]} tabIds Ids for tabs whose state should be updated from Tree Style Tab. Use `null` to update all tabs.
     * @param {Object} details Customize what data is retrieved from Tree Style Tab.
     * @param {null | string | string[]} details.states The states that should be retrieved from Tree Style Tab.
     * @param {boolean} details.remove Remove a tab's state from the cache if the state isn't present in Tree Style Tab.
     * @param {boolean} details.add Add the state to tabs in the cache if the state is present in Tree Style Tab.
     * @memberof TSTCustomStateCache
     */
    async updateFromTST(tabIds = null, { states = null, remove = true, add = true } = /** @type {any} */ ({})) {
        if (this.isDisposed) return;
        if (!remove && !add) return;

        let affectedStates = this._getAffectedStates(states);
        if (affectedStates && affectedStates.length === 0) return;

        if (!tabIds && tabIds !== 0) {
            tabIds = (await browser.tabs.query({})).map(tab => tab.id);
            if (this.isDisposed) return;
        } else if (!Array.isArray(tabIds)) {
            tabIds = [tabIds];
        }

        const tstTabs = await getTSTTabs(/** @type {number[]} */(tabIds));
        if (this.isDisposed) return;


        if (affectedStates) {
            // Known state names:
            for (const state of affectedStates) {
                const cache = this._getCache(state);
                if (cache) {
                    for (const tab of tstTabs) {
                        const hasState = tab.states.includes(state);
                        if (hasState) {
                            if (add)
                                cache.cache[tab.id] = true;
                        } else {
                            if (remove)
                                delete cache.cache[tab.id];
                        }
                    }
                }
            }
        } else {
            // Any state names:

            // Remember states that might need to be removed:
            let originalStates = Object.keys(this._statesCaches);
            if (originalStates.length === 0) {
                originalStates = null;
            }

            for (const tab of tstTabs) {
                if (add) {
                    const statesToRemove = remove && originalStates && originalStates.slice();
                    for (const state of tab.states) {
                        if (statesToRemove) {
                            const index = statesToRemove.indexOf(state);
                            if (index >= 0) statesToRemove.splice(index, 1);
                        }
                        const cache = this._getCache(state);
                        if (cache) {
                            cache.cache[tab.id] = true;
                        }
                    }
                    for (const state of statesToRemove) {
                        const cache = this._getCache(state);
                        if (cache) {
                            delete cache.cache[tab.id];
                        }
                    }
                } else {
                    for (const state of originalStates) {
                        const hasState = tab.states.includes(state);
                        if (!hasState) {
                            const cache = this._getCache(state);
                            if (cache) {
                                delete cache.cache[tab.id];
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Ensure cache is correct by notifying Tree Style Tab about tabs.
     *
     * @param {null | number | number[]} tabIds Ids for tabs whose state should be notified without caching to Tree Style Tab. Use `null` to update all tabs.
     * @param {Object} details Customize what data is notified to Tree Style Tab.
     * @param {null | string | string[]} details.states The states that Tree Style Tab should be notified about.
     * @param {boolean} details.remove Notify Tree Style Tab to remove the state from tabs that shouldn't have it.
     * @param {boolean} details.add Notify Tree Style Tab to add the state to tabs that should have it.
     * @returns {Promise<boolean>} `true` if the tab states was successfully updated for the tabs; otherwise `false`.
     * @memberof TSTCustomStateCache
     */
    async forceNotifyTST(tabIds = null, { states = null, remove = true, add = true } = /** @type {any} */ ({})) {
        if (this.isDisposed) return false;
        if (!remove && !add) return;

        let affectedStates = this._getAffectedStates(states);
        if (!affectedStates) {
            affectedStates = Object.keys(this._statesCaches);
        }
        if (affectedStates.length === 0) return;

        if (!tabIds && tabIds !== 0) {
            tabIds = (await browser.tabs.query({})).map(tab => tab.id);
            if (this.isDisposed) return false;
        } else if (!Array.isArray(tabIds)) {
            tabIds = [tabIds];
        }

        return (await Promise.all(affectedStates.map(async (affectedState) => {
            const tabIdsWithState = await Promise.all((/** @type {number[]} */ (tabIds)).map(async (tabId) => {
                const hasState = await this.getAfterChanges(tabId, affectedState);
                return /** @type {[number, boolean]} */ ([tabId, hasState]);
            }));

            if (this.isDisposed) return false;

            // Batch notifications as remove and add.
            const notify = async (hasState, enabled = true) => {
                if (!enabled) return true;
                hasState = Boolean(hasState);
                const tabIds = tabIdsWithState.filter(([tabId, state]) => state == hasState).map(([tabId,]) => tabId);
                return notifyTabStateToTST(tabIds, affectedState, hasState);
            };

            return (await Promise.all([
                notify(false, remove),  // Remove state from tabs.
                notify(true, add),      // Add state to tabs.
            ])).every(success => success);
        }))).every(success => success);
    }

    /**
     * Add or remove the monitored state from a tab.
     *
     * @param {number} tabId The id for the affected tab.
     * @param {string} state The class name of the state that should be set.
     * @param {boolean} value `true` to add the state and `false` to remove it.
     * @returns {Promise<boolean>} `true` if state was successfully changed; otherwise `false`.
     * @memberof TSTCustomStateCache
     */
    async set(tabId, state, value) {
        value = Boolean(value);

        return this._queueOp({
            tabId,
            state,
            callback: async () => {
                try {
                    const currentState = this.get(tabId, state);
                    if (value === currentState)
                        return true;

                    const tstWasNotified = await notifyTabStateToTST(tabId, state, value);
                    if (tstWasNotified) {
                        const cache = this._getCache(state);
                        if (cache) {
                            cache.cache[tabId] = value;
                        }
                    }
                    return tstWasNotified;
                } catch (error) {
                    console.error(`TSTCustomStateCache: Failed to ${value ? 'add' : 'remove'} tab state for Tree Style Tab.\ntabId: `, tabId, '\nError:\n', error);
                }
                return false;
            },
            defaultValue: false,
        });
    }

    /**
     * Check if a tab has the monitored state. It can take a little while before a state is set.
     *
     * @param {number} tabId The id for the tab that should be checked.
     * @param {string} state The state that should be checked for.
     * @returns {boolean} `true` if the specified tab has the state; otherwise `false`.
     * @memberof TSTCustomStateCache
     */
    get(tabId, state) {
        const cache = this._getCache(state);
        if (!cache) return false;
        return Boolean(cache.cache[tabId]);
    }

    /**
     * Wait for any queued changes of a tab's state and then return the final state.
     *
     * @param {number} tabId The id for the tab that should be checked.
     * @param {string} state The state that should be checked for.
     * @returns {Promise<boolean>} `true` if the specified tab has the state; otherwise `false`.
     * @memberof TSTCustomStateCache
     */
    async getAfterChanges(tabId, state) {
        const cache = this._getCache(state);
        if (!cache) return false;
        await cache.ops[tabId];
        return Boolean(cache.cache[tabId]);
    }

    /**
     * Get the ids for all tabs that have the state.
     *
     * @param {string} state The state that the tabs must have.
     * @returns {number[]} The ids of the affected tabs.
     * @memberof TSTCustomStateCache
     */
    getAffectedTabIds(state) {
        const tabIds = [];
        const cache = this._getCache(state);
        if (!cache) return tabIds;

        for (const [tabId, hasState] of Object.entries(cache.cache)) {
            if (hasState) {
                tabIds.push(parseInt(tabId));
            }
        }
        return tabIds;
    }

    /**
     * Get the states for a certain tab.
     *
     * @param {number} tabId The id for the tab.
     * @returns {string[]} The states that the tab has.
     * @memberof TSTCustomStateCache
     */
    getTabStates(tabId) {
        if (this.isDisposed) return [];
        return Object.entries(this._statesCaches).map(([state, cache]) => {
            if (cache.cache[tabId]) {
                return state;
            } else {
                return null;
            }
        }).filter(state => state !== null);
    }

    /**
     * Remove state(s) from all tabs.
     *
     * @param {null | string | string[]} states The affected state(s). Use `null` to affect all states.
     * @returns {Promise<boolean>} `true` if the state was successfully removed from all tabs; otherwise `false`.
     * @memberof TSTCustomStateCache
     */
    async clear(states = null) {
        if (this.isDisposed) return false;

        const ops = [];

        for (const [state, cache] of Object.entries(this._statesCaches)) {
            if (states && !states.includes(state))
                continue;

            ops.push(...Object.entries(cache.cache).map(([tabId, value]) => {
                if (value)
                    return this.set(parseInt(tabId), state, false);
                else
                    return true;
            }));
        }

        return (await Promise.all(ops)).every(success => success);
    }

    /**
     * Clear the cache and stop listening to events. Will not clear/remove the state from tabs in Tree Style Tab's sidebar.
     *
     * @memberof TSTCustomStateCache
     */
    dispose() {
        if (this.isDisposed)
            return;

        this._disposables.dispose();
        this._statesCaches = {};
    }
    get onDisposed() {
        return this._disposables.onDisposed;
    }
    get isDisposed() {
        return this._disposables.isDisposed;
    }

    /**
     * The class names for the states that is monitored. The class names is how the states are represented in Tree Style Tab's sidebars.
     *
     * @returns {null | string[]} The monitored class names. Can be `null` if all class names are monitored.
     * @readonly
     * @memberof TSTCustomStateCache
     */
    get classNames() {
        return this._classNames?.slice();
    }
}

'use strict';

import {
    kMESSAGE_TYPES,
    kICONS,
    settings,
    settingsTracker,
    kCOLORS,
    computeTstStyle,
    getBase64SVGIcon,
    isColorName,
} from '../common/common.js';

import {
    kTST_ID,
    unregisterFromTST,
} from '../tree-style-tab/utilities.js';

import {
    getSelectedTabs,
} from '../common/selected-tabs.js';

import {
    createTabMark,
    getTabMark,
    removeTabMark,
    useSessionStorage,
    setUseSessionStorage,
} from '../background/marker-tab-data.js';

import {
    setTSTMarkedState,
    setTSTSyncEnabled,
    forceNotifyTSTState,
} from '../background/tst-custom-state-sync.js';


/**
 * @typedef {import('../common/utilities.js').BrowserTab} BrowserTab
 */
null;



// #region Tree Style Tab

/** @type {null | ((shouldUnregister: boolean) => void)} */
let lastWaitForShutdownPromiseResolve = null;
/** @type {EventListener} A listener for an event that will be triggered when the extension is disabled. */
window.addEventListener('beforeunload', () => {
    if (lastWaitForShutdownPromiseResolve) {
        lastWaitForShutdownPromiseResolve(true);
        lastWaitForShutdownPromiseResolve = null;
    }
});
async function registerToTST() {
    try {
        await unregisterFromTST();
        if (!settings.enabled)
            return true;
        if (
            (!settings.tst_class_enabled || !settings.tst_class_name) &&
            (!settings.tst_customStyle_enabled || !settings.tst_customStyle)
        ) {
            return true;
        }

        const listeningTypes = [
            'ready',
            // Re-add colors to tabs in private windows:
            'permissions-changed',
            // Remove colors when this addon is disabled:
            'wait-for-shutdown',
        ];

        const style = computeTstStyle(settings);

        const registrationDetails = {
            type: 'register-self',
            name: browser.runtime.getManifest().name,
            listeningTypes,
            // Note: old styles won't be removed if we send a false-like value:
            style: style || ' ',
        };
        await browser.runtime.sendMessage(kTST_ID, registrationDetails);
    } catch (error) {
        console.error('Failed to register to Tree Style Tab.\nError:\n', error);
        return false;
    }
    return true;
}

// #endregion Tree Style Tab

/**
 * Toggle marker on some tabs.
 *
 * @param {Object} details Configure what markers should be toggled.
 * @param {keyof kCOLORS} details.colorToToggle The color to toggle on or off.
 * @param {null | BrowserTab | BrowserTab[]} details.tabs Tabs whose marker should be toggled.
 */
async function toggleTabColor({ tabs, colorToToggle } = /**@type {any}*/ ({})) {
    if (!settings.enabled || !tabs)
        return;
    if (!Array.isArray(tabs))
        tabs = [tabs];
    if (!Object.keys(kCOLORS).includes(colorToToggle)) {
        throw new Error(`Can't toggle the unknown color "${colorToToggle}"`);
    }

    const tabIds = tabs.map(tab => tab.id);

    // Are most tabs marked or un-marked?
    const currentState = await Promise.all(tabIds.map(tabId => getTabMark(tabId)));

    const totalCount = currentState.filter(state => state !== undefined).length; // Count without errors.
    const markedCount = currentState.filter(state => state === colorToToggle).length; // Count for marked tabs.

    if (markedCount < totalCount) {
        await Promise.all(tabIds.map(tabId => createTabMark(tabId, colorToToggle)));
    } else {
        await removeTabMark(tabIds);
    }
}

/**
 * Toggle marker on some tabs.
 *
 * @param {Object} details
 * @param {keyof kCOLORS} [details.value] If `undefined` then color is cleared.
 * @param {null | BrowserTab | BrowserTab[]} details.tabs Tabs whose mark should be changed.
 */
async function setTabColor({ tabs, value = 'toolbar' } = /**@type {any}*/ ({})) {
    if (!settings.enabled || !tabs)
        return;
    if (!Array.isArray(tabs))
        tabs = [tabs];

    const tabIds = tabs.map(tab => tab.id);

    if (value !== 'toolbar') {
        await Promise.all(tabIds.map(tabId => createTabMark(tabId, value)));
    } else {
        await removeTabMark(tabIds);
    }
}


let hasContextMenu = false;
let currentContextMenuOp = null;
let isUpdatingContextMenu = false;
async function updateContextMenu() {
    if (isUpdatingContextMenu) return;

    const lastOp = currentContextMenuOp;
    currentContextMenuOp = (async () => {
        try {
            isUpdatingContextMenu = true;
            try {
                await lastOp;
            } catch (error) { }
            isUpdatingContextMenu = false;

            if (!settings.enabled || !settings.contextMenu_setColor_enabled) {
                if (hasContextMenu) {
                    await browser.menus.removeAll();
                    hasContextMenu = false;
                }
            } else {
                const title = settings.contextMenu_setColor_title || browser.i18n.getMessage("command_MarkTab", "&");
                if (hasContextMenu) {
                    await browser.menus.update("MarkTab", { title });
                } else {
                    await browser.menus.removeAll();

                    await browser.menus.create({
                        id: "MarkTab",
                        title,
                        contexts: ["tab"]
                    });
                    for (const [color, rgb] of Object.entries(kCOLORS)) {
                        if (color === 'toolbar') {
                            await browser.menus.create({
                                parentId: "MarkTab",
                                type: 'separator',
                                contexts: ['tab'],
                            });
                        }
                        await browser.menus.create({
                            parentId: "MarkTab",
                            id: 'color_' + color,
                            title: browser.i18n.getMessage('color_' + color),
                            contexts: ['tab'],
                            enabled: true,
                            icons: {
                                "16": await getBase64SVGIcon(
                                    color === 'toolbar' ? kICONS.none : kICONS.circle,
                                    rgb + /*alpha:*/ 'ff'
                                ),
                            },
                        });
                    }
                    hasContextMenu = true;
                }
            }
        } catch (error) {
            console.error('Failed to update context menu.\nError:\n', error);
        }
    })();
}

/** Set descriptions for keyboard shortcuts that set a specific color. */
function setKeyboardDescriptions() {
    return Promise.all(Array.from(Object.keys(kCOLORS)).map(async (colorName) => {
        try {
            const localizedColorName = browser.i18n.getMessage(`color_${colorName}`) || colorName;
            const description = browser.i18n.getMessage(`command_keyboard_MarkTab`, localizedColorName);
            await browser.commands.update({ name: `SetColor_${colorName}`, description, });
        } catch (error) {
            console.error(`Failed to update description of keyboard shortcut that sets the color ${colorName}:\nError:\n`, error);
        }
    }))
}

(async function () {
    setKeyboardDescriptions();

    // #region Browser Version

    let browserInfo = {};
    let majorBrowserVersion = 60;
    try {
        browserInfo = await browser.runtime.getBrowserInfo();
        majorBrowserVersion = browserInfo.version.split('.')[0];
    } catch (error) { }

    // #endregion Browser Version


    await settingsTracker.start;


    // #region Settings Changes

    settingsTracker.onChange.addListener(changes => {
        if (
            changes.enabled ||
            changes.tst_class_enabled ||
            changes.tst_class_name ||
            changes.tst_customStyle_enabled ||
            (settings.tst_customStyle_enabled &&
                (
                    changes.tst_customStyle ||
                    changes.tst_customStyle_ClassPlaceholder ||
                    (changes.tst_class_name && settings.tst_customStyle_ClassPlaceholder) ||
                    changes.tst_customStyle_ColorPlaceholder ||
                    changes.tst_customStyle_ColorAlpha
                )
            )
        ) {
            registerToTST();
        }

        if (changes.tst_class_enabled || changes.enabled) {
            setTSTSyncEnabled(settings.enabled && settings.tst_class_enabled);
        }
        if (changes.tst_class_name) {
            setTSTMarkedState(settings.tst_class_name);
        }
        if (changes.useSessionStorageForMarkerStatus) {
            setUseSessionStorage(settings.useSessionStorageForMarkerStatus);
        }

        if (
            changes.contextMenu_setColor_title ||
            changes.contextMenu_setColor_enabled ||
            changes.enabled
        ) {
            updateContextMenu();
        }
    });
    setUseSessionStorage(settings.useSessionStorageForMarkerStatus);
    setTSTSyncEnabled(settings.tst_class_enabled);
    setTSTMarkedState(settings.tst_class_name);

    // #endregion Settings Changes


    // #region Context menu and shortcut commands

    browser.menus.onClicked.addListener(async function (/** @type {{ menuItemId: string; }} */ info, /** @type {BrowserTab} */ tab) {
        const tabs = await getSelectedTabs({ tab, majorBrowserVersion });
        if (!info.menuItemId.startsWith('color_')) {
            return;
        }
        const colorName = info.menuItemId.slice('color_'.length);
        if (!isColorName(colorName)) {
            console.warn(`Clicked on context menu item for invalid color: ` + colorName);
        } else {
            setTabColor({ tabs, value: colorName });
        }
    });

    browser.commands.onCommand.addListener(async function (/** @type {string} */ command) {
        if (command == "ToggleColor") {
            const tabs = await getSelectedTabs({ majorBrowserVersion });
            toggleTabColor({ tabs, colorToToggle: settings.command_toggleColor });
        } else if (command.startsWith('SetColor_')) {
            const colorName = command.slice('SetColor_'.length);
            if (!isColorName(colorName)) {
                console.error(`Clicked on context menu item for invalid color: ` + colorName);
            } else {
                const tabs = await getSelectedTabs({ majorBrowserVersion });
                setTabColor({ tabs, value: colorName });
            }
        }
    });
    updateContextMenu();

    // #endregion Context menu and shortcut commands


    // #region Internal Communication

    browser.runtime.onMessage.addListener(async (aMessage, aSender) => {
        if (!aMessage.type) return;
        switch (aMessage.type) {
            case kMESSAGE_TYPES.clearMarkers: {
                const tabIds = (/** @type {BrowserTab[]} */ (await browser.tabs.query({}))).map((tab) => tab.id);
                await removeTabMark(tabIds);
            } break;

            case kMESSAGE_TYPES.clearSessionData: {
                const tabIds = (/** @type {BrowserTab[]} */ (await browser.tabs.query({}))).map((tab) => tab.id);
                await removeTabMark(tabIds, { notifyChange: useSessionStorage, forceSetSessionData: true });
            } break;
        }
    });

    // #endregion Internal Communication


    // #region Tree Style Tab

    browser.runtime.onMessageExternal.addListener((aMessage, aSender) => {
        if (aSender.id !== kTST_ID) {
            return;
        }
        switch (aMessage.type) {
            case 'permissions-changed': // TST might not have allowed us to tell it about tabs in private windows. (Also might need to re-apply CSS.)
            case 'ready': {
                // passive registration for secondary (or after) startup:
                registerToTST();
                forceNotifyTSTState();  // TST has been restarted so need to set all states again.
                return Promise.resolve(true);
            } break;

            // Support removal of custom CSS styles when addon is disabled:
            case 'wait-for-shutdown': {
                return new Promise((resolve, reject) => {
                    try {
                        if (lastWaitForShutdownPromiseResolve) {
                            // Don't keep more than 1 promise alive for this event (cancel the previous one):
                            lastWaitForShutdownPromiseResolve(false);
                        }
                        lastWaitForShutdownPromiseResolve = resolve;
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        }
    });
    if (!registerToTST()) {
        setTimeout(registerToTST, 5000);
    }

    // #endregion Tree Style Tab
})();

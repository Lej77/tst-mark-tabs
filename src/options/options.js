'use strict';

import {
    setTextMessages,
    setMessagePrefix,
    messagePrefix,
} from '../ui/utilities.js';

import {
    bindElementIdsToSettings,
} from '../ui/bind-settings.js';

import {
    createShortcutsArea,
} from '../ui/shortcuts.js';

import {
    bindCollapsableAreas,
} from '../ui/collapsable.js';

import {
    alphaToHex,
    computeTstStyle,
    getBase64SVGIcon,
    kCOLORS,
    kICONS,
    kMESSAGE_TYPES,
    settings,
    settingsTracker,
} from '../common/common.js';

import {
    createStatusIndicator,
} from '../ui/status-indicator.js';

import {
    SettingsTracker,
} from '../common/settings.js';

import {
    delay,
} from '../common/delays.js';
import { bindDependantSettings, setRequiresPrefix } from '../ui/requires.js';


setMessagePrefix('message-');
setRequiresPrefix('requires-')


{
    let embedded = true;
    try {
        embedded = new URLSearchParams(window.location.search).get('embedded') != 'false';
    } catch (error) {
        console.error('Failed to get page query params.\nError: ', error);
    }
    if (embedded) {
        document.documentElement.classList.add('embeddedInExtensionPage');
    }
}


async function initiatePage() {
    setTextMessages();


    // Link to separate option page:
    (/** @type {HTMLAnchorElement} */(document.getElementById('topLinkToOptionsPage'))).href =
        browser.runtime.getURL(browser.runtime.getManifest().options_ui.page + '?embedded=false');


    const collapsableInfo = bindCollapsableAreas({
        enabledCheck: [
            { element: document.getElementById('contextMenuArea'), check: () => settings.contextMenu_setColor_enabled, },
            { element: document.getElementById('tstArea'), check: () => Boolean(settings.tst_customStyle_enabled && settings.tst_customStyle) || Boolean(settings.tst_class_enabled && settings.tst_class_name), }
        ],
    });

    /** @type {(() => void) | null} */
    let updateSelectedColorValue = null;
    const shortcuts = createShortcutsArea({
        commandInfos: {
            'ToggleColor': {
                description: 'command_ToggleColor',
                isCollapsed: false,
                createContent() {
                    const area = document.createElement('div');
                    const p = document.createElement('p');
                    p.classList.add(messagePrefix + 'command_ToggleColor_Description')
                    area.appendChild(p);

                    const selectWithImage = document.createElement('div');
                    selectWithImage.classList.add('select-with-image');
                    area.appendChild(selectWithImage);

                    const img = document.createElement('img');
                    selectWithImage.appendChild(img);

                    const select = document.createElement('select');
                    select.id = "command_toggleColor";
                    selectWithImage.appendChild(select);

                    /**
                     *
                     * @param {string} color
                     * @returns {string}
                     */
                    const toRgbCssTuple = (color) => {
                        if (!color.startsWith('#')) throw new Error(`color starts with #`);
                        color = color.slice(1);
                        if (color.length !== 6) throw new Error(`rgb color should have 6 hex digits`);
                        const r = parseInt(color.slice(0, 2), 16);
                        const g = parseInt(color.slice(2, 4), 16);
                        const b = parseInt(color.slice(4, 6), 16);
                        return `${r}, ${g}, ${b}`;
                    };

                    for (const [color, rgb] of Object.entries(kCOLORS)) {
                        if (color === 'toolbar') continue;
                        const opt = document.createElement('option');
                        opt.classList.add(messagePrefix + 'color_' + color);
                        opt.value = color;
                        opt.setAttribute('style', `--option-color-value: ${toRgbCssTuple(rgb)};`);
                        select.appendChild(opt);
                    }
                    updateSelectedColorValue = () => {
                        const rgb = kCOLORS[select.value];
                        if (rgb === undefined) {
                            select.removeAttribute('style');
                        } else {
                            select.setAttribute('style', `--selected-color-value: ${toRgbCssTuple(rgb)};`);
                            getBase64SVGIcon('circle', rgb + alphaToHex(0.8)).then(image => img.src = image);
                        }
                    };
                    settingsTracker.start.then(updateSelectedColorValue);

                    return area;
                }
            },
        },
        headerMessage: 'options_Commands_Title',
        infoMessage: 'options_Commands_Info',
        resetButtonMessage: 'options_Commands_ResetButton',
        promptButtonMessage: 'options_Commands_PromptButton',
    });
    shortcuts.section.isCollapsed = false;
    document.getElementById('commandsArea').appendChild(shortcuts.area);

    const enabledIndicator = createStatusIndicator({
        headerMessage: 'options_enabled_header',
        disabledMessage: 'options_enabled_false',
        enabledMessage: 'options_enabled_true',
    });
    document.getElementById('enabledIndicator').appendChild(enabledIndicator.area);

    document.getElementById('clearMarkers').addEventListener('click', () => {
        browser.runtime.sendMessage({ type: kMESSAGE_TYPES.clearMarkers });
    });
    document.getElementById('clearSessionData').addEventListener('click', () => {
        browser.runtime.sendMessage({ type: kMESSAGE_TYPES.clearSessionData });
    });

    await settingsTracker.start;
    enabledIndicator.isEnabled = settings.enabled;
    collapsableInfo.checkAll();

    const boundSettings = bindElementIdsToSettings(settings, {
        handleInputEvent: ({ key, value, element }) => {
            if (element.type === 'number') {
                value = parseFloat(value);
                if (isNaN(value))
                    return;
            }
            browser.storage.local.set({ [key]: value });
        },
        onSettingsChanged: settingsTracker.onChange,
        newValuePattern: true,
    });
    const checkRequire = bindDependantSettings();

    const handleLoad = () => {
        shortcuts.update(); // Keyboard Commands
        boundSettings.skipCurrentInputIgnore();
        checkRequire();
    };
    handleLoad();

    const previewStyle = document.getElementById('tst_previewGeneratedStyle');
    settingsTracker.onChange.addListener((changes) => {
        if (changes.enabled) {
            enabledIndicator.isEnabled = settings.enabled;
        }
        collapsableInfo.checkAll();
        previewStyle.textContent = computeTstStyle(settings);
        if (changes.command_toggleColor) {
            updateSelectedColorValue?.();
        }
    });
    previewStyle.textContent = computeTstStyle(settings);

    document.getElementById('disableExtension').addEventListener('click', () => {
        SettingsTracker.set('enabled', false);
    });
    document.getElementById('enabledExtension').addEventListener('click', () => {
        SettingsTracker.set('enabled', true);
    });

    document.getElementById('resetSettingsButton').addEventListener('click', async (e) => {
        let ok = confirm(browser.i18n.getMessage('options_resetSettings_Prompt'));
        if (!ok) {
            return;
        }

        // Reset commands:
        await Promise.all((await browser.commands.getAll()).map(command => browser.commands.reset(command.name)));

        // Clear settings:
        await browser.storage.local.clear();

        // Wait for setting change to be applied:
        await delay(100);

        // Reload settings:
        handleLoad();
    });
}
initiatePage();
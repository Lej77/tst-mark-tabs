'use strict';

import {
    SettingsTracker,
} from '../common/settings.js';

import {
    EventManager,
} from '../common/events.js';



// #region Constants

/** The key to use for session data stored in tabs. */
export const kTAB_DATA_KEY_MARKED = 'marked';

/** Internal messages, for now only sent from options page to the background page. */
export const kMESSAGE_TYPES = Object.freeze({
    clearSessionData: 'clear-session-data',
    clearMarkers: 'clear-markers',
});

/** Colors that we support and their rgb values.
 *
 * Taken from the MIT licensed Sidebery addon:
 * [sidebery/src/defaults.ts at aa476a47f3663230ee5722d1a3cebffe4faf3192 · mbnuqw/sidebery](https://github.com/mbnuqw/sidebery/blob/aa476a47f3663230ee5722d1a3cebffe4faf3192/src/defaults.ts#L17-L27)
 */
export const kCOLORS = Object.freeze({
    blue: '#37adff',
    turquoise: '#00c79a',
    green: '#51cd00',
    yellow: '#ffcb00',
    orange: '#ff9f00',
    red: '#ff613d',
    pink: '#ff4bda',
    purple: '#af51f5',
    toolbar: '#686868',
});

export const kICONS = Object.freeze({
    circle: 'circle',
    none: 'none',
})

// #endregion Constants



// #region Settings

export class DefaultSettings {

    constructor() {
        /** Enable/Disable all extension functionality. This is useful to quickly unregister from Tree Style Tab. */
        this.enabled = true;

        /** @type {keyof kCOLORS} The color that will be toggled using the keyboard shortcut. */
        this.command_toggleColor = 'red';

        /**  */
        this.contextMenu_setColor_enabled = true;
        /** Optional custom title for the root context menu item. */
        this.contextMenu_setColor_title = '';

        this.tst_class_enabled = true;
        this.tst_class_name = 'extension-marked-tab-';


        /** A custom style that should be applied to Tree Style Tab's sidebar. */
        this.tst_customStyle = `
.tab.%CustomClass% tab-item-substance .extra-items-container.behind {
    background-color: %Color% !important;
}
`.trim();

        /** Replace any occurrences of this string in `tst_customStyle` with the value of `tst_class_name`. */
        this.tst_customStyle_ClassPlaceholder = '%CustomClass%';

        this.tst_customStyle_ColorPlaceholder = '%Color%';
        this.tst_customStyle_ColorAlpha = 0.3;

        /** Enable/Disable the custom style for Tree Style Tab's sidebar. */
        this.tst_customStyle_enabled = true;


        /** Store Marker Status as session data. */
        this.useSessionStorageForMarkerStatus = true;
    }
}

/** Determine what the current TST CSS style should be.
 *
 * @param {DefaultSettings} settings The current settings.
 * @returns {null | string} The wanted style.
 */
export function computeTstStyle(settings) {
    if (!settings.tst_customStyle || !settings.tst_customStyle_enabled) {
        return null;
    }
    if (!settings.tst_customStyle_ColorPlaceholder) {
        return settings.tst_customStyle;
    }
    let totalStyle = '';
    for (const [colorName, rgb] of Object.entries(kCOLORS)) {
        if (colorName === 'toolbar') {
            continue;
        }
        let style = `/* Style for ${colorName}: */\n`;
        style += settings.tst_customStyle;
        if (settings.tst_customStyle_ClassPlaceholder && settings.tst_class_name) {
            style = style.replaceAll(settings.tst_customStyle_ClassPlaceholder, settings.tst_class_name + colorName);
        }
        // const alpha = 33; // 20%
        const alpha = alphaToHex(settings.tst_customStyle_ColorAlpha); // 30%

        if (alpha.length > 2) {
            throw new Error(`Alpha was too large: 0x` + alpha)
        }
        style = style.replaceAll(settings.tst_customStyle_ColorPlaceholder, rgb + alpha);
        totalStyle += style + '\n\n';
    }
    return totalStyle;
}

/**
 * Tracks setting changes and applies them to the global settings object.
 * @type {SettingsTracker<DefaultSettings>}
 */
export const settingsTracker = new SettingsTracker({ defaultValues: () => new DefaultSettings() });
/**
 * The extensions settings. Changes to settings data is tracked and will be reflected in this object.
 * @type {DefaultSettings}
 */
export const settings = settingsTracker.settings;

// eslint-disable-next-line valid-jsdoc
/**
 * Load a specific setting as fast as possible.
 *
 * @template {keyof DefaultSettings} K
 * @param {K} key The key of the setting that should be loaded.
 * @returns {Promise<(ReturnType<DefaultSettings>[K])>} The value for the loaded setting.
 */
export function quickLoadSetting(key) {
    // @ts-ignore
    return SettingsTracker.get(key, (new DefaultSettings())[key]);
}

// #endregion Settings



// #region Global Events

/** Tab values that are stored in the session data. Only updates that affect session stored data will be notified via this event.
 * @type {EventManager<[import('../common/session-data-cache.js').SessionDataChangeInfo]>} */
export const onTabSessionValueChanged = new EventManager();

/** Tab values that are reset when the extension is reloaded. All updates of tab markers will be notified via this event.
 * @type {EventManager<[import('../common/session-data-cache.js').SessionDataChangeInfo]>} */
export const onTabTempValueChanged = new EventManager();

// #endregion Global Events



/** @type {Record<string, Record<string, string>>} */
const base64SvgIconsCache = {}
// const xmlSerializer = new XMLSerializer()

/** Fill in a color for an icon.
 *
 * This is part of how Sidebery defines its "set color" context menu for tabs:
 *
 *   - Menu "config": [sidebery/src/defaults/menu.ts at
 *     aa476a47f3663230ee5722d1a3cebffe4faf3192 ·
 *     mbnuqw/sidebery](https://github.com/mbnuqw/sidebery/blob/aa476a47f3663230ee5722d1a3cebffe4faf3192/src/defaults/menu.ts#L15-L16)
 *
 *   - Specifies how the `colorizeTab` option in the config is defined:
 *     [sidebery/src/services/menu.options.tabs.ts at
 *     aa476a47f3663230ee5722d1a3cebffe4faf3192 ·
 *     mbnuqw/sidebery](https://github.com/mbnuqw/sidebery/blob/aa476a47f3663230ee5722d1a3cebffe4faf3192/src/services/menu.options.tabs.ts#L466-L483)
 *
 *     - Defines the available colors that is looped over to create menu items:
 *       [sidebery/src/defaults.ts at aa476a47f3663230ee5722d1a3cebffe4faf3192 ·
 *       mbnuqw/sidebery](https://github.com/mbnuqw/sidebery/blob/aa476a47f3663230ee5722d1a3cebffe4faf3192/src/defaults.ts#L129-L139)
 *
 *     - Defines color translations to different languages:
 *       [sidebery/src/_locales/dict.sidebar.ts at
 *       aa476a47f3663230ee5722d1a3cebffe4faf3192 ·
 *       mbnuqw/sidebery](https://github.com/mbnuqw/sidebery/blob/aa476a47f3663230ee5722d1a3cebffe4faf3192/src/_locales/dict.sidebar.ts#L858-L927)
 *
 *     - Uses `icon_none` for transparent "toolbar" color:
 *       [sidebery/src/assets/none.svg at
 *       aa476a47f3663230ee5722d1a3cebffe4faf3192 ·
 *       mbnuqw/sidebery](https://github.com/mbnuqw/sidebery/blob/aa476a47f3663230ee5722d1a3cebffe4faf3192/src/assets/none.svg)
 *
 *     - Uses `circle` for all other colors: [sidebery/src/assets/circle.svg at
 *       v5 ·
 *       mbnuqw/sidebery](https://github.com/mbnuqw/sidebery/blob/v5/src/assets/circle.svg)
 *
 *   - Function that adds a "fill=..." attribute with color at start of SVG
 *     image: [sidebery/src/services/menu.actions.ts at
 *     aa476a47f3663230ee5722d1a3cebffe4faf3192 ·
 *     mbnuqw/sidebery](https://github.com/mbnuqw/sidebery/blob/aa476a47f3663230ee5722d1a3cebffe4faf3192/src/services/menu.actions.ts#L319-L339)
*
 *     - Defines hex color values for the different color names:
 *       [sidebery/src/defaults.ts at aa476a47f3663230ee5722d1a3cebffe4faf3192 ·
 *       mbnuqw/sidebery](https://github.com/mbnuqw/sidebery/blob/aa476a47f3663230ee5722d1a3cebffe4faf3192/src/defaults.ts#L17-L27)
*
 *
 * Adapted from the MIT licensed addon Sidebery:
 * [sidebery/src/services/menu.actions.ts at
 * aa476a47f3663230ee5722d1a3cebffe4faf3192 ·
 * mbnuqw/sidebery](https://github.com/mbnuqw/sidebery/blob/aa476a47f3663230ee5722d1a3cebffe4faf3192/src/services/menu.actions.ts#L319-L339)
 *
 * @param {string} icon Name of a supported icon.
 * @param {string} rgbColor
 * @return {Promise<string>}
 */
export async function getBase64SVGIcon(icon, rgbColor) {
    let cachedIcons = base64SvgIconsCache[icon]
    if (!cachedIcons) {
        base64SvgIconsCache[icon] = {}
        cachedIcons = base64SvgIconsCache[icon]
    }

    const cached = cachedIcons[rgbColor]
    if (cached) return cached

    const response = await fetch(new URL(browser.runtime.getURL('assets/' + icon + '.svg')));
    const svgOriginal = await response.text();

    // const svgIconEl = document.getElementById(icon)
    // if (!svgIconEl) {
    //     throw new Error(`Could not find element with id ${icon} on background page`);
    // }
    // let svg = xmlSerializer.serializeToString(svgIconEl)

    let svg = svgOriginal;
    svg = '<svg fill="' + rgbColor + '" ' + svg.slice(5)
    icon = 'data:image/svg+xml;base64,' + window.btoa(svg)

    cachedIcons[rgbColor] = icon

    return icon
}

/** Convert an alpha value into 2 hex digits.
 *
 * @export
 * @param {number} alpha Value between 0 and 1. (Will be clamped to those values otherwise.)
 * @returns {string} 2 hexadecimal digits in a string representing the alpha value.
 */
export function alphaToHex(alpha) {
    return Math.max(0, Math.min(255, Math.round(255 * alpha))).toString(16);
}

/** Check if a given string represents a valid color name.
 *
 * @export
 * @param {string} name A string that might represent the name of a color.
 * @return {name is keyof typeof kCOLORS} `true` if name is a valid color name, otherwise `false`.
 */
export function isColorName(name) {
    return name in kCOLORS;
}


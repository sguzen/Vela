import type { ChartTypeSettingsSection } from '../registry';
import { ACCENT, BEARISH, BULLISH } from '../../core/palette';

/** Row height in price increments. 0 asks the style to pick one from the instrument's tick. */
export const DEFAULT_TICKS = 0;
export const DEFAULT_MODE = 'Bid × Ask';
export const DEFAULT_IMBALANCE_RATIO = 3;

/**
 * The footprint's settings tab. Values land in one flat bag (`chartTypes.footprint`), reach
 * the data engine through `onSettings` and the renderer layer through its settings channel —
 * so a colour change repaints without touching the tape, while a row-height change rebuilds.
 */
export const FOOTPRINT_SETTINGS: ChartTypeSettingsSection = {
    title: 'Footprint',
    layout: 'grouped',
    rows: [
        { kind: 'heading', label: 'Clusters' },
        {
            kind: 'select',
            key: 'mode',
            label: 'Show',
            defval: DEFAULT_MODE,
            options: [
                ['bidAsk', 'Bid × Ask'],
                ['delta', 'Delta'],
                ['volume', 'Volume'],
            ],
        },
        {
            kind: 'number',
            key: 'ticks',
            label: 'Ticks per row',
            defval: DEFAULT_TICKS,
            min: 0,
            max: 1000,
            step: 1,
        },
        {
            kind: 'row',
            label: 'Row colors',
            controls: [
                { kind: 'color', key: 'upColor', label: 'Buying', defval: BULLISH },
                { kind: 'color', key: 'downColor', label: 'Selling', defval: BEARISH },
            ],
        },

        { kind: 'heading', label: 'Highlights' },
        {
            kind: 'toggle',
            key: 'showImbalance',
            label: 'Imbalances',
            defval: true,
            number: { key: 'imbalanceRatio', label: 'Ratio', defval: DEFAULT_IMBALANCE_RATIO, min: 1.5, max: 20, step: 0.5 },
            colors: [
                { key: 'imbalanceUpColor', label: 'Buying imbalance', defval: BULLISH },
                { key: 'imbalanceDownColor', label: 'Selling imbalance', defval: BEARISH },
            ],
        },
        {
            kind: 'toggle',
            key: 'showPoc',
            label: 'Point of control',
            defval: true,
            colors: [{ key: 'pocColor', label: 'Point of control', defval: ACCENT }],
        },
        { kind: 'toggle', key: 'showSummary', label: "Totals under each bar", defval: true },
    ],
};

// The FOOTPRINT price style, registered through the same public chart-type registry a plugin
// would use. It contributes a data engine (the clusters) and a settings tab; the painting
// lives in the native renderer's footprint layer, which reads the `footprint` channel.
import { registerChartType } from '../registry';
import { FootprintEngine } from './FootprintEngine';
import { FOOTPRINT_SETTINGS } from './settings';

/** The style picker's glyph: three stacked cluster rows beside a bar. */
const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
<path d="M5 5h5M5 9h7M5 13h4M5 17h6" /><path d="M16 4v16" /><path d="M14 8h4M14 14h4" /></svg>`;

export { FootprintEngine } from './FootprintEngine';
export { FOOTPRINT_SETTINGS } from './settings';

/** Register the built-in footprint chart type (idempotent — called by the composition root). */
export function registerFootprintChartType(): void {
    registerChartType({
        id: 'footprint',
        label: 'Footprint',
        icon: ICON,
        settings: FOOTPRINT_SETTINGS,
        dataEngine: () => new FootprintEngine(),
        // The clusters ARE the price representation here; the layer draws the bar's own
        // body as part of them, so the base candles would only double up underneath.
        basePainting: 'none',
        // Nothing about a footprint can be re-derived from a transformed bar series, so it
        // is not an extended-ticker modifier the data plane could serve.
        tickerModifier: false,
    });
}

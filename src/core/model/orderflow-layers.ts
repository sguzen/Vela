import type { Millis } from './time';

/**
 * The per-bar cluster payload the footprint chart type pushes to its renderer layer
 * (`setNativeData('footprint', …)`). DATA only: every colour, threshold and toggle lives in
 * the type's settings channel instead, so a cosmetic edit never rebuilds the clusters.
 *
 * Only the bars the view is actually showing are sent. A footprint carries one row per price
 * that traded, which on a wide window is far more than any screen can draw — bounding the
 * payload at the view is what keeps the push cheap rather than the layer's own filtering.
 */

/** One price row of one bar: the volume that traded there, split by aggressor. */
export interface FootprintCell {
    /** The row's LOW price edge; the row covers `[price, price + levelSize)`. */
    price: number;
    buy: number;
    sell: number;
}

/** One bar's clusters plus the totals the layer prints under it. */
export interface FootprintBarData {
    /** Bar open time (epoch ms) — matches `OHLCV.time`. */
    time: Millis;
    /** Ascending by price; only rows that traded. */
    cells: readonly FootprintCell[];
    buy: number;
    sell: number;
    /** `buy - sell`. */
    delta: number;
    /** `buy + sell` — the bar's tape volume, which is not exactly the candle's. */
    volume: number;
    /** Price of the heaviest row, or null on a bar with no prints. */
    poc: number | null;
}

/** `setNativeData('footprint', …)`: the clusters for the bars currently in view. */
export interface FootprintLayerData {
    /** Price height of one row, in quote units. */
    levelSize: number;
    /** Ascending by time. */
    bars: readonly FootprintBarData[];
    /**
     * Whether the venue can reconstruct past trades at all. The layer says so on screen when
     * it cannot: empty clusters on a live-only venue are the truth about the data, not a bug
     * to leave the user guessing about.
     */
    historical: boolean;
}

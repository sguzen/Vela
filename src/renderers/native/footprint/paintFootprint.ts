// The footprint painter: pure geometry + canvas calls, with every coordinate handed in, so
// it can be driven by a fake 2d context in tests. Knows nothing of the CoordinateSystem, the
// tape, or the settings plumbing.
import type { FootprintBarData, FootprintCell } from '../../../core/model/orderflow-layers';

/** Below this row height there is no room for a readable row — rows merge until there is. */
export const MIN_ROW_PX = 3;
/** Numbers are only drawn once a row is this tall; below it the cluster reads as colour alone. */
export const MIN_TEXT_ROW_PX = 9;
/** …and only when one column is this wide. */
export const MIN_TEXT_COL_PX = 24;
/** Faintest a cell that traded may be drawn — a row with volume must never vanish entirely. */
const MIN_CELL_ALPHA = 0.12;

export type FootprintMode = 'bidAsk' | 'delta' | 'volume';

export interface FootprintColors {
    /** Font family for the cluster numbers (the chart's own). */
    fontFamily: string;
    up: string;
    down: string;
    neutral: string;
    text: string;
    imbalanceUp: string;
    imbalanceDown: string;
    poc: string;
}

export interface FootprintOptions {
    mode: FootprintMode;
    showImbalance: boolean;
    imbalanceRatio: number;
    showPoc: boolean;
    showSummary: boolean;
}

export interface FootprintGeom {
    /** bar time → pixel x of the bar's centre. */
    xOf(time: number): number;
    /** price → pixel y. */
    yOf(price: number): number;
    /** Half-width (px) of one bar's cluster block. */
    halfW: number;
    /** Pixel height of ONE `levelSize` row (positive). */
    rowPx: number;
    /** Price height of one stored row. */
    levelSize: number;
    /** Pane clip in pixels. */
    top: number;
    bottom: number;
}

/** Compact number text for a cell: 1.2k, 3.4M — a cluster has no room for full precision. */
export function cellText(v: number): string {
    const n = Math.abs(v);
    if (n >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    if (n >= 100) return v.toFixed(0);
    if (n >= 1) return v.toFixed(1);
    return v.toFixed(2);
}

/**
 * Merge `factor` adjacent stored rows into one, so a zoomed-out bar draws legible rows
 * instead of a hairline per tick. Merging is a fold of the same two totals, so nothing is
 * invented and nothing is lost — exactly what the book itself does when it coarsens.
 */
export function mergeCells(cells: readonly FootprintCell[], levelSize: number, factor: number): FootprintCell[] {
    if (factor <= 1 || cells.length === 0) return [...cells];
    const size = levelSize * factor;
    const byBucket = new Map<number, FootprintCell>();
    for (const c of cells) {
        const key = Math.floor(c.price / size + 1e-9);
        const cur = byBucket.get(key);
        if (cur) {
            cur.buy += c.buy;
            cur.sell += c.sell;
        } else {
            byBucket.set(key, { price: key * size, buy: c.buy, sell: c.sell });
        }
    }
    return [...byBucket.values()].sort((a, b) => a.price - b.price);
}

/**
 * The rows a bar shows at the current zoom: stored rows merged until each is at least
 * {@link MIN_ROW_PX} tall. Returns the rows and the row height they are drawn at.
 */
export function rowsFor(bar: FootprintBarData, geom: FootprintGeom): { cells: FootprintCell[]; rowPx: number; levelSize: number } {
    const factor = geom.rowPx >= MIN_ROW_PX ? 1 : Math.max(1, Math.ceil(MIN_ROW_PX / Math.max(geom.rowPx, 0.01)));
    return {
        cells: mergeCells(bar.cells, geom.levelSize, factor),
        rowPx: geom.rowPx * factor,
        levelSize: geom.levelSize * factor,
    };
}

/**
 * Which rows of a bar are imbalanced, by the conventional DIAGONAL comparison: buyers at a
 * row against the sellers resting one row below, and sellers against the buyers one row
 * above. Returns the flagged price → dominant side.
 *
 * This lives here rather than reusing the book's `footprintImbalances` because it must run
 * on the rows actually DRAWN — which only exist after the zoom-dependent merge above.
 *
 * `minVolume` is what keeps the reading honest at the extremes. A row facing an EMPTY one
 * wins by an infinite ratio, so without a floor every bar's highest and lowest row flags on
 * a single lot and the highlight means nothing. Requiring a share of the bar's own heaviest
 * row instead scales with the instrument and with the bar.
 */
export function imbalancedRows(
    cells: readonly FootprintCell[],
    levelSize: number,
    ratio: number,
    minVolume = 0,
): Map<number, 'buy' | 'sell'> {
    const out = new Map<number, 'buy' | 'sell'>();
    if (!(ratio > 0)) return out;
    const byKey = new Map<number, FootprintCell>();
    for (const c of cells) byKey.set(Math.round(c.price / levelSize), c);
    const wins = (win: number, facing: number): boolean =>
        win > 0 && win >= minVolume && (facing > 0 ? win >= facing * ratio : true);
    for (const c of cells) {
        const key = Math.round(c.price / levelSize);
        if (wins(c.buy, byKey.get(key - 1)?.sell ?? 0)) out.set(c.price, 'buy');
        else if (wins(c.sell, byKey.get(key + 1)?.buy ?? 0)) out.set(c.price, 'sell');
    }
    return out;
}

/** Share of a bar's heaviest row that a cell must hold to flag against an EMPTY facing row. */
export const EMPTY_FACE_MIN_SHARE = 0.25;

/** Paint every bar's clusters. Pure of any coordinate system — `geom` supplies all of it. */
export function paintFootprint(
    ctx: CanvasRenderingContext2D,
    bars: readonly FootprintBarData[],
    geom: FootprintGeom,
    opts: FootprintOptions,
    colors: FootprintColors,
): void {
    if (geom.halfW <= 0) return;
    const split = opts.mode === 'bidAsk';
    ctx.textBaseline = 'middle';
    ctx.font = `10px ${colors.fontFamily}`;

    for (const bar of bars) {
        const { cells, rowPx, levelSize } = rowsFor(bar, geom);
        if (cells.length === 0) continue;
        const x = geom.xOf(bar.time);
        if (x + geom.halfW < 0 || x - geom.halfW > 1e6) continue;

        // Per-bar normalization: shading shows where THIS bar concentrated, which is the
        // question a footprint answers. A window-wide scale would flatten every quiet bar.
        let peak = 0;
        for (const c of cells) {
            peak = Math.max(peak, split ? Math.max(c.buy, c.sell) : opts.mode === 'delta' ? Math.abs(c.buy - c.sell) : c.buy + c.sell);
        }
        if (peak <= 0) continue;

        const flagged = opts.showImbalance
            ? imbalancedRows(cells, levelSize, opts.imbalanceRatio, peak * EMPTY_FACE_MIN_SHARE)
            : new Map<number, 'buy' | 'sell'>();
        const drawText = rowPx >= MIN_TEXT_ROW_PX && geom.halfW * (split ? 1 : 2) >= MIN_TEXT_COL_PX;

        for (const c of cells) {
            const yTop = geom.yOf(c.price + levelSize);
            if (yTop > geom.bottom || yTop + rowPx < geom.top) continue;
            const h = Math.max(1, rowPx - 1);

            if (split) {
                drawCell(ctx, x - geom.halfW, yTop, geom.halfW - 1, h, c.sell, peak, colors.down);
                drawCell(ctx, x + 1, yTop, geom.halfW - 1, h, c.buy, peak, colors.up);
                if (drawText) {
                    ctx.fillStyle = colors.text;
                    ctx.textAlign = 'right';
                    if (c.sell > 0) ctx.fillText(cellText(c.sell), x - 3, yTop + h / 2);
                    ctx.textAlign = 'left';
                    if (c.buy > 0) ctx.fillText(cellText(c.buy), x + 4, yTop + h / 2);
                }
            } else {
                const value = opts.mode === 'delta' ? c.buy - c.sell : c.buy + c.sell;
                const color = opts.mode === 'delta' ? (value >= 0 ? colors.up : colors.down) : colors.neutral;
                drawCell(ctx, x - geom.halfW, yTop, geom.halfW * 2, h, Math.abs(value), peak, color);
                if (drawText && value !== 0) {
                    ctx.fillStyle = colors.text;
                    ctx.textAlign = 'center';
                    ctx.fillText(cellText(value), x, yTop + h / 2);
                }
            }

            const side = flagged.get(c.price);
            if (side) {
                ctx.strokeStyle = side === 'buy' ? colors.imbalanceUp : colors.imbalanceDown;
                ctx.lineWidth = 1;
                const left = side === 'buy' && split ? x + 1 : x - geom.halfW;
                const width = split ? geom.halfW - 1 : geom.halfW * 2;
                ctx.strokeRect(left + 0.5, yTop + 0.5, Math.max(1, width - 1), Math.max(1, h - 1));
            }
        }

        if (opts.showPoc && bar.poc != null) {
            // The POC is reported at the STORED row; find the drawn row containing it.
            const pocTop = geom.yOf(Math.floor(bar.poc / levelSize + 1e-9) * levelSize + levelSize);
            ctx.strokeStyle = colors.poc;
            ctx.lineWidth = 1;
            ctx.strokeRect(x - geom.halfW + 0.5, pocTop + 0.5, Math.max(1, geom.halfW * 2 - 1), Math.max(1, rowPx - 1));
        }

        // The totals obey the same width rule as the cluster numbers: at a zoom where a bar
        // is a few pixels wide they would overlap their neighbours into unreadable clutter,
        // and a number nobody can read is worse than none.
        if (opts.showSummary && geom.halfW * 2 >= MIN_TEXT_COL_PX) {
            ctx.fillStyle = bar.delta >= 0 ? colors.up : colors.down;
            ctx.textAlign = 'center';
            const lowest = cells[0]!;
            const y = geom.yOf(lowest.price) + 9;
            if (y < geom.bottom) ctx.fillText(cellText(bar.delta), x, y);
        }
    }
}

/** One shaded cell: opacity carries the volume, so a cluster reads before any number does. */
function drawCell(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    value: number, peak: number, color: string,
): void {
    if (!(value > 0) || w <= 0) return;
    ctx.globalAlpha = Math.max(MIN_CELL_ALPHA, Math.min(1, value / peak));
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
}

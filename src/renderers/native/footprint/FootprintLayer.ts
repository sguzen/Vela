// The footprint STYLE's renderer layer, registered through the public layer SDK. It owns one
// transparent canvas, reads the clusters from the `footprint` channel and its cosmetics from
// the type's settings channel, and paints only while the footprint style is active.
import type { FootprintLayerData } from '../../../core/model/orderflow-layers';
import { ACCENT, BEARISH, BULLISH } from '../../../core/palette';
import { registerRendererLayer, type RendererLayerArgs, type RendererLayerInstance, type BasePaintingModulation } from '../layers';
import { paintFootprint, type FootprintColors, type FootprintMode, type FootprintOptions } from './paintFootprint';

/** The style id, which is also this layer's data channel. */
export const FOOTPRINT_LAYER_ID = 'footprint';

/** Fraction of the bar slot one cluster block occupies (a gutter keeps neighbours apart). */
const SLOT_FILL = 0.86;

function str(v: unknown, fallback: string): string {
    return typeof v === 'string' && v !== '' ? v : fallback;
}
function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
    return typeof v === 'boolean' ? v : fallback;
}

/** The stored `mode` value; the settings row stores the id, older bags may hold the label. */
function modeOf(v: unknown): FootprintMode {
    const s = String(v ?? '');
    if (s === 'delta' || s === 'Delta') return 'delta';
    if (s === 'volume' || s === 'Volume') return 'volume';
    return 'bidAsk';
}

class FootprintLayer implements RendererLayerInstance {
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    /** Whether the last frame actually drew clusters (drives the base-painting dim). */
    private painted = false;

    mount(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
    }

    destroy(): void {
        this.canvas = null;
        this.ctx = null;
    }

    render(args: RendererLayerArgs): void {
        const ctx = this.ctx;
        const canvas = this.canvas;
        if (!ctx || !canvas) return;
        const dpr = args.coords.dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Always clear: leaving the style must wipe the last frame, not leave it frozen.
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
        this.painted = false;

        if (args.priceStyle !== FOOTPRINT_LAYER_ID) return; // another style is showing
        const data = args.data as FootprintLayerData | undefined;
        if (!data || data.bars.length === 0 || args.bounds.height <= 0) return;

        const s = args.settings;
        const opts: FootprintOptions = {
            mode: modeOf(s.mode),
            showImbalance: bool(s.showImbalance, true),
            imbalanceRatio: num(s.imbalanceRatio, 3),
            showPoc: bool(s.showPoc, true),
            showSummary: bool(s.showSummary, true),
        };
        const colors: FootprintColors = {
            up: str(s.upColor, BULLISH),
            down: str(s.downColor, BEARISH),
            neutral: str(s.upColor, BULLISH),
            text: args.theme.textColor,
            fontFamily: args.theme.fontFamily,
            imbalanceUp: str(s.imbalanceUpColor, BULLISH),
            imbalanceDown: str(s.imbalanceDownColor, BEARISH),
            poc: str(s.pocColor, ACCENT),
        };

        const { coords, scale, bounds } = args;
        const yOf = (price: number): number => coords.priceToY(price, scale, bounds);
        // Row height in pixels: the distance one stored row spans on the current scale.
        const rowPx = Math.abs(yOf(0 + data.levelSize) - yOf(0)) || Math.abs(yOf(data.bars[0]!.cells[0]?.price ?? 0) - yOf((data.bars[0]!.cells[0]?.price ?? 0) + data.levelSize));

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, bounds.top, coords.width, bounds.height);
        ctx.clip();
        paintFootprint(ctx, data.bars, {
            xOf: (time) => coords.timeToX(time),
            yOf,
            halfW: Math.max(1, (coords.bodySpacing() * SLOT_FILL) / 2),
            rowPx,
            levelSize: data.levelSize,
            top: bounds.top,
            bottom: bounds.top + bounds.height,
        }, opts, colors);
        ctx.restore();
        this.painted = true;
    }

    /**
     * While the clusters are up they ARE the price representation, so the grid steps back to
     * keep the rows readable. The candles are already suppressed by the type's
     * `basePainting: 'none'`; this only softens what is left underneath.
     */
    modulateBase(): BasePaintingModulation | null {
        return this.painted ? { gridAlpha: 0.35 } : null;
    }
}

/** Register the footprint renderer layer (idempotent — called by the composition root). */
export function registerFootprintLayer(): void {
    registerRendererLayer({
        id: FOOTPRINT_LAYER_ID,
        placement: 'above-data',
        create: () => new FootprintLayer(),
    });
}

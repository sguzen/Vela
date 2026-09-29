// The data engine behind the footprint style: it leases the chart's shared tape, keeps the
// VIEW covered, and pushes the clusters for the bars on screen. It owns no geometry and no
// colours — the layer paints, this decides what data the layer is given.
import type { OHLCV } from '../../core/model/ohlcv';
import type { FootprintBarData, FootprintLayerData } from '../../core/model/orderflow-layers';
import type { Millis } from '../../core/model/time';
import type { Unsubscribe } from '../../core/util/types';
import { acquireTapeSource, type TapeLease } from '../../data/tape/shared';
import type { SeriesDataEngine, SeriesDataEngineHost } from '../registry';
import { DEFAULT_TICKS } from './settings';

/** Bars of margin either side of the view, so a small pan shows clusters before refetching. */
const VIEW_MARGIN_BARS = 20;

/**
 * Row height when the instrument reports no tick size: about a ten-thousandth of the current
 * price, rounded to a power of ten. A fixed fallback cannot work across instruments — one
 * unit is a sane row on a $84,000 future and a meaningless one on a $0.50 token.
 */
function inferLevelSize(price: number): number {
    if (!Number.isFinite(price) || price <= 0) return 1;
    return 10 ** Math.floor(Math.log10(price) - 4);
}

export class FootprintEngine implements SeriesDataEngine {
    private host: SeriesDataEngineHost | null = null;
    private lease: TapeLease | null = null;
    private off: Unsubscribe | null = null;
    private view: { from: Millis; to: Millis } | null = null;
    private settings: Record<string, unknown> = {};
    /** Price increment of the instrument, once known; null until `symbolInfo` answers. */
    private tickSize: number | null = null;
    private suspended = false;

    start(host: SeriesDataEngineHost): void {
        this.host = host;
        this.suspended = false;
        this.attach();
        void this.resolveTickSize();
        this.cover();
        this.push();
    }

    suspend(): void {
        this.suspended = true;
        this.detach();
    }

    resume(): void {
        if (!this.host || this.lease) return;
        this.suspended = false;
        this.attach();
        this.cover();
        this.push();
    }

    stop(): void {
        this.detach();
        this.host = null;
    }

    onViewport(range: { from: number; to: number }): void {
        this.view = range;
        this.cover();
        this.push();
    }

    onBars(): void {
        this.cover();
        this.push();
    }

    onSettings(values: Record<string, unknown>): void {
        const before = this.levelSize();
        this.settings = values;
        const after = this.levelSize();
        // Only a ROW-HEIGHT change touches the book; everything else here is cosmetic and
        // reaches the layer through its own settings channel without a rebuild.
        if (after !== before) this.lease?.source.setLevelSize(after);
        this.push();
    }

    // ── internals ────────────────────────────────────────────────────────

    private attach(): void {
        const host = this.host;
        if (!host) return;
        this.lease = acquireTapeSource(host.data, {
            symbol: host.symbol,
            timeframe: host.timeframe,
            bars: () => host.bars(),
            live: host.live,
            levelSize: this.levelSize(),
        });
        this.off = this.lease.source.onChange(() => this.push());
    }

    private detach(): void {
        this.off?.();
        this.off = null;
        this.lease?.release();
        this.lease = null;
    }

    /** Ask the instrument for its price increment, then re-cut the rows to it. */
    private async resolveTickSize(): Promise<void> {
        const host = this.host;
        if (!host) return;
        const info = await host.data.symbolInfo(host.symbol).catch(() => undefined);
        const tick = Number(info?.mintick);
        if (!Number.isFinite(tick) || tick <= 0) return;
        this.tickSize = tick;
        if (this.suspended || !this.lease) return;
        this.lease.source.setLevelSize(this.levelSize());
        this.push();
    }

    /** Row height: the configured number of ticks, or one derived from the instrument. */
    private levelSize(): number {
        const ticks = Number(this.settings.ticks ?? DEFAULT_TICKS);
        const bars = this.host?.bars() ?? [];
        const tick = this.tickSize ?? inferLevelSize(bars[bars.length - 1]?.close ?? 0);
        if (!Number.isFinite(ticks) || ticks < 1) {
            // Auto: one tick per row where the instrument says what a tick is, else the
            // inferred height (which is already a sensible row, not a raw increment).
            return this.tickSize ?? tick;
        }
        return tick * Math.round(ticks);
    }

    private windowBars(): OHLCV[] {
        const bars = this.host?.bars() ?? [];
        if (bars.length === 0) return [];
        const view = this.view;
        if (!view) return bars.slice(-120);
        const first = bars.findIndex((b) => b.time >= view.from);
        const start = first < 0 ? bars.length : first;
        let end = bars.length;
        for (let i = start; i < bars.length; i += 1) {
            if (bars[i]!.time > view.to) { end = i; break; }
        }
        return bars.slice(Math.max(0, start - VIEW_MARGIN_BARS), Math.min(bars.length, end + VIEW_MARGIN_BARS));
    }

    private cover(): void {
        const source = this.lease?.source;
        const window = this.windowBars();
        if (!source || window.length === 0) return;
        source.prune();
        source.request(window[0]!.time, window[window.length - 1]!.time);
    }

    private push(): void {
        const host = this.host;
        const source = this.lease?.source;
        if (!host || !source) return;

        const out: FootprintBarData[] = [];
        for (const bar of this.windowBars()) {
            const fp = source.footprint(bar.time);
            if (!fp) continue;
            out.push({
                time: fp.time,
                cells: fp.levels.map((l) => ({ price: l.price, buy: l.buy, sell: l.sell })),
                buy: fp.buy,
                sell: fp.sell,
                delta: fp.delta,
                volume: fp.volume,
                poc: fp.poc,
            });
        }
        const data: FootprintLayerData = {
            levelSize: source.levelSize,
            bars: out,
            historical: source.depth !== 'none',
        };
        host.pushData(data);
        host.pushPending(source.pending());
    }
}

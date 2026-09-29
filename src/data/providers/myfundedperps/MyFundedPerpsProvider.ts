import type { OHLCV } from '../../../core/model/ohlcv';
import type { Trade } from '../../../core/model/tape';
import type { BarRange, SymbolInfo } from '../../../core/ports/MarketDataFeed';
import type { DataProvider, ProviderInfo, SymbolDescriptor } from '../../../core/ports/DataProvider';
import type { Unsubscribe } from '../../../core/util/types';
import { baseOf, ledgerCryptoIconUrl } from '../../symbol-base';
import { MarketStream, type SocketFactory } from './MarketStream';

const REST_BASE = 'https://developers.myfundedperpetuals.com';
const STREAM_URL = 'wss://api-stream.myfundedperpetuals.com/v1/market-data';

/** Canonical Vela timeframe → this venue's interval name. */
const TF_TO_INTERVAL: Record<string, string> = {
    '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
    '60': '1h', '120': '2h', '240': '4h', '480': '8h', '720': '12h',
    D: '1d', W: '1w', M: '1M',
};

/** User-facing aliases → canonical keys (matches the other Vela providers). */
const TF_NORMALIZE: Record<string, string> = {
    '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '45m': '45',
    '1h': '60', '2h': '120', '3h': '180', '4h': '240', '6h': '360', '8h': '480', '12h': '720',
    '1d': 'D', '1w': 'W', '1mo': 'M', '1D': 'D', '1W': 'W', '4H': '240',
    D: 'D', W: 'W', M: 'M',
};

/** Intraday intervals served natively, in minutes (the aggregation candidates). */
const NATIVE_MINUTES = [1, 3, 5, 15, 30, 60, 120, 240, 480, 720];
const MIN_TO_INTERVAL: Record<number, string> = {
    1: '1m', 3: '3m', 5: '5m', 15: '15m', 30: '30m', 60: '1h', 120: '2h', 240: '4h', 480: '8h', 720: '12h',
};
const SUPPORTED_TIMEFRAMES = ['1', '3', '5', '15', '30', '45', '60', '120', '180', '240', '360', '480', '720', 'D', 'W', 'M'];

/** Candles per history request. The server bounds this by its own retention either way. */
const HISTORY_LIMIT = 1000;
/** How long live prints are buffered before one batch is delivered. */
const TRADE_BATCH_MS = 100;

/** Normalize a user timeframe to a canonical key. */
export function normalizeTf(tf: string): string {
    return TF_NORMALIZE[tf] ?? TF_NORMALIZE[tf.toLowerCase()] ?? tf;
}

/** One market as `/v1/markets` reports it. */
interface RawMarket {
    coin: string;
    market_id: string;
    provider: string;
    symbol: string;
    size_decimals?: number;
    max_leverage?: number;
}

/** A market resolved to what the stream needs. */
export interface ResolvedMarket {
    coin: string;
    provider: string;
    symbol: string;
}

/**
 * Split a Vela ticker into its display symbol and an optional venue qualifier. One display
 * symbol can exist on several execution venues, so `BTC.bybit` pins the venue while a bare
 * `BTC` takes whichever venue the market list offers first.
 */
export function parseTicker(ticker: string): { symbol: string; venue: string | null } {
    const t = ticker.trim();
    const dot = t.lastIndexOf('.');
    if (dot > 0) {
        const venue = t.slice(dot + 1).toLowerCase();
        // Only treat the suffix as a venue when it looks like one; a symbol may contain dots.
        if (/^[a-z]+$/.test(venue)) return { symbol: t.slice(0, dot).toUpperCase(), venue };
    }
    return { symbol: t.toUpperCase(), venue: null };
}

/** Map one raw candle event to neutral OHLCV (prices arrive as decimal strings). */
export function candleToOHLCV(c: Record<string, unknown>): OHLCV {
    return {
        time: Number(c.openTime),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
    };
}

/**
 * Map raw trade events to neutral prints. This venue reports the AGGRESSOR's side directly —
 * `buy` means a taker lifted the ask — so unlike the exchanges that publish the resting
 * order's side, nothing is inverted here.
 */
export function tradesToTrades(events: readonly Record<string, unknown>[]): Trade[] {
    const out: Trade[] = [];
    for (const e of events) {
        const time = Number(e.time);
        const price = Number(e.price);
        const size = Number(e.size);
        if (!Number.isFinite(time) || !Number.isFinite(price) || !Number.isFinite(size)) continue;
        out.push({ time, price, size, side: e.side === 'sell' ? 'sell' : 'buy', id: e.tradeId != null ? String(e.tradeId) : undefined });
    }
    return out.sort((a, b) => a.time - b.time);
}

/** Sort by open-time and drop duplicate open-times (incoming wins) — the bar contract. */
export function dedupeSorted(bars: OHLCV[]): OHLCV[] {
    const byTime = new Map<number, OHLCV>();
    for (const b of bars) if (Number.isFinite(b.time)) byTime.set(b.time, b);
    return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Aggregate ascending sub-candles into `bucketMs` buckets aligned to the epoch. */
export function aggregate(sub: OHLCV[], bucketMs: number): OHLCV[] {
    const buckets = new Map<number, OHLCV>();
    for (const b of sub) {
        const key = Math.floor(b.time / bucketMs) * bucketMs;
        const cur = buckets.get(key);
        if (!cur) buckets.set(key, { time: key, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 });
        else {
            cur.high = Math.max(cur.high, b.high);
            cur.low = Math.min(cur.low, b.low);
            cur.close = b.close;
            cur.volume = (cur.volume ?? 0) + (b.volume ?? 0);
        }
    }
    return [...buckets.values()].sort((a, b) => a.time - b.time);
}

/** Largest native sub-timeframe (minutes) that evenly divides `targetMin`, or null. */
function selectSubTf(targetMin: number): number | null {
    return NATIVE_MINUTES.filter((m) => m < targetMin && targetMin % m === 0).sort((a, b) => b - a)[0] ?? null;
}

/**
 * The price increment implied by a decimal price STRING. It has to come from the string:
 * parsing "84373.20" to a number drops the trailing zero and understates the tick by a
 * factor of ten, which would then cut a footprint's rows at the wrong height.
 */
export function tickFromPriceString(price: unknown): number | null {
    if (typeof price !== 'string') return null;
    const dot = price.indexOf('.');
    if (dot < 0) return 1;
    const decimals = price.length - dot - 1;
    return decimals > 0 && decimals <= 12 ? 10 ** -decimals : 1;
}

/**
 * MyFundedPerps market-data provider, built on the venue's PUBLIC market stream — no API key,
 * and deliberately no trading surface: this reads prices, nothing else. One WebSocket carries
 * candles, trades and the symbol stream, so unlike the other bundled providers there is no
 * REST history path; `candles.history` is a request over the same socket.
 *
 * It fans out to several execution venues (Binance, Bybit, Hyperliquid and the venue's own
 * synthetic books) behind one connection, and covers equities and FX alongside crypto. A
 * ticker is the market's display symbol — `BTC`, `AAPL` — with an optional `.venue` suffix
 * (`BTC.bybit`) when one symbol trades on several of them.
 *
 * Trades: the stream carries a live tape with the aggressor side, but the venue offers no
 * trade HISTORY, so order-flow views here accumulate from the moment they open rather than
 * reconstructing what already printed.
 *
 *   import { MyFundedPerpsProvider } from 'vela/providers/myfundedperps';
 *   chart.data.registerProvider('mfp', new MyFundedPerpsProvider());
 */
export class MyFundedPerpsProvider implements DataProvider {
    private readonly stream: MarketStream;
    /** Cached market list (it is large; fetch once). */
    private marketsPromise: Promise<RawMarket[]> | null = null;
    /** Cached per-symbol price increment, learned from a candle's decimal strings. */
    private readonly tickCache = new Map<string, number>();

    constructor(opts: { socketFactory?: SocketFactory; streamUrl?: string } = {}) {
        this.stream = new MarketStream({ url: opts.streamUrl ?? STREAM_URL, socketFactory: opts.socketFactory });
    }

    info(): ProviderInfo {
        return {
            name: 'myfundedperps',
            displayName: 'MyFundedPerps',
            requiresApiKey: false,
            supportedTimeframes: SUPPORTED_TIMEFRAMES,
            // No trade HISTORY: the stream replays a short retained window on subscribe, which
            // is not a seekable past, so an order-flow view builds forward from here.
            capabilities: { enumerate: true, stream: true, symbolInfo: true, trades: 'none', tradeStream: true },
        };
    }

    async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        const market = await this.resolve(ticker);
        if (!market) return [];
        const tf = normalizeTf(timeframe);

        const interval = TF_TO_INTERVAL[tf];
        if (interval) return dedupeSorted(await this.history(market, interval, range));

        // A timeframe the venue does not serve is folded from the largest native one that
        // divides it (45 from 15, 180 from 60, 360 from 120) — same approach as the other providers.
        const minutes = Number(tf);
        const subMin = Number.isFinite(minutes) ? selectSubTf(minutes) : null;
        if (subMin == null) return [];
        const subInterval = MIN_TO_INTERVAL[subMin]!;
        const factor = minutes / subMin;
        const subRange: BarRange = { ...range, limit: range.limit != null ? range.limit * factor + factor : undefined };
        const sub = await this.history(market, subInterval, subRange);
        const folded = aggregate(dedupeSorted(sub), minutes * 60_000);
        return range.limit != null && folded.length > range.limit ? folded.slice(-range.limit) : folded;
    }

    async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
        const market = await this.resolve(ticker);
        if (!market) return undefined;
        const mintick = await this.tickSize(market);
        return {
            ticker,
            tickerid: `MFP:${ticker}`,
            prefix: 'MFP',
            description: `${market.symbol} (${market.provider})`,
            type: market.coin.includes(':') ? 'equity' : 'crypto',
            currency: 'USD',
            mintick,
            pricescale: Math.round(1 / mintick),
            timezone: 'Etc/UTC',
            session: '24x7',
        };
    }

    async listSymbols(): Promise<SymbolDescriptor[]> {
        const markets = await this.markets().catch(() => [] as RawMarket[]);
        // One display symbol may exist on several venues. The first listing keeps the bare
        // symbol; the rest are offered qualified, so both remain reachable and unambiguous.
        const seen = new Set<string>();
        const out: SymbolDescriptor[] = [];
        for (const m of markets) {
            const bare = m.symbol.toUpperCase();
            const first = !seen.has(bare);
            seen.add(bare);
            out.push({
                ticker: first ? bare : `${bare}.${m.provider}`,
                description: `${m.symbol} · ${m.provider}`,
                type: m.coin.includes(':') ? 'equity' : 'crypto',
                market: m.provider,
            });
        }
        return out;
    }

    resolveSymbolIcon(symbol: SymbolDescriptor): string | undefined {
        return symbol.type === 'equity' ? undefined : ledgerCryptoIconUrl(baseOf(symbol));
    }

    subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): Unsubscribe {
        const tf = normalizeTf(timeframe);
        const interval = TF_TO_INTERVAL[tf];
        let stop: Unsubscribe | null = null;
        let cancelled = false;

        void this.resolve(ticker).then((market) => {
            if (cancelled || !market) return;
            if (interval) {
                stop = this.stream.subscribe('candles', {
                    symbols: [market.coin], providers: [market.provider], intervals: [interval], historyLimit: 0,
                }, (events) => {
                    for (const e of events) if (e.type === 'candle' && e.interval === interval) onBar(candleToOHLCV(e));
                });
                return;
            }
            // An aggregated timeframe has no native stream: fold the sub-interval's candles
            // into the bucket the chart is showing, and re-emit that bucket on every update.
            const minutes = Number(tf);
            const subMin = Number.isFinite(minutes) ? selectSubTf(minutes) : null;
            if (subMin == null) return;
            const bucketMs = minutes * 60_000;
            let bucket: OHLCV | null = null;
            stop = this.stream.subscribe('candles', {
                symbols: [market.coin], providers: [market.provider], intervals: [MIN_TO_INTERVAL[subMin]!], historyLimit: 0,
            }, (events) => {
                for (const e of events) {
                    if (e.type !== 'candle') continue;
                    const sub = candleToOHLCV(e);
                    const key = Math.floor(sub.time / bucketMs) * bucketMs;
                    if (!bucket || bucket.time !== key) bucket = { ...sub, time: key };
                    else {
                        bucket.high = Math.max(bucket.high, sub.high);
                        bucket.low = Math.min(bucket.low, sub.low);
                        bucket.close = sub.close;
                    }
                    onBar({ ...bucket });
                }
            });
        });

        return () => {
            cancelled = true;
            stop?.();
        };
    }

    subscribeTrades(ticker: string, onTrades: (trades: readonly Trade[]) => void): Unsubscribe {
        let stop: Unsubscribe | null = null;
        let cancelled = false;
        let buffer: Trade[] = [];
        const flush = setInterval(() => {
            if (buffer.length === 0) return;
            const batch = buffer;
            buffer = [];
            onTrades(batch);
        }, TRADE_BATCH_MS);

        void this.resolve(ticker).then((market) => {
            if (cancelled || !market) return;
            stop = this.stream.subscribe('trades', { symbols: [market.coin], providers: [market.provider] }, (events) => {
                buffer.push(...tradesToTrades(events.filter((e) => e.type === 'trade')));
            });
        });

        return () => {
            cancelled = true;
            clearInterval(flush);
            stop?.();
        };
    }

    /** Close the shared socket — a host tearing the provider down should not leak it. */
    destroy(): void {
        this.stream.destroy();
    }

    // ── internals ────────────────────────────────────────────────────────

    private async history(market: ResolvedMarket, interval: string, range: BarRange): Promise<OHLCV[]> {
        const payload: Record<string, unknown> = {
            provider: market.provider,
            symbol: market.coin,
            interval,
            limit: Math.min(range.limit ?? HISTORY_LIMIT, HISTORY_LIMIT),
        };
        if (range.from != null) payload.startTime = Math.floor(range.from);
        if (range.to != null) payload.endTime = Math.floor(range.to);
        const result = await this.stream.request('candles.history', payload).catch((e: unknown) => {
            console.warn(`[vela] MyFundedPerps history failed for ${market.coin} ${interval} — ${e instanceof Error ? e.message : String(e)}`);
            return [];
        });
        if (!Array.isArray(result)) return [];
        const rows = result as Record<string, unknown>[];
        this.learnTick(market, rows);
        return rows.map(candleToOHLCV).filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close));
    }

    /** Remember the price increment implied by a candle's decimal strings (see tickFromPriceString). */
    private learnTick(market: ResolvedMarket, rows: readonly Record<string, unknown>[]): void {
        const key = marketKey(market);
        if (this.tickCache.has(key)) return;
        let finest: number | null = null;
        for (const r of rows.slice(-20)) {
            for (const field of ['close', 'open', 'high', 'low'] as const) {
                const tick = tickFromPriceString(r[field]);
                if (tick != null && (finest == null || tick < finest)) finest = tick;
            }
        }
        if (finest != null) this.tickCache.set(key, finest);
    }

    private async tickSize(market: ResolvedMarket): Promise<number> {
        const key = marketKey(market);
        const known = this.tickCache.get(key);
        if (known != null) return known;
        await this.history(market, '1m', { limit: 2 }).catch(() => []);
        return this.tickCache.get(key) ?? 0.01;
    }

    private markets(): Promise<RawMarket[]> {
        if (!this.marketsPromise) {
            this.marketsPromise = (async () => {
                const res = await fetch(`${REST_BASE}/v1/markets`, { headers: { Accept: 'application/json' } });
                if (!res.ok) throw new Error(`MyFundedPerps HTTP ${res.status} for /v1/markets`);
                const body = (await res.json()) as { data?: RawMarket[] };
                return Array.isArray(body.data) ? body.data : [];
            })().catch((e: unknown) => {
                this.marketsPromise = null; // a failed enumeration must not be cached forever
                throw e;
            });
        }
        return this.marketsPromise;
    }

    /** Resolve a Vela ticker to the coin + venue the stream expects. */
    private async resolve(ticker: string): Promise<ResolvedMarket | null> {
        const { symbol, venue } = parseTicker(ticker);
        const markets = await this.markets().catch(() => [] as RawMarket[]);
        const matches = markets.filter((m) => m.symbol.toUpperCase() === symbol || m.coin.toUpperCase() === symbol);
        const found = venue ? matches.find((m) => m.provider.toLowerCase() === venue) : matches[0];
        if (!found) return null;
        return { coin: found.coin, provider: found.provider, symbol: found.symbol };
    }
}

function marketKey(market: ResolvedMarket): string {
    return `${market.provider}|${market.coin}`;
}

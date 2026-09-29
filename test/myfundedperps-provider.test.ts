import { describe, it, expect, vi, afterEach } from 'vitest';
import { MarketStream, type SocketLike } from '../src/data/providers/myfundedperps/MarketStream';
import {
    MyFundedPerpsProvider,
    aggregate,
    candleToOHLCV,
    dedupeSorted,
    normalizeTf,
    parseTicker,
    tickFromPriceString,
    tradesToTrades,
} from '../src/data/providers/myfundedperps/MyFundedPerpsProvider';
import type { OHLCV } from '../src/core/model/ohlcv';

const MIN = 60_000;

afterEach(() => { vi.unstubAllGlobals(); });

/** A scriptable socket: records what was sent, and lets a test push frames back. */
function fakeSocket() {
    const sent: Array<Record<string, unknown>> = [];
    let socket: SocketLike;
    const made: SocketLike[] = [];
    const factory = (): SocketLike => {
        socket = {
            onopen: null, onmessage: null, onclose: null, onerror: null,
            send: (d: string) => sent.push(JSON.parse(d) as Record<string, unknown>),
            close: () => socket.onclose?.(),
        };
        made.push(socket);
        return socket;
    };
    return {
        factory,
        sent,
        made,
        open: (i = made.length - 1) => made[i]!.onopen?.(),
        push: (frame: unknown, i = made.length - 1) => made[i]!.onmessage?.({ data: JSON.stringify(frame) }),
        /** Frames sent on the socket at `i`, which is all of them (one `sent` log). */
        lastSent: () => sent[sent.length - 1],
    };
}

describe('pure helpers', () => {
    it('normalizeTf maps aliases to canonical keys', () => {
        expect(normalizeTf('1h')).toBe('60');
        expect(normalizeTf('4h')).toBe('240');
        expect(normalizeTf('1d')).toBe('D');
        expect(normalizeTf('60')).toBe('60');
    });

    it('parseTicker pins a venue only when the suffix looks like one', () => {
        expect(parseTicker('BTC')).toEqual({ symbol: 'BTC', venue: null });
        expect(parseTicker('BTC.bybit')).toEqual({ symbol: 'BTC', venue: 'bybit' });
        expect(parseTicker('btc.BINANCE')).toEqual({ symbol: 'BTC', venue: 'binance' });
        // A dotted symbol is not a venue qualifier.
        expect(parseTicker('BRK.B')).toEqual({ symbol: 'BRK', venue: 'b' });
        expect(parseTicker('ES1!')).toEqual({ symbol: 'ES1!', venue: null });
    });

    it('candleToOHLCV reads the decimal strings', () => {
        expect(candleToOHLCV({ openTime: 1000, open: '10.5', high: '12', low: '9', close: '11', volume: '100' }))
            .toEqual({ time: 1000, open: 10.5, high: 12, low: 9, close: 11, volume: 100 });
    });

    it('tickFromPriceString reads the increment from the STRING, keeping trailing zeros', () => {
        // Number("84373.20") is 84373.2 — parsing first would understate the tick tenfold.
        expect(tickFromPriceString('84373.20')).toBe(0.01);
        expect(tickFromPriceString('84373.2')).toBe(0.1);
        expect(tickFromPriceString('84373')).toBe(1);
        expect(tickFromPriceString('0.00012345')).toBe(1e-8);
        expect(tickFromPriceString(84373.2)).toBeNull(); // a number has already lost it
    });

    it('tradesToTrades keeps the aggressor side as reported', () => {
        expect(tradesToTrades([
            { type: 'trade', tradeId: '7', side: 'buy', price: '100.5', size: '2', time: 1000 },
            { type: 'trade', tradeId: '8', side: 'sell', price: '100.4', size: '3', time: 1001 },
        ])).toEqual([
            { time: 1000, price: 100.5, size: 2, side: 'buy', id: '7' },
            { time: 1001, price: 100.4, size: 3, side: 'sell', id: '8' },
        ]);
    });

    it('dedupeSorted and aggregate behave like the other providers', () => {
        const bars: OHLCV[] = [
            { time: 2 * MIN, open: 2, high: 3, low: 1, close: 2, volume: 5 },
            { time: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 4 },
            { time: MIN, open: 1.5, high: 4, low: 1.4, close: 3, volume: 6 },
        ];
        expect(dedupeSorted(bars).map((b) => b.time)).toEqual([0, MIN, 2 * MIN]);
        const folded = aggregate(dedupeSorted(bars), 3 * MIN);
        expect(folded).toHaveLength(1);
        expect(folded[0]).toMatchObject({ time: 0, open: 1, high: 4, low: 0.5, close: 2, volume: 15 });
    });
});

describe('MarketStream', () => {
    it('correlates a request with its response by id', async () => {
        const fake = fakeSocket();
        const stream = new MarketStream({ url: 'wss://x', socketFactory: fake.factory });
        const p = stream.request('candles.history', { symbol: 'BTCUSDT' });
        fake.open();
        const req = fake.sent.find((f) => f.op === 'req')!;
        expect(req.method).toBe('candles.history');
        fake.push({ op: 'res', id: req.id, result: [{ openTime: 1 }] });
        await expect(p).resolves.toEqual([{ openTime: 1 }]);
        stream.destroy();
    });

    it('sends a request issued BEFORE the socket opened', async () => {
        const fake = fakeSocket();
        const stream = new MarketStream({ url: 'wss://x', socketFactory: fake.factory });
        // Writing to a still-connecting socket throws and gets swallowed, so the frame must
        // wait for the open rather than vanish — this is every first call after start-up.
        const p = stream.request('candles.history', { symbol: 'BTCUSDT' });
        expect(fake.sent).toHaveLength(0);
        fake.open();
        const req = fake.sent.find((f) => f.op === 'req');
        expect(req).toBeDefined();
        fake.push({ op: 'res', id: req!.id, result: ['ok'] });
        await expect(p).resolves.toEqual(['ok']);
        stream.destroy();
    });

    it('re-sends a request still unanswered when the socket dropped', () => {
        const fake = fakeSocket();
        const timers: Array<() => void> = [];
        const stream = new MarketStream({
            url: 'wss://x', socketFactory: fake.factory,
            setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {},
        });
        void stream.request('candles.history', {}).catch(() => {});
        fake.open();
        expect(fake.sent.filter((f) => f.op === 'req')).toHaveLength(1);
        fake.made[0]!.onclose?.();
        timers[timers.length - 1]!(); // the reconnect backoff, not the request's own timeout
        fake.open(1);
        expect(fake.sent.filter((f) => f.op === 'req')).toHaveLength(2);
        stream.destroy();
    });

    it('rejects a request the server refuses', async () => {
        const fake = fakeSocket();
        const stream = new MarketStream({ url: 'wss://x', socketFactory: fake.factory });
        const p = stream.request('candles.history', {});
        fake.open();
        const req = fake.sent.find((f) => f.op === 'req')!;
        fake.push({ op: 'err', id: req.id, error: { reason: 'HistoryFetchFailed' } });
        await expect(p).rejects.toThrow('HistoryFetchFailed');
        stream.destroy();
    });

    it('routes events by the server opaque sub string, not by the request id', () => {
        const fake = fakeSocket();
        const stream = new MarketStream({ url: 'wss://x', socketFactory: fake.factory });
        const seen: unknown[] = [];
        stream.subscribe('trades', { symbols: ['BTCUSDT'] }, (e) => seen.push(...e));
        fake.open();
        const sub = fake.sent.find((f) => f.op === 'sub')!;
        fake.push({ op: 'sub_ok', id: sub.id, sub: 'opaque-1' });
        fake.push({ op: 'events', sub: 'opaque-1', events: [{ type: 'trade', tradeId: '1' }] });
        expect(seen).toEqual([{ type: 'trade', tradeId: '1' }]);

        // An event for a sub string this client does not hold must be ignored, not guessed at.
        fake.push({ op: 'events', sub: 'someone-else', events: [{ type: 'trade', tradeId: '2' }] });
        expect(seen).toHaveLength(1);
        stream.destroy();
    });

    it('re-establishes every subscription on a reconnect', () => {
        const fake = fakeSocket();
        const timers: Array<() => void> = [];
        const stream = new MarketStream({
            url: 'wss://x', socketFactory: fake.factory,
            setTimer: (fn) => { timers.push(fn); return timers.length; },
            clearTimer: () => {},
        });
        stream.subscribe('trades', { symbols: ['BTCUSDT'] }, () => {});
        fake.open();
        expect(fake.sent.filter((f) => f.op === 'sub')).toHaveLength(1);

        fake.made[0]!.onclose?.();           // the socket drops
        timers.forEach((fn) => fn());        // the backoff fires
        fake.open(1);                        // the replacement opens
        expect(fake.made).toHaveLength(2);
        expect(fake.sent.filter((f) => f.op === 'sub')).toHaveLength(2); // re-sent, not lost
        stream.destroy();
    });

    it('hands over to a replacement socket on `draining`, keeping the old one readable', () => {
        const fake = fakeSocket();
        const stream = new MarketStream({ url: 'wss://x', socketFactory: fake.factory, setTimer: () => 0, clearTimer: () => {} });
        const seen: unknown[] = [];
        stream.subscribe('trades', { symbols: ['BTCUSDT'] }, (e) => seen.push(...e));
        fake.open();
        const first = fake.sent.find((f) => f.op === 'sub')!;
        fake.push({ op: 'sub_ok', id: first.id, sub: 'old' });

        fake.push({ op: 'draining' });
        expect(fake.made).toHaveLength(2); // a replacement was stood up immediately
        fake.open(1);
        const resub = fake.sent.filter((f) => f.op === 'sub');
        expect(resub).toHaveLength(2); // the subscription moved across

        fake.push({ op: 'sub_ok', id: resub[1]!.id, sub: 'new' }, 1);
        fake.push({ op: 'events', sub: 'new', events: [{ type: 'trade', tradeId: '9' }] }, 1);
        expect(seen).toEqual([{ type: 'trade', tradeId: '9' }]);
        stream.destroy();
    });

    it('drops a rejected subscription instead of retrying a filter the server refused', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fake = fakeSocket();
        const stream = new MarketStream({ url: 'wss://x', socketFactory: fake.factory, setTimer: () => 0, clearTimer: () => {} });
        stream.subscribe('trades', { symbols: ['NOPE'] }, () => {});
        fake.open();
        const sub = fake.sent.find((f) => f.op === 'sub')!;
        fake.push({ op: 'sub_err', id: sub.id, error: { reason: 'UnknownSymbol' } });

        fake.made[0]!.onclose?.();
        expect(fake.made).toHaveLength(1); // nothing left wanting the socket back
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
        stream.destroy();
    });

    it('unsubscribing tells the server and stops delivering', () => {
        const fake = fakeSocket();
        const stream = new MarketStream({ url: 'wss://x', socketFactory: fake.factory, setTimer: () => 0, clearTimer: () => {} });
        const seen: unknown[] = [];
        const off = stream.subscribe('trades', {}, (e) => seen.push(...e));
        fake.open();
        const sub = fake.sent.find((f) => f.op === 'sub')!;
        fake.push({ op: 'sub_ok', id: sub.id, sub: 's1' });
        off();
        expect(fake.sent.some((f) => f.op === 'unsub' && f.id === sub.id)).toBe(true);
        fake.push({ op: 'events', sub: 's1', events: [{ type: 'trade' }] });
        expect(seen).toEqual([]);
        stream.destroy();
    });
});

describe('MyFundedPerpsProvider', () => {
    const MARKETS = {
        data: [
            { coin: 'BTCUSDT', market_id: 'binance|BTCUSDT', provider: 'binance', symbol: 'BTC', size_decimals: 3 },
            { coin: 'BTCUSD', market_id: 'bybit|BTCUSD', provider: 'bybit', symbol: 'BTC', size_decimals: 3 },
            { coin: 'xyz:AAPL', market_id: 'hyperliquid|xyz:AAPL', provider: 'hyperliquid', symbol: 'AAPL', size_decimals: 3 },
        ],
    };

    function stubMarkets(): void {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(MARKETS), {
            status: 200, headers: { 'content-type': 'application/json' },
        }))));
    }

    it('declares a live-only tape over a streaming venue', () => {
        const caps = new MyFundedPerpsProvider({ socketFactory: fakeSocket().factory }).info().capabilities;
        expect(caps.trades).toBe('none');   // no seekable trade history
        expect(caps.tradeStream).toBe(true); // but a live tape
        expect(caps.enumerate).toBe(true);
    });

    it('lists one bare symbol per display name and qualifies the duplicates', async () => {
        stubMarkets();
        const symbols = await new MyFundedPerpsProvider({ socketFactory: fakeSocket().factory }).listSymbols();
        expect(symbols.map((s) => s.ticker)).toEqual(['BTC', 'BTC.bybit', 'AAPL']);
        expect(symbols[2]!.type).toBe('equity');
    });

    it('asks history for the coin and venue behind a display symbol', async () => {
        stubMarkets();
        const fake = fakeSocket();
        const provider = new MyFundedPerpsProvider({ socketFactory: fake.factory });
        const p = provider.getBars('BTC', '60', { limit: 3 });
        await vi.waitFor(() => expect(fake.made.length).toBe(1));
        fake.open();
        await vi.waitFor(() => expect(fake.sent.some((f) => f.op === 'req')).toBe(true));
        const req = fake.sent.find((f) => f.op === 'req')!;
        expect(req.method).toBe('candles.history');
        expect(req.payload).toMatchObject({ provider: 'binance', symbol: 'BTCUSDT', interval: '1h', limit: 3 });

        fake.push({ op: 'res', id: req.id, result: [
            { openTime: 0, open: '1', high: '2', low: '0.5', close: '1.5', volume: '10' },
            { openTime: MIN, open: '1.5', high: '3', low: '1', close: '2', volume: '20' },
        ] });
        const bars = await p;
        expect(bars.map((b) => b.time)).toEqual([0, MIN]);
        expect(bars[1]!.close).toBe(2);
    });

    it('routes a .venue qualifier to that venue', async () => {
        stubMarkets();
        const fake = fakeSocket();
        const provider = new MyFundedPerpsProvider({ socketFactory: fake.factory });
        void provider.getBars('BTC.bybit', '60', { limit: 1 });
        await vi.waitFor(() => expect(fake.made.length).toBe(1));
        fake.open();
        await vi.waitFor(() => expect(fake.sent.some((f) => f.op === 'req')).toBe(true));
        expect(fake.sent.find((f) => f.op === 'req')!.payload).toMatchObject({ provider: 'bybit', symbol: 'BTCUSD' });
    });

    it('folds a timeframe the venue does not serve from one it does', async () => {
        stubMarkets();
        const fake = fakeSocket();
        const provider = new MyFundedPerpsProvider({ socketFactory: fake.factory });
        const p = provider.getBars('BTC', '45', { limit: 2 });
        await vi.waitFor(() => expect(fake.made.length).toBe(1));
        fake.open();
        await vi.waitFor(() => expect(fake.sent.some((f) => f.op === 'req')).toBe(true));
        const req = fake.sent.find((f) => f.op === 'req')!;
        expect(req.payload).toMatchObject({ interval: '15m' }); // 45 folds from 15

        const rows = Array.from({ length: 6 }, (_, i) => ({
            openTime: i * 15 * MIN, open: '1', high: String(2 + i), low: '1', close: '2', volume: '1',
        }));
        fake.push({ op: 'res', id: req.id, result: rows });
        const bars = await p;
        expect(bars).toHaveLength(2);
        expect(bars[0]!.time).toBe(0);
        expect(bars[1]!.time).toBe(45 * MIN);
        expect(bars[0]!.volume).toBe(3); // three 15m candles per 45m bar
    });

    it('subscribes to the trades channel for the resolved market', async () => {
        stubMarkets();
        const fake = fakeSocket();
        const provider = new MyFundedPerpsProvider({ socketFactory: fake.factory });
        const seen: unknown[] = [];
        const off = provider.subscribeTrades('AAPL', (t) => seen.push(...t));
        await vi.waitFor(() => expect(fake.made.length).toBe(1));
        fake.open();
        await vi.waitFor(() => expect(fake.sent.some((f) => f.op === 'sub')).toBe(true));
        const sub = fake.sent.find((f) => f.op === 'sub')!;
        expect(sub.channel).toBe('trades');
        expect(sub.payload).toMatchObject({ symbols: ['xyz:AAPL'], providers: ['hyperliquid'] });
        off();
        provider.destroy();
    });

    it('serves an unknown symbol as empty rather than guessing a market', async () => {
        stubMarkets();
        const provider = new MyFundedPerpsProvider({ socketFactory: fakeSocket().factory });
        expect(await provider.getBars('NOSUCH', '60', { limit: 1 })).toEqual([]);
        expect(await provider.getSymbolInfo('NOSUCH')).toBeUndefined();
    });
});

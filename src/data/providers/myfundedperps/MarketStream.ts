// The multiplexed market-data socket. This venue serves candles, trades and books over ONE
// public WebSocket rather than REST, so the provider needs a small RPC client: request /
// response by id, subscriptions that survive a reconnect, and the server-initiated handover
// the protocol calls `draining`. Pure of any provider knowledge — it moves frames.
import type { Unsubscribe } from '../../../core/util/types';

/** The socket surface used here; narrowed so a test can inject a fake. */
export interface SocketLike {
    send(data: string): void;
    close(): void;
    onopen: ((ev?: unknown) => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onclose: ((ev?: unknown) => void) | null;
    onerror: ((ev?: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface MarketStreamOptions {
    url: string;
    /** Injected in tests; defaults to the global `WebSocket`. */
    socketFactory?: SocketFactory;
    /** Injected in tests so reconnect/ping timing needs no real clock. */
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

/** Reconnect backoff, doubling to a ceiling with jitter so a fleet does not resynchronize. */
const BACKOFF_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_JITTER_MS = 400;
/** Application heartbeat. The server closes a connection with no inbound frame for 75s. */
const PING_MS = 25_000;
/** How long one request may wait before it is abandoned. */
const REQUEST_TIMEOUT_MS = 20_000;
/** How long a replacement socket may take to re-establish before the old one is dropped anyway. */
const HANDOVER_MS = 10_000;

interface Pending {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: unknown;
    /** The frame itself, so a request issued before the socket opened is still sent. */
    frame: unknown;
}

interface Subscription {
    id: number;
    channel: string;
    payload: unknown;
    onEvents(events: readonly Record<string, unknown>[]): void;
    /** The server's opaque `sub` string, once acknowledged on the CURRENT socket. */
    sub: string | null;
}

/** One frame as the server sends it (only the fields this client reads). */
interface Frame {
    op?: string;
    id?: number;
    sub?: string;
    events?: Record<string, unknown>[];
    result?: unknown;
    error?: unknown;
}

export class MarketStream {
    private readonly url: string;
    private readonly makeSocket: SocketFactory;
    private readonly setTimer: (fn: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;

    private socket: SocketLike | null = null;
    /** The socket being retired during a `draining` handover — still readable, not written to. */
    private retiring: SocketLike | null = null;
    private open = false;
    private closed = false;
    private nextId = 1;
    private attempt = 0;

    private readonly pending = new Map<number, Pending>();
    private readonly subs = new Map<number, Subscription>();
    /** Server `sub` string → subscription id, for routing event frames. */
    private readonly bySub = new Map<string, number>();

    private pingTimer: unknown = null;
    private reconnectTimer: unknown = null;

    constructor(opts: MarketStreamOptions) {
        this.url = opts.url;
        this.makeSocket = opts.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
        this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    }

    /** Whether a socket is currently connected (for tests and diagnostics). */
    get connected(): boolean {
        return this.open;
    }

    /**
     * Run a one-shot request (`candles.history`, `ping`, `status.get`). Connects on demand.
     * Rejects if the socket cannot be reached, if the server answers with an error, or if
     * nothing comes back in time — a caller that can degrade decides what that means.
     */
    request(method: string, payload?: unknown): Promise<unknown> {
        if (this.closed) return Promise.reject(new Error('market stream closed'));
        this.connect();
        const id = this.nextId++;
        return new Promise<unknown>((resolve, reject) => {
            const timer = this.setTimer(() => {
                this.pending.delete(id);
                reject(new Error(`market stream request "${method}" timed out`));
            }, REQUEST_TIMEOUT_MS);
            const frame = { op: 'req', id, method, ...(payload != null ? { payload } : {}) };
            this.pending.set(id, { resolve, reject, timer, frame });
            // Only write when the socket is actually open. A frame written to a CONNECTING
            // socket throws and would be swallowed, leaving the request to time out — the
            // first call after start-up is exactly when that happens. It is sent on open
            // instead, along with everything else this client is holding.
            if (this.open) this.send(frame);
        });
    }

    /**
     * Open a subscription and keep it open: it is re-sent on every reconnect and through a
     * handover, so a caller subscribes once and stops thinking about the transport.
     */
    subscribe(channel: string, payload: unknown, onEvents: (events: readonly Record<string, unknown>[]) => void): Unsubscribe {
        if (this.closed) return () => {};
        const id = this.nextId++;
        const sub: Subscription = { id, channel, payload, onEvents, sub: null };
        this.subs.set(id, sub);
        this.connect();
        if (this.open) this.send({ op: 'sub', id, channel, payload });
        return () => {
            const held = this.subs.get(id);
            if (!held) return;
            this.subs.delete(id);
            if (held.sub) this.bySub.delete(held.sub);
            if (this.open) this.send({ op: 'unsub', id });
            this.closeIfIdle();
        };
    }

    /** Release everything; further requests reject and further subscriptions are no-ops. */
    destroy(): void {
        this.closed = true;
        this.stopTimers();
        for (const [, p] of this.pending) {
            this.clearTimer(p.timer);
            p.reject(new Error('market stream closed'));
        }
        this.pending.clear();
        this.subs.clear();
        this.bySub.clear();
        this.drop(this.socket);
        this.drop(this.retiring);
        this.socket = null;
        this.retiring = null;
        this.open = false;
    }

    // ── internals ────────────────────────────────────────────────────────

    private connect(): void {
        if (this.closed || this.socket) return;
        this.socket = this.attach(this.makeSocket(this.url));
    }

    /** Wire one socket's handlers. Used for the live socket and for a handover replacement. */
    private attach(socket: SocketLike, isReplacement = false): SocketLike {
        socket.onopen = () => {
            if (this.closed) return;
            this.open = true;
            this.attempt = 0;
            // Every subscription is (re-)established on this socket: after a reconnect the
            // server knows nothing of what this client held.
            for (const sub of this.subs.values()) {
                sub.sub = null;
                this.sendOn(socket, { op: 'sub', id: sub.id, channel: sub.channel, payload: sub.payload });
            }
            // Requests waiting on this socket go out too: one issued before the connection
            // was up, or one still unanswered when the previous socket dropped. Every method
            // this client sends is a read, so re-sending one is safe.
            for (const p of this.pending.values()) this.sendOn(socket, p.frame);
            this.schedulePing();
            if (isReplacement) {
                // Give the replacement a moment to take over its subscriptions, then retire
                // the old socket. Overlap is deliberate: duplicate events are cheap to
                // ignore downstream, a gap in the tape is not recoverable.
                this.setTimer(() => this.retireOld(), HANDOVER_MS);
            }
        };
        socket.onmessage = (ev) => this.onFrame(ev.data);
        socket.onclose = () => {
            if (this.closed) return;
            if (socket === this.retiring) { this.retiring = null; return; }
            if (socket !== this.socket) return; // a socket we already replaced
            this.open = false;
            this.socket = null;
            this.stopPing();
            if (this.subs.size === 0 && this.pending.size === 0) return; // nothing wants it back
            this.scheduleReconnect();
        };
        socket.onerror = () => {
            try { socket.close(); } catch { /* onclose handles the retry */ }
        };
        return socket;
    }

    private onFrame(raw: unknown): void {
        let frame: Frame;
        try {
            frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as Frame;
        } catch {
            return; // not a frame this client understands
        }
        switch (frame.op) {
            case 'sub_ok': {
                const sub = frame.id != null ? this.subs.get(frame.id) : undefined;
                if (sub && typeof frame.sub === 'string') {
                    sub.sub = frame.sub;
                    this.bySub.set(frame.sub, sub.id);
                }
                return;
            }
            case 'events': {
                const id = typeof frame.sub === 'string' ? this.bySub.get(frame.sub) : undefined;
                const sub = id != null ? this.subs.get(id) : undefined;
                if (sub && Array.isArray(frame.events)) sub.onEvents(frame.events);
                return;
            }
            case 'res': {
                const p = frame.id != null ? this.pending.get(frame.id) : undefined;
                if (!p) return;
                this.pending.delete(frame.id!);
                this.clearTimer(p.timer);
                p.resolve(frame.result);
                return;
            }
            case 'err':
            case 'sub_err': {
                const p = frame.id != null ? this.pending.get(frame.id) : undefined;
                if (p) {
                    this.pending.delete(frame.id!);
                    this.clearTimer(p.timer);
                    p.reject(new Error(describe(frame.error)));
                    return;
                }
                // A rejected SUBSCRIPTION is not retryable — the filter itself is wrong, so
                // retrying it forever would just repeat the rejection.
                if (frame.id != null && this.subs.has(frame.id)) {
                    console.warn(`[vela] MyFundedPerps rejected a subscription — ${describe(frame.error)}`);
                    this.subs.delete(frame.id);
                }
                return;
            }
            case 'end': {
                // The server ended one subscription; re-establish it if the caller still holds it.
                const sub = frame.id != null ? this.subs.get(frame.id) : undefined;
                if (sub && this.open) {
                    sub.sub = null;
                    this.send({ op: 'sub', id: sub.id, channel: sub.channel, payload: sub.payload });
                }
                return;
            }
            case 'draining': {
                // The server is replacing this connection: stand up a replacement and keep
                // reading the old one until the new one has its subscriptions.
                if (this.retiring || this.closed) return;
                this.retiring = this.socket;
                this.socket = this.attach(this.makeSocket(this.url), true);
                this.bySub.clear();
                return;
            }
            default:
        }
    }

    private retireOld(): void {
        const old = this.retiring;
        this.retiring = null;
        this.drop(old);
    }

    private send(frame: unknown): void {
        this.sendOn(this.socket, frame);
    }

    private sendOn(socket: SocketLike | null, frame: unknown): void {
        if (!socket) return;
        try {
            socket.send(JSON.stringify(frame));
        } catch {
            // A socket that cannot be written to will close; the reconnect path takes over.
        }
    }

    private schedulePing(): void {
        this.stopPing();
        this.pingTimer = this.setTimer(() => {
            if (this.closed || !this.open) return;
            this.send({ op: 'req', id: this.nextId++, method: 'ping' });
            this.schedulePing();
        }, PING_MS);
    }

    private stopPing(): void {
        if (this.pingTimer != null) this.clearTimer(this.pingTimer);
        this.pingTimer = null;
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer != null) this.clearTimer(this.reconnectTimer);
        const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** this.attempt) + Math.random() * BACKOFF_JITTER_MS;
        this.attempt += 1;
        this.reconnectTimer = this.setTimer(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    private stopTimers(): void {
        this.stopPing();
        if (this.reconnectTimer != null) this.clearTimer(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    /** Close the socket once nothing is subscribed and nothing is in flight. */
    private closeIfIdle(): void {
        if (this.subs.size > 0 || this.pending.size > 0 || !this.socket) return;
        this.drop(this.socket);
        this.socket = null;
        this.open = false;
        this.stopTimers();
    }

    private drop(socket: SocketLike | null): void {
        if (!socket) return;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        try { socket.close(); } catch { /* already gone */ }
    }
}

/** A readable message from the server's error payload. */
function describe(error: unknown): string {
    if (error == null) return 'unknown error';
    if (typeof error === 'string') return error;
    const e = error as { reason?: unknown; message?: unknown; code?: unknown };
    return String(e.reason ?? e.message ?? e.code ?? JSON.stringify(error));
}

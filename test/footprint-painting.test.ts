import { describe, it, expect, vi } from 'vitest';
import {
    cellText,
    imbalancedRows,
    mergeCells,
    paintFootprint,
    rowsFor,
    MIN_ROW_PX,
    MIN_TEXT_ROW_PX,
    type FootprintColors,
    type FootprintGeom,
    type FootprintOptions,
} from '../src/renderers/native/footprint/paintFootprint';
import type { FootprintBarData, FootprintCell } from '../src/core/model/orderflow-layers';
import { chartType, chartTypes } from '../src/chart-types/registry';
import { registerFootprintChartType } from '../src/chart-types/footprint';

const cell = (price: number, buy: number, sell: number): FootprintCell => ({ price, buy, sell });

function bar(cells: FootprintCell[], extra: Partial<FootprintBarData> = {}): FootprintBarData {
    const buy = cells.reduce((s, c) => s + c.buy, 0);
    const sell = cells.reduce((s, c) => s + c.sell, 0);
    return { time: 0, cells, buy, sell, delta: buy - sell, volume: buy + sell, poc: null, ...extra };
}

/** A recording 2d context: enough surface for the painter, with every call captured. */
function fakeCtx() {
    const calls: Array<{ op: string; args: unknown[]; fill?: string; stroke?: string; alpha?: number }> = [];
    const ctx = {
        globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
        fillRect: (...args: unknown[]) => calls.push({ op: 'fillRect', args, fill: ctx.fillStyle, alpha: ctx.globalAlpha }),
        strokeRect: (...args: unknown[]) => calls.push({ op: 'strokeRect', args, stroke: ctx.strokeStyle }),
        fillText: (...args: unknown[]) => calls.push({ op: 'fillText', args, fill: ctx.fillStyle }),
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const COLORS: FootprintColors = {
    fontFamily: 'sans-serif', up: '#up', down: '#down', neutral: '#neutral', text: '#text',
    imbalanceUp: '#imbUp', imbalanceDown: '#imbDown', poc: '#poc',
};
const OPTS: FootprintOptions = { mode: 'bidAsk', showImbalance: false, imbalanceRatio: 3, showPoc: false, showSummary: false };

/** Prices fall as y rises, like a real price scale. */
function geom(over: Partial<FootprintGeom> = {}): FootprintGeom {
    return {
        xOf: () => 100,
        yOf: (price) => 500 - price,
        halfW: 30,
        rowPx: 10,
        levelSize: 1,
        top: 0,
        bottom: 600,
        ...over,
    };
}

describe('cellText', () => {
    it('keeps a cluster number short enough to fit in a cell', () => {
        expect(cellText(4)).toBe('4.0');
        expect(cellText(0.25)).toBe('0.25');
        expect(cellText(250)).toBe('250');
        expect(cellText(1500)).toBe('1.5k');
        expect(cellText(2_400_000)).toBe('2.4M');
        expect(cellText(-1500)).toBe('-1.5k');
    });
});

describe('mergeCells', () => {
    it('folds adjacent rows without inventing or losing volume', () => {
        const cells = [cell(100, 1, 2), cell(101, 3, 4), cell(102, 5, 6), cell(105, 7, 8)];
        const merged = mergeCells(cells, 1, 3); // rows of 3: [99,102), [102,105), [105,108)
        expect(merged).toEqual([
            { price: 99, buy: 4, sell: 6 },
            { price: 102, buy: 5, sell: 6 },
            { price: 105, buy: 7, sell: 8 },
        ]);
        const total = (list: FootprintCell[]) => list.reduce((s, c) => s + c.buy + c.sell, 0);
        expect(total(merged)).toBe(total(cells));
    });

    it('is a no-op at factor 1', () => {
        const cells = [cell(1, 1, 1)];
        expect(mergeCells(cells, 1, 1)).toEqual(cells);
    });
});

describe('rowsFor', () => {
    it('leaves rows alone when they are already tall enough', () => {
        const out = rowsFor(bar([cell(100, 1, 1)]), geom({ rowPx: 12 }));
        expect(out.rowPx).toBe(12);
        expect(out.levelSize).toBe(1);
        expect(out.cells).toHaveLength(1);
    });

    it('merges until a row clears the legibility floor', () => {
        // A hairline row (0.5px) must be merged enough to reach MIN_ROW_PX.
        const cells = Array.from({ length: 12 }, (_, i) => cell(100 + i, 1, 1));
        const out = rowsFor(bar(cells), geom({ rowPx: 0.5 }));
        expect(out.rowPx).toBeGreaterThanOrEqual(MIN_ROW_PX);
        expect(out.cells.length).toBeLessThan(cells.length);
        // Merging is lossless.
        expect(out.cells.reduce((s, c) => s + c.buy + c.sell, 0)).toBe(24);
    });
});

describe('imbalancedRows', () => {
    it('compares buyers against the sellers one row BELOW them', () => {
        const cells = [cell(100, 1, 10), cell(101, 40, 1)];
        const found = imbalancedRows(cells, 1, 3, 5);
        expect(found.get(101)).toBe('buy'); // 40 vs the 10 sold one row below → 4x
        expect(found.has(100)).toBe(false); // 10 sold vs 40 bought above is not dominance
    });

    it('flags against an empty facing row only once the volume is worth noticing', () => {
        // With no floor, a single lot at a bar's extreme would flag on every bar forever.
        expect(imbalancedRows([cell(100, 5, 0)], 1, 3, 0).get(100)).toBe('buy');
        expect(imbalancedRows([cell(100, 5, 0)], 1, 3, 10).has(100)).toBe(false);
    });

    it('does not treat a price GAP as an adjoining row', () => {
        // 20 at 105 faces an EMPTY 104, not the 30 five rows down.
        const found = imbalancedRows([cell(100, 0, 30), cell(105, 20, 0)], 1, 3, 5);
        expect(found.get(105)).toBe('buy');
        expect(found.get(100)).toBe('sell');
    });

    it('stays quiet when neither side dominates', () => {
        // Each row faces a well-populated neighbour, so nothing here is a 3x imbalance —
        // and the outer rows, which face nothing, are below the floor.
        expect(imbalancedRows([cell(100, 10, 9), cell(101, 10, 9)], 1, 3, 20).size).toBe(0);
    });
});

describe('paintFootprint', () => {
    it('splits bid and ask onto either side of the bar centre', () => {
        const { ctx, calls } = fakeCtx();
        paintFootprint(ctx, [bar([cell(100, 6, 3)])], geom(), OPTS, COLORS);
        const fills = calls.filter((c) => c.op === 'fillRect');
        expect(fills).toHaveLength(2);
        const sell = fills.find((f) => f.fill === '#down')!;
        const buy = fills.find((f) => f.fill === '#up')!;
        // Selling sits left of centre (x=100), buying right of it.
        expect(Number(sell.args[0])).toBeLessThan(100);
        expect(Number(buy.args[0])).toBeGreaterThanOrEqual(100);
    });

    it('shades a cell by its share of the bar, and never to invisibility', () => {
        const { ctx, calls } = fakeCtx();
        paintFootprint(ctx, [bar([cell(100, 100, 1), cell(101, 50, 0)])], geom(), OPTS, COLORS);
        const fills = calls.filter((c) => c.op === 'fillRect');
        const heaviest = Math.max(...fills.map((f) => f.alpha ?? 0));
        const lightest = Math.min(...fills.map((f) => f.alpha ?? 0));
        expect(heaviest).toBe(1); // the bar's own peak is fully opaque
        expect(lightest).toBeGreaterThan(0); // a row that traded is always visible
        expect(lightest).toBeLessThan(heaviest);
    });

    it('prints numbers only once a row is tall enough to hold them', () => {
        const tall = fakeCtx();
        paintFootprint(tall.ctx, [bar([cell(100, 6, 3)])], geom({ rowPx: MIN_TEXT_ROW_PX + 2 }), OPTS, COLORS);
        expect(tall.calls.some((c) => c.op === 'fillText')).toBe(true);

        const squat = fakeCtx();
        paintFootprint(squat.ctx, [bar([cell(100, 6, 3)])], geom({ rowPx: 4 }), OPTS, COLORS);
        expect(squat.calls.some((c) => c.op === 'fillText')).toBe(false);
        // …but the cluster still paints as colour.
        expect(squat.calls.some((c) => c.op === 'fillRect')).toBe(true);
    });

    it('drops numbers when the columns are too narrow, however tall the rows', () => {
        const { ctx, calls } = fakeCtx();
        paintFootprint(ctx, [bar([cell(100, 6, 3)])], geom({ halfW: 4, rowPx: 20 }), OPTS, COLORS);
        expect(calls.some((c) => c.op === 'fillText')).toBe(false);
    });

    it('colours a delta cluster by the sign of each row', () => {
        const { ctx, calls } = fakeCtx();
        paintFootprint(ctx, [bar([cell(100, 10, 2), cell(101, 1, 9)])], geom(), { ...OPTS, mode: 'delta' }, COLORS);
        const fills = calls.filter((c) => c.op === 'fillRect');
        expect(fills.map((f) => f.fill)).toEqual(['#up', '#down']);
    });

    it('outlines imbalanced rows in the dominant side colour, only when asked', () => {
        const cells = [cell(100, 1, 10), cell(101, 40, 1)];
        const on = fakeCtx();
        paintFootprint(on.ctx, [bar(cells)], geom(), { ...OPTS, showImbalance: true }, COLORS);
        // 40 buy at 101 against 10 sell at 100 is the only 3x diagonal in this bar.
        expect(on.calls.filter((c) => c.op === 'strokeRect' && c.stroke === '#imbUp')).toHaveLength(1);
        expect(on.calls.filter((c) => c.op === 'strokeRect')).toHaveLength(1);

        const off = fakeCtx();
        paintFootprint(off.ctx, [bar(cells)], geom(), OPTS, COLORS);
        expect(off.calls.some((c) => c.op === 'strokeRect')).toBe(false);
    });

    it('outlines the point of control where the bar reports it', () => {
        const { ctx, calls } = fakeCtx();
        paintFootprint(ctx, [bar([cell(100, 1, 1), cell(101, 9, 9)], { poc: 101 })], geom(), { ...OPTS, showPoc: true }, COLORS);
        const poc = calls.filter((c) => c.op === 'strokeRect' && c.stroke === '#poc');
        expect(poc).toHaveLength(1);
        // The outline sits on the POC row: y of the row top for price 101 (+ its level).
        expect(Number(poc[0]!.args[1])).toBeCloseTo(500 - 102 + 0.5, 5);
    });

    it('writes the bar total under the lowest row, in the delta sign colour', () => {
        const { ctx, calls } = fakeCtx();
        paintFootprint(ctx, [bar([cell(100, 2, 9)])], geom(), { ...OPTS, showSummary: true }, COLORS);
        const summary = calls.filter((c) => c.op === 'fillText' && c.fill === '#down');
        expect(summary.length).toBeGreaterThan(0);
        expect(summary.some((c) => String(c.args[0]) === cellText(-7))).toBe(true);
    });

    it('drops the bar total once bars are too narrow to hold it without overlapping', () => {
        const { ctx, calls } = fakeCtx();
        paintFootprint(ctx, [bar([cell(100, 2, 9)])], geom({ halfW: 5 }), { ...OPTS, showSummary: true }, COLORS);
        expect(calls.some((c) => c.op === 'fillText')).toBe(false);
        expect(calls.some((c) => c.op === 'fillRect')).toBe(true); // the cluster still paints
    });

    it('draws nothing for a bar with no prints', () => {
        const { ctx, calls } = fakeCtx();
        paintFootprint(ctx, [bar([])], geom(), OPTS, COLORS);
        expect(calls).toHaveLength(0);
    });

    it('skips rows scrolled out of the pane', () => {
        const { ctx, calls } = fakeCtx();
        // Row at price 100 maps to y=400, far below a pane that ends at 50.
        paintFootprint(ctx, [bar([cell(100, 5, 5)])], geom({ top: 0, bottom: 50 }), OPTS, COLORS);
        expect(calls.filter((c) => c.op === 'fillRect')).toHaveLength(0);
    });
});

describe('the footprint chart type', () => {
    it('registers through the public registry with a data engine and settings', () => {
        registerFootprintChartType();
        const def = chartType('footprint');
        expect(def).toBeDefined();
        expect(def!.label).toBe('Footprint');
        expect(def!.dataEngine).toBeTypeOf('function');
        expect(def!.settings?.title).toBe('Footprint');
        // The clusters replace the candles; they are not a re-derivable bar transform.
        expect(def!.basePainting).toBe('none');
        expect(def!.barTransform).toBeUndefined();
        expect(def!.tickerModifier).toBe(false);
        expect(chartTypes().some((d) => d.id === 'footprint')).toBe(true);
    });
});

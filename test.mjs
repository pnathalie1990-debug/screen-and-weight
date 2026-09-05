// Tests for screen&weight (Repo 2).
//
// Checks the indicators, the screen and the weighting against cases where the
// right answer is known, then repeats the important ones on real market data.
//
// Run with: node test.mjs

import fs from 'fs';

const src = fs.readFileSync('./main.js', 'utf8');
const cut = src.indexOf('// Wiring');
const pure = src.slice(0, src.lastIndexOf('// ---------------------------------------------------------------------------', cut));
const names = ['parseTickers', 'ema', 'rsi', 'macdHistogram', 'mean', 'stdev',
    'annualisedVolatility', 'inverseVolatilityWeights', 'chunk'];
const M = await import('data:text/javascript;base64,' +
    Buffer.from(pure + '\nexport { ' + names.join(', ') + ' };').toString('base64'));

let failures = 0;
function check(label, condition, detail) {
    const passed = condition === true;
    if (passed === true) {
        console.log('  PASS  ' + label);
    } else {
        console.log('  FAIL  ' + label + (detail ? '  [' + detail + ']' : ''));
        failures = failures + 1;
    }
}
function section(t) { console.log('\n' + t); }

let seed = 5;
function random() {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
}
function normal() {
    let u = 0, v = 0;
    while (u === 0) { u = random(); }
    while (v === 0) { v = random(); }
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

section('1. Ticker parsing, which step 1 says must tolerate messy input');
check('lowercase is upcased', JSON.stringify(M.parseTickers('msft, jnj')) === '["MSFT","JNJ"]');
check('extra spaces are stripped',
    JSON.stringify(M.parseTickers('  msft ,   jnj  ')) === '["MSFT","JNJ"]');
check('empty entries from a trailing comma are dropped',
    JSON.stringify(M.parseTickers('msft, jnj, , ,')) === '["MSFT","JNJ"]');
check('duplicates are removed so a name cannot be double weighted',
    JSON.stringify(M.parseTickers('msft, MSFT, jnj')) === '["MSFT","JNJ"]');
check('an empty box yields an empty list rather than a crash',
    JSON.stringify(M.parseTickers('   ')) === '[]');

section('2. EMA');
const ema3 = M.ema([1, 2, 3, 4, 5], 3);
check('seeded with the simple average of the first n values', Math.abs(ema3[2] - 2) < 1e-12, 'got ' + ema3[2]);
check('null before the window fills', ema3[0] === null && ema3[1] === null);
check('constant series returns the constant', Math.abs(M.ema([6, 6, 6, 6, 6], 3)[4] - 6) < 1e-12);

section('3. RSI');
const rising = [];
for (let i = 1; i <= 200; i++) { rising.push(100 + i); }
const falling = rising.slice().reverse();
check('always rising gives 100', M.rsi(rising, 14) === 100);
check('always falling gives 0', Math.abs(M.rsi(falling, 14)) < 1e-9);
check('not enough data returns null rather than a number', M.rsi([1, 2, 3], 14) === null);
const noisy = [];
for (let i = 0; i < 300; i++) { noisy.push(100 + normal() * 2); }
const noisyRsi = M.rsi(noisy, 14);
check('a flat noisy series lands strictly inside 0 to 100',
    noisyRsi > 0 && noisyRsi < 100, 'got ' + noisyRsi.toFixed(1));

section('4. MACD histogram');
const linear = [];
for (let i = 0; i < 250; i++) { linear.push(100 + i); }
check('a perfectly steady trend leaves the histogram at about zero',
    Math.abs(M.macdHistogram(linear, 12, 26, 9)) < 0.05,
    'got ' + M.macdHistogram(linear, 12, 26, 9).toFixed(4));
const accelerating = [];
for (let i = 0; i < 250; i++) { accelerating.push(100 * Math.pow(1.01, i)); }
check('an accelerating rise is positive', M.macdHistogram(accelerating, 12, 26, 9) > 0);
const acceleratingDecline = [];
for (let i = 0; i < 250; i++) { acceleratingDecline.push(6000 - 0.08 * i * i); }
check('an accelerating decline is negative', M.macdHistogram(acceleratingDecline, 12, 26, 9) < 0);
check('not enough data returns null', M.macdHistogram([1, 2, 3, 4], 12, 26, 9) === null);

section('5. Volatility');
const flat = new Array(100).fill(50);
check('a flat price series has zero volatility', M.annualisedVolatility(flat) === 0);
const calm = [];
const wild = [];
let pc = 100;
let pw = 100;
for (let i = 0; i < 300; i++) {
    pc = pc * (1 + normal() * 0.004);
    pw = pw * (1 + normal() * 0.02);
    calm.push(pc);
    wild.push(pw);
}
check('a wilder series has the higher volatility',
    M.annualisedVolatility(wild) > M.annualisedVolatility(calm),
    M.annualisedVolatility(calm).toFixed(3) + ' vs ' + M.annualisedVolatility(wild).toFixed(3));

section('6. Inverse volatility weighting');
const w2 = M.inverseVolatilityWeights([0.1, 0.2]);
check('weights sum to one', Math.abs(w2[0] + w2[1] - 1) < 1e-12);
check('half the volatility earns twice the weight',
    Math.abs(w2[0] - 2 / 3) < 1e-12 && Math.abs(w2[1] - 1 / 3) < 1e-12,
    w2.map(function (w) { return w.toFixed(4); }).join(' / '));
const wEqual = M.inverseVolatilityWeights([0.15, 0.15, 0.15, 0.15]);
check('identical volatilities are weighted equally',
    wEqual.every(function (w) { return Math.abs(w - 0.25) < 1e-12; }));
const wOrdered = M.inverseVolatilityWeights([0.4, 0.1, 0.25]);
check('the calmest name always takes the largest weight',
    wOrdered[1] > wOrdered[2] && wOrdered[2] > wOrdered[0],
    wOrdered.map(function (w) { return w.toFixed(3); }).join(' '));
const wZero = M.inverseVolatilityWeights([0, 0, 0]);
check('all zero volatility falls back to equal weighting instead of dividing by zero',
    Math.abs(wZero.reduce(function (a, b) { return a + b; }, 0) - 1) < 1e-12
    && wZero.every(function (w) { return Math.abs(w - 1 / 3) < 1e-12; }));
const wSingle = M.inverseVolatilityWeights([0.2]);
check('a single survivor takes the whole portfolio', Math.abs(wSingle[0] - 1) < 1e-12);

section('7. Batching against the rate limit');
check('eight candidates are one batch', M.chunk(new Array(8).fill(0), 8).length === 1);
check('nine candidates become two batches', M.chunk(new Array(9).fill(0), 8).length === 2);
check('sixteen candidates become two batches', M.chunk(new Array(16).fill(0), 8).length === 2);

section('8. Real market data');
const snapshotPath = '/mnt/user-data/uploads/snapshot.json';
const haveSnapshot = fs.existsSync(snapshotPath);
if (haveSnapshot === false) {
    console.log('  SKIP  snapshot.json absent, real data checks skipped');
} else {
    const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const tickers = Object.keys(snap.prices).filter(function (t) { return t !== 'SPY'; });
    check('real series available', tickers.length >= 10, tickers.length + ' tickers');

    const results = tickers.map(function (t) {
        const closes = snap.prices[t].map(function (b) { return b.close; });
        return {
            ticker: t,
            rsi: M.rsi(closes, 14),
            hist: M.macdHistogram(closes, 12, 26, 9),
            vol: M.annualisedVolatility(closes),
        };
    });

    check('every real ticker yields an RSI inside 0 to 100',
        results.every(function (r) { return r.rsi !== null && r.rsi >= 0 && r.rsi <= 100; }));
    check('every real ticker yields a finite MACD histogram',
        results.every(function (r) { return r.hist !== null && Number.isFinite(r.hist); }));
    check('every real ticker yields a positive volatility',
        results.every(function (r) { return r.vol > 0 && Number.isFinite(r.vol); }));

    // The screen as the thesis defines it.
    const survivors = results.filter(function (r) { return r.rsi < 70 && r.hist > 0; });
    console.log('        screen keeps ' + survivors.length + ' of ' + results.length
        + ': ' + survivors.map(function (r) { return r.ticker; }).join(', '));
    check('the screen keeps some names but not all, so it is doing work',
        survivors.length > 0 && survivors.length < results.length,
        survivors.length + ' of ' + results.length);

    const enough = survivors.length >= 2;
    if (enough === true) {
        const weights = M.inverseVolatilityWeights(survivors.map(function (r) { return r.vol; }));
        const sum = weights.reduce(function (a, b) { return a + b; }, 0);
        check('weights on real survivors sum to one', Math.abs(sum - 1) < 1e-9, 'sum ' + sum.toFixed(10));
        check('no negative weight', weights.every(function (w) { return w >= 0; }));

        const paired = survivors.map(function (r, i) { return { v: r.vol, w: weights[i] }; })
            .sort(function (a, b) { return a.v - b.v; });
        let ordered = true;
        for (let i = 1; i < paired.length; i++) {
            if (paired[i].w > paired[i - 1].w + 1e-12) { ordered = false; }
        }
        check('on real data, lower volatility always means a larger weight', ordered);

        // Loosening a threshold can only keep more names, never fewer. This is
        // the property the live threshold sliders depend on.
        const looser = results.filter(function (r) { return r.rsi < 80 && r.hist > 0; });
        check('raising the RSI ceiling never shrinks the survivor list',
            looser.length >= survivors.length, looser.length + ' vs ' + survivors.length);
        const tighter = results.filter(function (r) { return r.rsi < 50 && r.hist > 0; });
        check('lowering the RSI ceiling never grows the survivor list',
            tighter.length <= survivors.length, tighter.length + ' vs ' + survivors.length);
    }

    // A spot check the handout asks for: compare one ticker's RSI against a
    // second implementation written differently, to catch a shared mistake.
    const closes = snap.prices[tickers[0]].map(function (b) { return b.close; });
    function rsiPlain(series, period) {
        const gains = [];
        const losses = [];
        for (let i = 1; i < series.length; i++) {
            const d = series[i] - series[i - 1];
            gains.push(d > 0 ? d : 0);
            losses.push(d < 0 ? -d : 0);
        }
        let ag = 0;
        let al = 0;
        for (let i = 0; i < period; i++) { ag = ag + gains[i]; al = al + losses[i]; }
        ag = ag / period;
        al = al / period;
        for (let i = period; i < gains.length; i++) {
            ag = (ag * (period - 1) + gains[i]) / period;
            al = (al * (period - 1) + losses[i]) / period;
        }
        return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    const a = M.rsi(closes, 14);
    const b = rsiPlain(closes, 14);
    check('RSI agrees with an independently written implementation',
        Math.abs(a - b) < 1e-9, a.toFixed(6) + ' vs ' + b.toFixed(6));
}

console.log('\n' + (failures === 0 ? 'All checks passed.' : failures + ' CHECK(S) FAILED.'));
process.exit(failures === 0 ? 0 : 1);

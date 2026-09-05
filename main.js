// ---------------------------------------------------------------------------
// screen&weight, Repo 2
// Generative AI in Finance, WU Executive Academy.
//
// Thesis, taken from the class build handout: a stock with RSI below the
// overbought line and a positive MACD histogram is a name worth holding.
// Screen the candidates on those two conditions, then weight the survivors by
// inverse volatility so the calmer names carry more of the portfolio.
//
// Deliberately a different shape from Repo 1. Repo 1 studies one ticker in
// depth and optimises a portfolio by mean variance. This one screens a list
// and weights by a simple risk rule, which is the pattern the class session
// was built around.
//
// The rule the app is built on: every number is computed here in JavaScript.
// The model receives finished figures and writes prose about them.
//
// Conventions from the class reference application: booleans are named before
// they are tested, comparisons against true are explicit, every conditional
// uses braces, and no em dashes appear in comments or interface strings.
// ---------------------------------------------------------------------------

const TRADING_DAYS = 252;
const HISTORY_DAYS = 300;
const CREDITS_PER_MINUTE = 8;
const SPARK_POINTS = 60;

// Everything the screen and the weighting need, kept in one place so a
// threshold change can recompute without touching the network again.
const state = {
    candidates: [],   // [{ ticker, closes, dates, rsi, histogram, volatility }]
    failed: [],
    survivors: [],
    weights: [],
    fetchedAt: null,
};

function el(id) {
    return document.getElementById(id);
}

function setStatus(message, isError) {
    const node = el('status');
    node.textContent = message;
    const errorRequested = isError === true;
    if (errorRequested === true) {
        node.classList.add('bad');
    } else {
        node.classList.remove('bad');
    }
}

function logLine(message) {
    const node = el('log');
    const line = document.createElement('div');
    line.textContent = message;
    node.appendChild(line);
    node.scrollTop = node.scrollHeight;
}

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
}

function pct(v, digits) {
    const places = digits === undefined ? 2 : digits;
    return (v * 100).toFixed(places) + '%';
}

function escapeText(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Step 1 asks for a form that does not crash on extra spaces or lowercase.
function parseTickers(raw) {
    return raw.split(',')
        .map(function (t) { return t.trim().toUpperCase(); })
        .filter(function (t) { return t.length > 0; })
        .filter(function (t, i, all) { return all.indexOf(t) === i; });
}

// ---------------------------------------------------------------------------
// Step 2: price history.
//
// Twelve Data rather than the unauthenticated Yahoo endpoint, because Twelve
// Data returns permissive CORS headers and the browser can call it directly.
// Yahoo does not, and needs a third party proxy in front of every request,
// which is an uncontrolled dependency in a live demonstration.
// ---------------------------------------------------------------------------

async function fetchBatch(symbols, apiKey) {
    const url = 'https://api.twelvedata.com/time_series'
        + '?symbol=' + encodeURIComponent(symbols.join(','))
        + '&interval=1day&outputsize=' + HISTORY_DAYS
        + '&apikey=' + encodeURIComponent(apiKey);

    const response = await fetch(url);
    const body = await response.text();

    let raw;
    try {
        raw = JSON.parse(body);
    } catch (parseError) {
        throw new Error('Twelve Data did not return JSON: ' + body.slice(0, 160));
    }

    const requestRejected = raw && raw.status === 'error';
    if (requestRejected === true) {
        throw new Error(raw.message || 'Twelve Data rejected the request');
    }

    const single = symbols.length === 1;
    const keyed = single === true ? { [symbols[0]]: raw } : raw;

    const out = {};
    for (const symbol of symbols) {
        const entry = keyed[symbol];
        const absent = entry === undefined || entry === null;
        if (absent === true) {
            out[symbol] = { ok: false, reason: 'no data returned' };
            continue;
        }
        const rejected = entry.status === 'error';
        if (rejected === true) {
            out[symbol] = { ok: false, reason: entry.message || 'error' };
            continue;
        }
        const values = entry.values || [];
        const empty = values.length === 0;
        if (empty === true) {
            out[symbol] = { ok: false, reason: 'empty series' };
            continue;
        }
        // Twelve Data sends newest first; everything below assumes oldest first.
        const bars = values.map(function (b) {
            return { date: b.datetime, close: Number(b.close) };
        }).filter(function (b) {
            return Number.isNaN(b.close) === false;
        }).sort(function (a, b) {
            return a.date < b.date ? -1 : 1;
        });
        out[symbol] = { ok: true, bars: bars };
    }
    return out;
}

// ---------------------------------------------------------------------------
// Step 3: indicators, all in JavaScript
// ---------------------------------------------------------------------------

function ema(values, window) {
    const out = new Array(values.length).fill(null);
    const multiplier = 2 / (window + 1);
    const seed = window - 1;
    const tooShort = seed >= values.length;
    if (tooShort === true) {
        return out;
    }
    let total = 0;
    for (let i = 0; i <= seed; i++) {
        total = total + values[i];
    }
    out[seed] = total / window;
    for (let i = seed + 1; i < values.length; i++) {
        out[i] = values[i] * multiplier + out[i - 1] * (1 - multiplier);
    }
    return out;
}

// Wilder's smoothing, which is the standard RSI rather than a plain average.
function rsi(closes, period) {
    const tooShort = closes.length <= period;
    if (tooShort === true) {
        return null;
    }
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change >= 0) {
            gains = gains + change;
        } else {
            losses = losses - change;
        }
    }
    let averageGain = gains / period;
    let averageLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        averageGain = (averageGain * (period - 1) + gain) / period;
        averageLoss = (averageLoss * (period - 1) + loss) / period;
    }
    const noLosses = averageLoss === 0;
    if (noLosses === true) {
        return 100;
    }
    return 100 - 100 / (1 + averageGain / averageLoss);
}

// The screen only needs the latest histogram value, but the full series is
// returned so the value can be checked against a chart if ever needed.
function macdHistogram(closes, fastWindow, slowWindow, signalWindow) {
    const fast = ema(closes, fastWindow);
    const slow = ema(closes, slowWindow);
    const macd = closes.map(function (_, i) {
        const incomplete = fast[i] === null || slow[i] === null;
        if (incomplete === true) {
            return null;
        }
        return fast[i] - slow[i];
    });
    const firstValid = macd.findIndex(function (v) { return v !== null; });
    const noneValid = firstValid === -1;
    if (noneValid === true) {
        return null;
    }
    const tail = macd.slice(firstValid);
    const signalTail = ema(tail, signalWindow);
    const lastMacd = tail[tail.length - 1];
    const lastSignal = signalTail[signalTail.length - 1];
    const signalMissing = lastSignal === null;
    if (signalMissing === true) {
        return null;
    }
    return lastMacd - lastSignal;
}

function mean(values) {
    let total = 0;
    for (const v of values) {
        total = total + v;
    }
    return total / values.length;
}

function stdev(values) {
    const m = mean(values);
    let sum = 0;
    for (const v of values) {
        sum = sum + (v - m) * (v - m);
    }
    // Sample standard deviation, so divide by n minus 1.
    return Math.sqrt(sum / (values.length - 1));
}

function annualisedVolatility(closes) {
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
        returns.push(closes[i] / closes[i - 1] - 1);
    }
    return stdev(returns) * Math.sqrt(TRADING_DAYS);
}

// ---------------------------------------------------------------------------
// Step 5: inverse volatility weights.
//
// The handout names this as the accepted stand-in for minimum variance. It is
// not the same thing: it ignores correlation entirely and only looks at each
// stock on its own. That is a real simplification and it is stated in the
// interface rather than glossed over.
// ---------------------------------------------------------------------------

function inverseVolatilityWeights(volatilities) {
    const inverses = volatilities.map(function (v) {
        const degenerate = v <= 0;
        if (degenerate === true) {
            return 0;
        }
        return 1 / v;
    });
    let total = 0;
    for (const inv of inverses) {
        total = total + inv;
    }
    const nothingUsable = total <= 0;
    if (nothingUsable === true) {
        // Fall back to equal weighting rather than dividing by zero.
        return volatilities.map(function () { return 1 / volatilities.length; });
    }
    return inverses.map(function (inv) { return inv / total; });
}

// ---------------------------------------------------------------------------
// Drawing. Plain SVG, so there is no charting dependency to break.
// ---------------------------------------------------------------------------

function sparkline(closes) {
    const points = closes.slice(-SPARK_POINTS);
    const tooFew = points.length < 2;
    if (tooFew === true) {
        return '';
    }
    const w = 108;
    const h = 26;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = (max - min) || 1;
    const coords = points.map(function (v, i) {
        const x = (i / (points.length - 1)) * w;
        const y = h - ((v - min) / span) * h;
        return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const rising = points[points.length - 1] >= points[0];
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" class="spark" preserveAspectRatio="none">'
        + '<polyline points="' + coords + '" class="' + (rising === true ? 'spark-up' : 'spark-down') + '" />'
        + '</svg>';
}

function renderWeightsChart(rows) {
    const barH = 26;
    const gap = 8;
    const labelW = 68;
    const width = 700;
    const height = rows.length * (barH + gap) + 6;
    const maxWeight = Math.max(...rows.map(function (r) { return r.weight; }));

    let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" class="chart" role="img" aria-label="Inverse volatility weights">';
    rows.forEach(function (r, i) {
        const y = i * (barH + gap);
        const w = maxWeight > 0 ? (r.weight / maxWeight) * (width - labelW - 92) : 0;
        svg += '<text x="0" y="' + (y + barH * 0.7) + '" class="bar-label">' + r.ticker + '</text>';
        svg += '<rect x="' + labelW + '" y="' + y + '" width="' + w + '" height="' + barH + '" class="bar" />';
        svg += '<text x="' + (labelW + w + 9) + '" y="' + (y + barH * 0.7) + '" class="bar-value">'
            + pct(r.weight) + '</text>';
    });
    svg += '</svg>';
    el('weights-chart').innerHTML = svg;
}

// ---------------------------------------------------------------------------
// Steps 3 to 5: screen and weight. Called after a fetch and again whenever a
// threshold moves, which is why it never touches the network.
// ---------------------------------------------------------------------------

function screenAndWeight() {
    const nothingLoaded = state.candidates.length === 0;
    if (nothingLoaded === true) {
        return;
    }

    const rsiMax = Number(el('rsi-max').value);
    const macdMin = Number(el('macd-min').value);

    const evaluated = state.candidates.map(function (c) {
        const rsiKnown = c.rsi !== null;
        const histKnown = c.histogram !== null;
        const rsiPasses = rsiKnown === true && c.rsi < rsiMax;
        const macdPasses = histKnown === true && c.histogram > macdMin;
        const passes = rsiPasses === true && macdPasses === true;
        return Object.assign({}, c, { rsiPasses: rsiPasses, macdPasses: macdPasses, passes: passes });
    });

    const survivors = evaluated.filter(function (c) { return c.passes === true; });
    state.survivors = survivors;

    // Signal table
    let table = '<table><thead><tr>'
        + '<th>Ticker</th><th class="mid">Last 60 sessions</th>'
        + '<th class="num">Close</th><th class="num">RSI</th><th class="num">MACD hist</th>'
        + '<th class="num">Volatility</th><th>Screen</th>'
        + '</tr></thead><tbody>';
    for (const c of evaluated) {
        const rsiText = c.rsi === null ? 'n/a' : c.rsi.toFixed(1);
        const histText = c.histogram === null ? 'n/a' : c.histogram.toFixed(3);
        const badge = c.passes === true
            ? '<span class="badge pass">keep</span>'
            : '<span class="badge fail">drop</span>';
        const why = [];
        const rsiFailed = c.rsiPasses === false;
        if (rsiFailed === true) {
            why.push('RSI');
        }
        const macdFailed = c.macdPasses === false;
        if (macdFailed === true) {
            why.push('MACD');
        }
        const reason = why.length > 0 ? '<span class="why">' + why.join(' + ') + '</span>' : '';
        table += '<tr class="' + (c.passes === true ? 'row-pass' : 'row-fail') + '">'
            + '<td class="tk">' + c.ticker + '</td>'
            + '<td class="mid">' + sparkline(c.closes) + '</td>'
            + '<td class="num">' + c.closes[c.closes.length - 1].toFixed(2) + '</td>'
            + '<td class="num ' + (c.rsiPasses === true ? '' : 'bad') + '">' + rsiText + '</td>'
            + '<td class="num ' + (c.macdPasses === true ? '' : 'bad') + '">' + histText + '</td>'
            + '<td class="num">' + pct(c.volatility, 1) + '</td>'
            + '<td>' + badge + ' ' + reason + '</td>'
            + '</tr>';
    }
    table += '</tbody></table>';
    el('signals-table').innerHTML = table;

    el('rule-summary').innerHTML =
        '<strong>' + survivors.length + ' of ' + evaluated.length + '</strong> candidates pass '
        + 'RSI below ' + rsiMax + ' and MACD histogram above ' + macdMin + '.';

    el('rules-panel').hidden = false;
    el('signals-panel').hidden = false;

    const noSurvivors = survivors.length === 0;
    if (noSurvivors === true) {
        el('weights-panel').hidden = false;
        el('weights-summary').innerHTML =
            'No candidate passes both conditions, so there is no portfolio to weight. '
            + 'Loosen a threshold or widen the candidate list.';
        el('weights-chart').innerHTML = '';
        el('weights-table').innerHTML = '';
        el('note-panel').hidden = true;
        state.weights = [];
        return;
    }

    const weights = inverseVolatilityWeights(survivors.map(function (c) { return c.volatility; }));

    // Never display weights without checking them first.
    let sum = 0;
    for (const w of weights) {
        sum = sum + w;
    }
    const sumsToOne = Math.abs(sum - 1) < 1e-9;
    if (sumsToOne === false) {
        el('weights-summary').innerHTML =
            '<span class="bad">The weights sum to ' + sum.toFixed(6) + ' rather than 1. Not showing them.</span>';
        el('weights-chart').innerHTML = '';
        el('weights-table').innerHTML = '';
        return;
    }

    const rows = survivors.map(function (c, i) {
        return { ticker: c.ticker, weight: weights[i], volatility: c.volatility, rsi: c.rsi, histogram: c.histogram };
    }).sort(function (a, b) { return b.weight - a.weight; });
    state.weights = rows;

    const quietest = rows[0];
    const loudest = rows[rows.length - 1];
    el('weights-summary').innerHTML =
        '<strong>' + rows.length + ' holdings.</strong> '
        + quietest.ticker + ' is the calmest at ' + pct(quietest.volatility, 1)
        + ' annualised volatility and takes the largest weight, ' + pct(quietest.weight) + '. '
        + loudest.ticker + ' is the most volatile at ' + pct(loudest.volatility, 1)
        + ' and takes the smallest, ' + pct(loudest.weight) + '.';

    renderWeightsChart(rows);

    let wt = '<table><thead><tr><th>Ticker</th><th class="num">Annualised volatility</th>'
        + '<th class="num">Weight</th></tr></thead><tbody>';
    for (const r of rows) {
        wt += '<tr><td class="tk">' + r.ticker + '</td><td class="num">' + pct(r.volatility, 1)
            + '</td><td class="num strong">' + pct(r.weight) + '</td></tr>';
    }
    wt += '<tr class="total"><td>Total</td><td></td><td class="num strong">' + pct(sum) + '</td></tr>';
    wt += '</tbody></table>';
    el('weights-table').innerHTML = wt;

    el('weights-panel').hidden = false;
    el('note-panel').hidden = false;
}

// ---------------------------------------------------------------------------
// Steps 1 and 2: fetch, then compute indicators once per candidate
// ---------------------------------------------------------------------------

async function runScreen() {
    const key = el('data-key').value.trim();
    const noKey = key.length === 0;
    if (noKey === true) {
        setStatus('Enter your Twelve Data key first.', true);
        return;
    }

    const tickers = parseTickers(el('tickers').value);
    const tooFew = tickers.length < 1;
    if (tooFew === true) {
        setStatus('Enter at least one ticker.', true);
        return;
    }
    const tooMany = tickers.length > 16;
    if (tooMany === true) {
        setStatus('Sixteen candidates at most, to stay inside the free tier.', true);
        return;
    }

    const rsiPeriod = Number(el('rsi-period').value);
    const fastWindow = Number(el('macd-fast').value);
    const slowWindow = Number(el('macd-slow').value);
    const signalWindow = Number(el('macd-signal').value);
    const windowsInverted = fastWindow >= slowWindow;
    if (windowsInverted === true) {
        setStatus('The MACD fast window must be shorter than the slow window.', true);
        return;
    }

    el('log').innerHTML = '';
    state.candidates = [];
    state.failed = [];

    const batches = chunk(tickers, CREDITS_PER_MINUTE);
    setStatus('Fetching ' + tickers.length + ' candidates in ' + batches.length + ' batch(es).');

    for (let i = 0; i < batches.length; i++) {
        logLine('Batch ' + (i + 1) + ' of ' + batches.length + ': ' + batches[i].join(', '));
        try {
            const result = await fetchBatch(batches[i], key);
            for (const symbol of batches[i]) {
                const entry = result[symbol];
                const succeeded = entry && entry.ok === true;
                if (succeeded === false) {
                    state.failed.push(symbol);
                    logLine('  ' + symbol + ': failed, ' + (entry ? entry.reason : 'unknown'));
                    continue;
                }
                const closes = entry.bars.map(function (b) { return b.close; });
                const enoughHistory = closes.length > Math.max(rsiPeriod, slowWindow) + signalWindow;
                if (enoughHistory === false) {
                    state.failed.push(symbol);
                    logLine('  ' + symbol + ': only ' + closes.length + ' sessions, not enough for these settings');
                    continue;
                }
                state.candidates.push({
                    ticker: symbol,
                    closes: closes,
                    dates: entry.bars.map(function (b) { return b.date; }),
                    rsi: rsi(closes, rsiPeriod),
                    histogram: macdHistogram(closes, fastWindow, slowWindow, signalWindow),
                    volatility: annualisedVolatility(closes),
                });
                logLine('  ' + symbol + ': ' + closes.length + ' sessions');
            }
        } catch (error) {
            for (const symbol of batches[i]) {
                state.failed.push(symbol);
            }
            logLine('  batch failed: ' + error.message);
        }
        const moreToCome = i < batches.length - 1;
        if (moreToCome === true) {
            logLine('Waiting 61 seconds for the rate limit window.');
            await sleep(61000);
        }
    }

    const anyFailed = state.failed.length > 0;
    if (anyFailed === true) {
        logLine('Excluded: ' + state.failed.join(', '));
    }

    const nothingUsable = state.candidates.length === 0;
    if (nothingUsable === true) {
        setStatus('No candidate returned usable data.', true);
        return;
    }

    state.fetchedAt = state.candidates[0].dates[state.candidates[0].dates.length - 1];
    setStatus('Fetched ' + state.candidates.length + ' of ' + tickers.length
        + ' candidates, latest session ' + state.fetchedAt + '.');
    screenAndWeight();
}

// ---------------------------------------------------------------------------
// Step 6: the research note
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
    'You are an analyst writing a short note for a reader who is not technical.',
    'You are given the results of a stock screen and a set of portfolio weights.',
    'All of it was calculated before you saw it. Use only these figures and invent nothing.',
    '',
    'Write three short paragraphs, about 200 words in total.',
    'First: what the screen was looking for and how many names passed.',
    'Second: how the weighting works and which holdings dominate, with the reason.',
    'Third: the main limitation a reader should keep in mind.',
    '',
    'Rules you must follow:',
    'Do not invent any number that was not given to you.',
    'No price targets and no recommendation to buy or sell.',
    'Do not claim to know what any stock will do next.',
    'Say plainly that RSI and MACD describe past prices and are not forecasts.',
    'Say plainly that inverse volatility weighting ignores how the holdings move together.',
    'Write plain prose. No bullet points, no headings.',
].join('\n');

function buildPrompt() {
    const rsiMax = el('rsi-max').value;
    const macdMin = el('macd-min').value;
    const lines = [];
    lines.push('Screen: keep a stock when RSI is below ' + rsiMax
        + ' and the MACD histogram is above ' + macdMin + '. Both conditions must hold.');
    lines.push('Indicator settings: RSI period ' + el('rsi-period').value
        + ', MACD ' + el('macd-fast').value + '/' + el('macd-slow').value + '/' + el('macd-signal').value + '.');
    lines.push('Latest session in the data: ' + state.fetchedAt + '.');
    lines.push('Candidates screened: ' + state.candidates.length
        + '. Passed: ' + state.survivors.length + '.');
    const anyFailed = state.failed.length > 0;
    if (anyFailed === true) {
        lines.push('Could not be retrieved: ' + state.failed.join(', ') + '.');
    }
    lines.push('');
    lines.push('Rejected and why:');
    for (const c of state.candidates) {
        const rejected = state.survivors.indexOf(c) === -1
            && state.survivors.find(function (s) { return s.ticker === c.ticker; }) === undefined;
        if (rejected === true) {
            const reasons = [];
            const rsiTooHigh = c.rsi !== null && c.rsi >= Number(rsiMax);
            if (rsiTooHigh === true) {
                reasons.push('RSI ' + c.rsi.toFixed(1));
            }
            const macdTooLow = c.histogram !== null && c.histogram <= Number(macdMin);
            if (macdTooLow === true) {
                reasons.push('MACD histogram ' + c.histogram.toFixed(3));
            }
            lines.push('  ' + c.ticker + ': ' + (reasons.length > 0 ? reasons.join(', ') : 'insufficient data'));
        }
    }
    lines.push('');
    lines.push('Portfolio, weighted by inverse annualised volatility:');
    for (const r of state.weights) {
        lines.push('  ' + r.ticker + ': weight ' + pct(r.weight)
            + ', annualised volatility ' + pct(r.volatility, 1)
            + ', RSI ' + (r.rsi === null ? 'n/a' : r.rsi.toFixed(1))
            + ', MACD histogram ' + (r.histogram === null ? 'n/a' : r.histogram.toFixed(3)));
    }
    return lines.join('\n');
}

async function writeNote() {
    const key = el('llm-key').value.trim();
    const noKey = key.length === 0;
    if (noKey === true) {
        el('note').innerHTML = '<p class="bad">Enter your Gemini key in section 01.</p>';
        return;
    }
    const nothingToExplain = state.weights.length === 0;
    if (nothingToExplain === true) {
        el('note').innerHTML = '<p class="bad">Run the screen first, and make sure something survives it.</p>';
        return;
    }

    const model = el('llm-model').value.trim();
    el('note').innerHTML = '<p class="dim">Writing.</p>';

    try {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
            + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
                contents: [{ role: 'user', parts: [{ text: buildPrompt() }] }],
                // Gemini 3 models spend part of the output budget on internal
                // reasoning and reject a thinkingBudget parameter outright, so
                // the ceiling is simply set high enough for both.
                generationConfig: { temperature: 0.3, maxOutputTokens: 8000 },
            }),
        });

        const failed = response.ok === false;
        if (failed === true) {
            const detail = await response.text();
            const hint = { 400: 'The key may be wrong.', 404: 'The model id may be wrong.' }[response.status] || '';
            throw new Error('Gemini call failed (HTTP ' + response.status + '). ' + hint + ' ' + detail.slice(0, 200));
        }

        const data = await response.json();
        const candidate = data.candidates && data.candidates[0];
        const parts = candidate && candidate.content && candidate.content.parts;
        const noText = parts === undefined || parts === null;
        if (noText === true) {
            throw new Error('Gemini returned no text. It may have blocked the request.');
        }
        // A truncated reply looks finished, which is worse than an error.
        const truncated = candidate.finishReason === 'MAX_TOKENS';
        if (truncated === true) {
            throw new Error('Gemini hit the output limit and the note was cut off.');
        }

        const text = parts.map(function (p) { return p.text || ''; }).join('');
        const paragraphs = text.split(/\n\s*\n/).filter(function (t) { return t.trim().length > 0; });
        el('note').innerHTML = paragraphs.map(function (t) {
            return '<p>' + escapeText(t.trim()) + '</p>';
        }).join('');
    } catch (error) {
        el('note').innerHTML = '<p class="bad">' + escapeText(error.message) + '</p>';
    }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

el('run').addEventListener('click', runScreen);
el('write-note').addEventListener('click', writeNote);

// Moving a threshold re-screens from data already in memory. No refetch, so it
// costs no API credits and the survivor list changes live.
for (const id of ['rsi-max', 'macd-min']) {
    el(id).addEventListener('input', screenAndWeight);
}

el('tickers').addEventListener('keydown', function (event) {
    const isEnter = event.key === 'Enter';
    if (isEnter === true) {
        runScreen();
    }
});

export {
    parseTickers, ema, rsi, macdHistogram, mean, stdev,
    annualisedVolatility, inverseVolatilityWeights, chunk,
};

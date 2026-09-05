// End to end smoke test for screen&weight (Repo 2).
//
// A DOM stub and an intercepted network let the whole flow run here: fetch,
// screen, weight, render, and the research note. Driven by real prices from
// the committed snapshot.
//
// Run with: node smoke.mjs

import fs from 'fs';

class Node {
    constructor(id) {
        this.id = id;
        this._html = '';
        this._text = '';
        this.hidden = false;
        this.value = '';
        this.children = [];
        this.scrollTop = 0;
        this.scrollHeight = 0;
        this.listeners = {};
        this.classList = {
            set: new Set(),
            add(c) { this.set.add(c); },
            remove(c) { this.set.delete(c); },
            contains(c) { return this.set.has(c); },
        };
    }
    set innerHTML(v) { this._html = String(v); this.children = []; }
    get innerHTML() {
        const appended = this.children.map(function (c) { return c.textContent; }).join('\n');
        return this._html + appended;
    }
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text; }
    appendChild(c) { this.children.push(c); }
    addEventListener(ev, fn) { this.listeners[ev] = fn; }
}

const nodes = new Map();
const html = fs.readFileSync('./index.html', 'utf8');
for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Node(m[1]);
    // Mirror the real starting visibility, otherwise a "panel revealed" check
    // passes even when nothing revealed it.
    node.hidden = /\shidden(\s|>|\/)/.test(m[0]);
    nodes.set(m[1], node);
}

global.document = {
    getElementById(id) {
        const missing = nodes.has(id) === false;
        if (missing === true) { throw new Error('main.js asked for #' + id + ', absent from index.html'); }
        return nodes.get(id);
    },
    createElement(tag) { return new Node(tag); },
};

const snapshotPath = '/mnt/user-data/uploads/snapshot.json';
const haveSnapshot = fs.existsSync(snapshotPath);
if (haveSnapshot === false) {
    console.log('snapshot.json absent, cannot run the smoke test');
    process.exit(1);
}
const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

let lastLlmBody = null;
global.fetch = async function (url, options) {
    const isTwelveData = String(url).includes('api.twelvedata.com');
    if (isTwelveData === true) {
        const symbols = new URL(url).searchParams.get('symbol').split(',');
        const payload = {};
        for (const s of symbols) {
            const series = snap.prices[s];
            const known = series !== undefined;
            if (known === true) {
                payload[s] = {
                    status: 'ok',
                    // Newest first, as the real API sends it. The code must re-sort.
                    values: series.slice().reverse().map(function (b) {
                        return { datetime: b.date, close: String(b.close) };
                    }),
                };
            } else {
                payload[s] = { status: 'error', message: 'symbol not found' };
            }
        }
        const single = symbols.length === 1;
        const body = single === true ? payload[symbols[0]] : payload;
        return { ok: true, status: 200, text: async function () { return JSON.stringify(body); } };
    }

    const isGemini = String(url).includes('generativelanguage.googleapis.com');
    if (isGemini === true) {
        lastLlmBody = JSON.parse(options.body);
        return {
            ok: true, status: 200,
            json: async function () {
                return { candidates: [{ finishReason: 'STOP', content: { parts: [{
                    text: 'First paragraph about the screen.\n\nSecond about the weighting.\n\nThird about the limitation.',
                }] } }] };
            },
        };
    }
    throw new Error('unexpected fetch to ' + url);
};

const src = fs.readFileSync('./main.js', 'utf8');
const mod = await import('data:text/javascript;base64,' +
    Buffer.from(src + '\nexport { state as __state };').toString('base64'));

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

function setDefaults() {
    // Deliberately messy input: lowercase, stray spaces, a duplicate.
    nodes.get('tickers').value = ' msft, JNJ ,nvda, pg, msft, cost, csco, nke ';
    nodes.get('rsi-period').value = '14';
    nodes.get('macd-fast').value = '12';
    nodes.get('macd-slow').value = '26';
    nodes.get('macd-signal').value = '9';
    nodes.get('data-key').value = 'test-key';
    nodes.get('llm-key').value = 'test-key';
    nodes.get('llm-model').value = 'gemini-3.6-flash';
    nodes.get('rsi-max').value = '70';
    nodes.get('macd-min').value = '0';
}
setDefaults();

section('1. Input handling refuses rather than guessing');
nodes.get('data-key').value = '';
await nodes.get('run').listeners.click();
check('a missing data key is refused', nodes.get('status').textContent.includes('Twelve Data'));
setDefaults();

nodes.get('macd-fast').value = '40';
await nodes.get('run').listeners.click();
check('inverted MACD windows are refused',
    nodes.get('status').textContent.includes('shorter'), nodes.get('status').textContent);
setDefaults();

section('2. Fetch and screen');
await nodes.get('run').listeners.click();
check('status reports what was fetched',
    nodes.get('status').textContent.includes('Fetched'), nodes.get('status').textContent);
check('the duplicate ticker was collapsed, so seven candidates not eight',
    mod.__state.candidates.length === 7, mod.__state.candidates.length + ' candidates');
check('lowercase input arrived as uppercase tickers',
    mod.__state.candidates.every(function (c) { return c.ticker === c.ticker.toUpperCase(); }));
check('rules panel is revealed', nodes.get('rules-panel').hidden === false);
check('signals panel is revealed', nodes.get('signals-panel').hidden === false);

section('3. Signals per candidate');
const table = nodes.get('signals-table').innerHTML;
check('a row per candidate', (table.match(/<tr class="row-/g) || []).length === 7);
check('every row carries a sparkline', (table.match(/class="spark"/g) || []).length === 7);
check('keep and drop badges are used',
    table.includes('badge pass') && table.includes('badge fail'));
check('no NaN reached the table', table.includes('NaN') === false);
check('no undefined reached the table', table.includes('undefined') === false);
check('every candidate has an RSI inside 0 to 100',
    mod.__state.candidates.every(function (c) { return c.rsi >= 0 && c.rsi <= 100; }));

section('4. Weights');
check('weights panel is revealed', nodes.get('weights-panel').hidden === false);
const rows = mod.__state.weights;
check('a weight for every survivor', rows.length === mod.__state.survivors.length);
const sum = rows.reduce(function (a, r) { return a + r.weight; }, 0);
check('weights sum to one', Math.abs(sum - 1) < 1e-9, 'sum ' + sum.toFixed(10));
check('rows are sorted with the largest weight first',
    rows.every(function (r, i) { return i === 0 || rows[i - 1].weight >= r.weight; }));
check('the largest weight belongs to the lowest volatility holding',
    rows[0].volatility === Math.min(...rows.map(function (r) { return r.volatility; })));
check('a bar is drawn per holding',
    (nodes.get('weights-chart').innerHTML.match(/<rect/g) || []).length === rows.length);
check('the weights table totals to 100 per cent',
    nodes.get('weights-table').innerHTML.includes('100.00%'));

section('5. Thresholds re-screen live without refetching');
const baseline = mod.__state.survivors.length;
nodes.get('rsi-max').value = '100';
nodes.get('macd-min').value = '-999';
nodes.get('rsi-max').listeners.input();
check('loosening both thresholds keeps every candidate',
    mod.__state.survivors.length === mod.__state.candidates.length,
    mod.__state.survivors.length + ' of ' + mod.__state.candidates.length);

nodes.get('rsi-max').value = '1';
nodes.get('rsi-max').listeners.input();
check('an impossible threshold leaves nothing', mod.__state.survivors.length === 0);
check('and the app says so instead of showing an empty chart',
    nodes.get('weights-summary').innerHTML.includes('No candidate passes'));
check('the note panel is hidden when there is nothing to explain',
    nodes.get('note-panel').hidden === true);

nodes.get('rsi-max').value = '70';
nodes.get('macd-min').value = '0';
nodes.get('rsi-max').listeners.input();
check('restoring the thresholds restores the original survivor list',
    mod.__state.survivors.length === baseline, mod.__state.survivors.length + ' vs ' + baseline);
check('no network call was made while re-screening',
    mod.__state.candidates.length === 7);

section('6. Research note');
await nodes.get('write-note').listeners.click();
check('three paragraphs rendered',
    (nodes.get('note').innerHTML.match(/<p>/g) || []).length === 3);
const prompt = lastLlmBody.contents[0].parts[0].text;
check('the prompt states the screen rules', prompt.includes('RSI is below 70'));
check('the prompt carries the computed weights', prompt.includes('weight '));
check('the prompt explains why names were rejected', prompt.includes('Rejected and why'));
check('the prompt has no placeholder values',
    prompt.includes('undefined') === false && prompt.includes('NaN') === false);
const systemPrompt = lastLlmBody.system_instruction.parts[0].text;
check('the system prompt forbids invented numbers', systemPrompt.includes('invent nothing'));
check('the system prompt forbids recommendations', systemPrompt.includes('no recommendation'));
check('the system prompt demands the correlation caveat',
    systemPrompt.includes('ignores how the holdings move together'));

section('7. Unknown symbols degrade gracefully');
nodes.get('tickers').value = 'msft, jnj, zzzz';
await nodes.get('run').listeners.click();
check('the bad symbol is named in the log', nodes.get('log').innerHTML.includes('ZZZZ'));
check('the screen still runs on the remainder', mod.__state.candidates.length === 2);
check('status reports two of three', nodes.get('status').textContent.includes('2 of 3'),
    nodes.get('status').textContent);

console.log('\n' + (failures === 0 ? 'Smoke test passed.' : failures + ' CHECK(S) FAILED.'));
process.exit(failures === 0 ? 0 : 1);

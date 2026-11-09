import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { getAuthHandler } from './auth/index.js';
import { emitReason, cleanReason } from './auth/common.js';

// Read configuration
const loadProfilePath = __ENV.LOAD_PROFILE_PATH || './load-profile.json';
// Replace {{VAR_NAME}} tokens in the profile with environment values (e.g. secrets from the CI credential store)
function loadProfile() {
    let text;
    try {
        text = open(loadProfilePath);
    } catch (e) {
        emitReason('PROFILE_NOT_FOUND', `The load profile could not be read (${loadProfilePath}). Check apiName (folder, case-sensitive), profileName and the branch.`);
        throw e;
    }
    text = text.replace(/\{\{(\w+)\}\}/g, (match, name) => (__ENV[name] !== undefined ? __ENV[name] : match));
    try {
        return JSON.parse(text);
    } catch (e) {
        // The parser message is not repeated in the reason: the text now holds the substituted secrets
        emitReason('PROFILE_INVALID', `The load profile is not valid JSON (${loadProfilePath}). Check it for a missing comma, bracket or quote.`);
        throw e;
    }
}
const config = loadProfile();

const defaultThresholds = {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
};

export const options = {
    stages: config.stages,
    thresholds: config.thresholds || defaultThresholds,
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'], // p(99) is not in k6's default list
};

// Authentication is pluggable: each authType lives in its own module under ./auth (see auth/index.js).
// The engine only resolves which module an endpoint uses and calls its validate / setup / apply functions.
//
// An endpoint's own authType/authParameters overrides the root-level default; no authType, or "NONE", means no engine-managed auth.
// Distinct credential sets are collected once, so a token is fetched once however many endpoints share it.
const authSets = [];

function resolveAuth(ep) {
    const authType = ep.authType !== undefined ? ep.authType : config.authType;
    if (!authType || authType === 'NONE') {
        return null;
    }
    let handler;
    try {
        handler = getAuthHandler(authType); // throws on an unknown authType, before any load starts
    } catch (e) {
        emitReason('UNKNOWN_AUTH_TYPE', e.message);
        throw e;
    }
    const authParameters = ep.authParameters || config.authParameters || {}; // the authParameters block
    const signature = JSON.stringify([authType, authParameters]);
    let index = authSets.findIndex((set) => set.signature === signature);
    if (index < 0) {
        authSets.push({ signature: signature, handler: handler, authParameters: authParameters });
        index = authSets.length - 1;
    }
    return { handler: handler, authParameters: authParameters, index: index };
}

const authByEndpoint = new Map();
for (const ep of config.endpoints || []) {
    authByEndpoint.set(ep, resolveAuth(ep));
}

// A response counts as a success when its status is one of expectedStatus (a number, or a list of numbers; default 200)
function expectedList(ep) {
    const value = ep.expectedStatus !== undefined ? ep.expectedStatus : 200;
    return Array.isArray(value) ? value : [value];
}

// What an endpoint is called in checks, logs and the verdict: its optional "name", else "METHOD url" (no query string: it may carry secrets)
function endpointLabel(ep) {
    return ep.name || `${(ep.method || 'GET').toUpperCase()} ${String(ep.endpoint).split('?')[0]}`;
}

// Per-endpoint results, so one endpoint failing while another passes is visible (console summary, results.json, k6-verdict.txt, and the checks in the report).
// k6 only keeps per-tag metrics that a threshold names, and VUs cannot share JavaScript variables, so everything that must be summed across VUs
// has to be a k6 metric created here. Metric names are index-based (ep1_, ep2_ ...) because they must be plain identifiers.
//   epN_requests / epN_ok / epN_no_response   counts
//   epN_http_<code>                           one counter per status code in TRACKED_STATUSES (+ the endpoint's expected codes); epN_http_other for the rest
//   epN_duration                              response time (ms) of every request that got an HTTP response
//   epN_ok_duration                           response time (ms) of the requests that returned an expected status (the latency an SLA should use)
//   epN_bad_status                            trend of the unexpected statuses (min / max show which codes came back, also for codes not tracked above)
const TRACKED_STATUSES = [200, 201, 202, 204, 301, 302, 304, 400, 401, 403, 404, 405, 408, 409, 415, 422, 429, 500, 502, 503, 504];
const endpointStats = new Map();
(config.endpoints || []).forEach((ep, i) => {
    const n = i + 1;
    const expected = expectedList(ep);
    const statusCodes = Array.from(new Set(TRACKED_STATUSES.concat(expected.filter((c) => Number.isInteger(c) && c >= 100 && c <= 599))));
    const statusCounters = new Map();
    statusCodes.forEach((code) => statusCounters.set(code, new Counter(`ep${n}_http_${code}`)));
    endpointStats.set(ep, {
        label: endpointLabel(ep),
        expected: expected,
        requests: new Counter(`ep${n}_requests`),
        ok: new Counter(`ep${n}_ok`),
        noResponse: new Counter(`ep${n}_no_response`),
        badStatus: new Trend(`ep${n}_bad_status`), // only unexpected HTTP statuses; min / max show which codes came back
        statusCodes: statusCodes,
        statusCounters: statusCounters,
        otherStatus: new Counter(`ep${n}_http_other`),
        duration: new Trend(`ep${n}_duration`, true),
        okDuration: new Trend(`ep${n}_ok_duration`, true),
    });
});
const okDurationAll = new Trend('ok_duration', true); // response time of the requests that returned an expected status, all endpoints together

// Reusable Helper: Prepare request configurations
function prepareRequestSpec(ep, authStates) {
    const method = (ep.method || 'GET').toUpperCase();
    const url = ep.endpoint;
    const headers = Object.assign({}, ep.headers || { 'Content-Type': 'application/json' });
    const authRef = authByEndpoint.get(ep);
    if (authRef) {
        authRef.handler.apply(headers, authRef.authParameters, authStates ? authStates[authRef.index] : null);
    }
    // The profile decides what a success is: an expectedStatus of 404 or 409 is then not counted as a failed request (http_req_failed)
    const params = {
        headers: headers,
        tags: { name: endpointLabel(ep) }, // groups the metrics per endpoint instead of per URL
        responseCallback: http.expectedStatuses(...expectedList(ep)),
    };

    let body = null;
    if (['POST', 'PUT', 'PATCH', 'DELETE', 'QUERY'].includes(method)) {
        if (ep.payload !== undefined) {
            body = typeof ep.payload === 'object' ? JSON.stringify(ep.payload) : ep.payload;
        } else if (method !== 'DELETE' && method !== 'QUERY') {
            body = JSON.stringify({ "timestamp": new Date().toISOString() });
        }
    }

    return {
        method: method,
        url: url,
        body: body,
        params: params
    };
}

// Reusable Helper: Execute a single request
function executeSingleRequest(ep, authStates) {
    const spec = prepareRequestSpec(ep, authStates);
    if (['GET', 'HEAD'].includes(spec.method)) {
        return http.request(spec.method, spec.url, null, spec.params);
    } else {
        return http.request(spec.method, spec.url, spec.body, spec.params);
    }
}

// Reusable Helper: Validate response status
//
// Rules (README section 3):
//  - 401 / 403 that the profile did not expect: the credentials are not accepted, the whole run is meaningless -> stop at once (exit 108).
//  - No HTTP response at all for the first NO_RESPONSE_LIMIT requests of a VU: the API was never reached -> stop (exit 108).
//  - Anything else (404, 409, 400, 5xx, ...) means the API answered and the credentials work. The run CONTINUES so the report covers every endpoint;
//    handleSummary() then flags an endpoint that never succeeded (see below).
const NO_RESPONSE_LIMIT = 10;
let vuRequests = 0;
let vuResponses = 0;

// Stops the whole test. k6 exits with 108, which the pipelines treat as "the test could not run" (red build, email says FAILED).
// The reason line is what the email shows, so it only states what is known.
const stoppedEarly = new Counter('perf_stopped_early'); // lets handleSummary() know the run was aborted (it then states no verdict of its own)

function abortRun(code, text) {
    stoppedEarly.add(1);
    exec.test.abort(emitReason(code, text));
}

function checkResponse(res, ep) {
    const stats = endpointStats.get(ep);
    const ok = stats.expected.includes(res.status);
    check(res, {
        [`${stats.label} returns ${stats.expected.join(' or ')}`]: () => ok,
    });

    stats.requests.add(1);
    if (ok) {
        stats.ok.add(1);
    } else if (res.status === 0) {
        stats.noResponse.add(1);
    } else {
        stats.badStatus.add(res.status);
    }
    if (res.status !== 0) {
        // Latency only exists when the server answered; a failed connection would pollute it with the time to fail.
        (stats.statusCounters.get(res.status) || stats.otherStatus).add(1);
        stats.duration.add(res.timings.duration);
        if (ok) {
            stats.okDuration.add(res.timings.duration);
            okDurationAll.add(res.timings.duration);
        }
    }

    // Rejected credentials make the whole run meaningless (every request is turned away), and as a threshold miss it would pass for an SLA miss (exit 99).
    // A profile that deliberately expects 401/403 is left alone.
    if (!ok && (res.status === 401 || res.status === 403)) {
        abortRun('CREDENTIALS_REJECTED', `The API answered HTTP ${res.status} (${res.status === 401 ? 'not authenticated' : 'not permitted'}) for ${stats.label}, so the credentials or token were not accepted. Check that they are correct, not expired, and allowed to call this API.`);
    }

    // Nothing answered at all: wrong host, network or API down. Per VU (each VU has its own copy of this module).
    vuRequests++;
    if (res.status !== 0) {
        vuResponses++;
    } else if (vuResponses === 0 && vuRequests >= NO_RESPONSE_LIMIT) {
        abortRun('NO_RESPONSE', `The first ${vuRequests} requests of a virtual user got no HTTP response (last: ${stats.label}), so the API was never reached. Check the host name, network access and that the API is running.`);
    }
}

// ---- helpers for handleSummary ----
const round = (v, digits) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : null);

// k6 Trend values -> the numbers a report needs (milliseconds). null when the metric has no samples.
function trendOf(metric) {
    const v = metric && metric.values;
    if (!v || typeof v.avg !== 'number') {
        return null;
    }
    return { avg: round(v.avg, 2), min: round(v.min, 2), median: round(v.med, 2), p90: round(v['p(90)'], 2), p95: round(v['p(95)'], 2), p99: round(v['p(99)'], 2), max: round(v.max, 2) };
}

// Names only (never parameters): which authentication types the profile uses
function authTypesUsed() {
    const types = new Set();
    for (const t of [config.authType].concat((config.endpoints || []).map((ep) => ep.authType))) {
        if (t && t !== 'NONE') {
            types.add(t);
        }
    }
    return Array.from(types);
}

const ms = (v) => (typeof v === 'number' ? v.toFixed(0) : 'n/a');

// Runs once at the end of the test (also after an abort). It
//  - prints a console summary that lists every endpoint,
//  - writes results.json (K6_RESULTS_FILE): all numbers a custom report needs, per endpoint and overall. No headers, payloads, credentials or query strings.
//  - writes the verdict file that ci/run-k6.sh reads: when an endpoint NEVER returned its expected status although the API answered (wrong URL, 409 conflict,
//    400 bad body, 5xx ...), the run is still fully reported but must not be called a pass. An endpoint that only partly fails is left to the thresholds.
export function handleSummary(data) {
    const metrics = data.metrics || {};
    const values = (name) => (metrics[name] && metrics[name].values) || {};
    const count = (name) => values(name).count || 0;
    const lines = ['', '==== Performance test summary ===='];
    const problems = [];

    const failed = metrics.http_req_failed && metrics.http_req_failed.values;
    const duration = metrics.http_req_duration && metrics.http_req_duration.values;
    lines.push(`requests: ${count('http_reqs')}, failed (unexpected status): ${failed ? (failed.rate * 100).toFixed(2) : 'n/a'}%`);
    if (duration) {
        lines.push(`latency ms: avg ${ms(duration.avg)}, p90 ${ms(duration['p(90)'])}, p95 ${ms(duration['p(95)'])}, p99 ${ms(duration['p(99)'])}, max ${ms(duration.max)}`);
    }

    const endpointResults = [];
    lines.push('', 'Endpoints:');
    let index = 0;
    for (const ep of config.endpoints || []) {
        index++;
        const stats = endpointStats.get(ep);
        const requests = count(`ep${index}_requests`);
        const okCount = count(`ep${index}_ok`);
        const noResponse = count(`ep${index}_no_response`);
        const answered = requests - noResponse; // requests that got an HTTP response
        const bad = values(`ep${index}_bad_status`);
        const badCount = requests - okCount - noResponse; // unexpected HTTP statuses (a Trend carries no count, so it is derived)
        const hasBad = badCount > 0 && typeof bad.min === 'number';
        const expected = stats.expected.join(' or ');
        const badText = hasBad ? `HTTP ${bad.min === bad.max ? bad.min : bad.min + '-' + bad.max}` : '';
        const latencyAll = answered > 0 ? trendOf(metrics[`ep${index}_duration`]) : null;
        const latencyOk = okCount > 0 ? trendOf(metrics[`ep${index}_ok_duration`]) : null;

        const statusCodes = {};
        for (const code of stats.statusCodes) {
            const n = count(`ep${index}_http_${code}`);
            if (n > 0) {
                statusCodes[code] = n;
            }
        }
        if (count(`ep${index}_http_other`) > 0) {
            statusCodes.other = count(`ep${index}_http_other`); // a code outside the tracked list; badStatusRange below shows which
        }
        if (noResponse > 0) {
            statusCodes.noResponse = noResponse;
        }

        endpointResults.push({
            index: index,
            label: stats.label,
            method: (ep.method || 'GET').toUpperCase(),
            url: String(ep.endpoint).split('?')[0],
            expectedStatus: stats.expected,
            status: requests === 0 ? 'NOT_RUN' : okCount === 0 ? 'NO_SUCCESS' : okCount < requests ? 'PARTIAL' : 'OK',
            requests: requests,
            ok: okCount,
            failed: requests - okCount,
            noResponse: noResponse,
            successRate: requests > 0 ? round(okCount / requests, 4) : null,
            errorRate: requests > 0 ? round((requests - okCount) / requests, 4) : null,
            requestsPerSec: round(values(`ep${index}_requests`).rate, 2),
            statusCodes: statusCodes,
            badStatusRange: hasBad ? { min: bad.min, max: bad.max } : null,
            latencyOk: latencyOk,   // response time of the requests that returned an expected status: use this for SLAs
            latencyAll: latencyAll, // response time of every request that got an answer (an error page is usually faster)
        });

        let detail = '';
        if (badText) {
            detail += `, ${badText} x${badCount}`;
        }
        if (noResponse > 0) {
            detail += `, no response x${noResponse}`;
        }
        if (latencyOk) {
            detail += `, latency(ok) avg ${ms(latencyOk.avg)} p95 ${ms(latencyOk.p95)} p99 ${ms(latencyOk.p99)} ms`;
        }
        lines.push(`  ${okCount > 0 || requests === 0 ? 'OK  ' : 'FAIL'} ${stats.label}: ${requests} requests, ${okCount} returned ${expected}${detail}`);
        if (requests > 0 && okCount === 0) {
            problems.push(noResponse === requests
                ? `${stats.label} got no HTTP response in any of ${requests} requests`
                : `${stats.label} never returned the expected HTTP ${expected} in ${requests} requests (got ${badText || 'no HTTP response'})`);
        }
    }

    lines.push('', 'Thresholds:');
    const thresholdResults = [];
    for (const name of Object.keys(metrics)) {
        const thresholds = metrics[name].thresholds || {};
        for (const rule of Object.keys(thresholds)) {
            const ok = !(thresholds[rule] && thresholds[rule].ok === false);
            thresholdResults.push({ metric: name, rule: rule, ok: ok });
            lines.push(`  ${ok ? 'OK  ' : 'FAIL'} ${name}: ${rule}`);
        }
    }

    let verdict = '';
    if (count('perf_stopped_early') > 0) {
        lines.push('', 'The run was stopped early by the engine; the reason is the PERF_REASON line in the log above.');
    } else if (problems.length > 0) {
        verdict = `PERF_REASON|ENDPOINT_NO_SUCCESS|${cleanReason(`The test ran and the report is attached, but not every endpoint worked: ${problems.join('; ')}. The API answered, so the credentials were accepted. Check the URL, method, payload and expectedStatus of the endpoint(s) in the profile.`)}`;
        lines.push('', `VERDICT: ${verdict.split('|')[2]}`);
    }
    lines.push('');

    const httpReqs = values('http_reqs');
    const testDurationMs = data.state && typeof data.state.testRunDurationMs === 'number' ? data.state.testRunDurationMs : null;
    const results = {
        schema: 'perf-results/1',
        generatedAt: new Date().toISOString(),
        profile: {
            apiName: config.apiName || null,
            artifactVersion: config.artifact_version || null,
            authTypes: authTypesUsed(),
            stages: config.stages || null,
            thresholds: options.thresholds,
        },
        run: {
            durationSec: round(testDurationMs !== null ? testDurationMs / 1000 : (httpReqs.rate ? httpReqs.count / httpReqs.rate : null), 2),
            stoppedEarly: count('perf_stopped_early') > 0,
            vusMax: values('vus_max').max !== undefined ? values('vus_max').max : null,
            requests: count('http_reqs'),
            requestsPerSec: round(httpReqs.rate, 2),
            iterations: count('iterations'),
            iterationsPerSec: round(values('iterations').rate, 2),
            failedRate: failed ? round(failed.rate, 4) : null,
            checksPassRate: metrics.checks ? round(values('checks').rate, 4) : null,
            dataReceivedBytes: count('data_received'),
            dataSentBytes: count('data_sent'),
        },
        latency: {
            overall: trendOf(metrics.http_req_duration),    // every response, including fast error responses (this is what the k6 thresholds see)
            overallOk: endpointResults.some((e) => e.ok > 0) ? trendOf(metrics.ok_duration) : null, // only requests that returned an expected status
            iteration: trendOf(metrics.iteration_duration),
            // where the time goes: waiting = server think time (TTFB); blocked / connecting / tlsHandshaking mostly occur on the first request of each VU
            breakdown: {
                blocked: trendOf(metrics.http_req_blocked),
                connecting: trendOf(metrics.http_req_connecting),
                tlsHandshaking: trendOf(metrics.http_req_tls_handshaking),
                sending: trendOf(metrics.http_req_sending),
                waiting: trendOf(metrics.http_req_waiting),
                receiving: trendOf(metrics.http_req_receiving),
            },
        },
        thresholds: thresholdResults,
        endpoints: endpointResults,
        engineVerdict: { problems: problems }, // the build result also depends on k6's exit code; the CI scripts combine both
    };

    const out = { stdout: lines.join('\n') };
    out[__ENV.K6_VERDICT_FILE || '/apps/k6-verdict.txt'] = verdict; // empty file = every endpoint succeeded at least once
    out[__ENV.K6_RESULTS_FILE || '/apps/results.json'] = JSON.stringify(results, null, 2);
    return out;
}

// Pre-process endpoints into execution flow steps (consecutive matching batchGroups run in parallel)
const executionFlow = [];
const endpoints = config.endpoints || [];
let currentBatch = [];
let currentBatchGroup = null;

for (const ep of endpoints) {
    if (ep.batchGroup) {
        if (currentBatchGroup === ep.batchGroup) {
            currentBatch.push(ep);
        } else {
            if (currentBatch.length > 0) {
                executionFlow.push({ type: 'batch', items: currentBatch });
            }
            currentBatch = [ep];
            currentBatchGroup = ep.batchGroup;
        }
    } else {
        if (currentBatch.length > 0) {
            executionFlow.push({ type: 'batch', items: currentBatch });
            currentBatch = [];
            currentBatchGroup = null;
        }
        executionFlow.push({ type: 'single', item: ep });
    }
}
if (currentBatch.length > 0) {
    executionFlow.push({ type: 'batch', items: currentBatch });
}

// Runs once before the load starts: validate every credential set, then let its auth module do its one-time work (e.g. fetch a token)
export function setup() {
    const authStates = authSets.map((set) => {
        set.handler.validate(set.authParameters);
        return set.handler.setup(set.authParameters);
    });
    return { authStates: authStates };
}

export default function (data) {
    const authStates = data ? data.authStates : null;
    for (const step of executionFlow) {
        if (step.type === 'single') {
            const ep = step.item;
            const res = executeSingleRequest(ep, authStates);
            checkResponse(res, ep);

            // Pacing for single request
            const sleepDuration = ep.sleepDuration !== undefined ? ep.sleepDuration : 1;
            if (sleepDuration > 0) {
                sleep(sleepDuration);
            }
        } else if (step.type === 'batch') {
            const batchSpecs = step.items.map((ep) => prepareRequestSpec(ep, authStates));
            
            // Execute batch parallelly
            const responses = http.batch(batchSpecs);

            // Validate all responses in the batch
            for (let i = 0; i < responses.length; i++) {
                checkResponse(responses[i], step.items[i]);
            }

            // Pacing for the batch (uses the maximum sleepDuration defined among the batch items)
            let maxSleep = 0;
            for (const ep of step.items) {
                const sd = ep.sleepDuration !== undefined ? ep.sleepDuration : 1;
                if (sd > maxSleep) {
                    maxSleep = sd;
                }
            }
            if (maxSleep > 0) {
                sleep(maxSleep);
            }
        }
    }
}

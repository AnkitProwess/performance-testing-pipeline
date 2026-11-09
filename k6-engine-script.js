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

// Per-endpoint results, so one endpoint failing while another passes is visible (summary below, k6-verdict.txt, and the checks in the report).
// Metric names are index-based because they must be plain identifiers.
const endpointStats = new Map();
(config.endpoints || []).forEach((ep, i) => {
    const n = i + 1;
    endpointStats.set(ep, {
        label: endpointLabel(ep),
        expected: expectedList(ep),
        requests: new Counter(`ep${n}_requests`),
        ok: new Counter(`ep${n}_ok`),
        noResponse: new Counter(`ep${n}_no_response`),
        badStatus: new Trend(`ep${n}_bad_status`), // only unexpected HTTP statuses; min / max show which codes came back
    });
});

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

// Runs once at the end of the test (also after an abort). Replaces k6's default console summary with one that lists every endpoint, and writes
// the verdict file that ci/run-k6.sh reads: when an endpoint NEVER returned its expected status although the API answered (wrong URL, 409 conflict,
// 400 bad body, 5xx ...), the run is still fully reported but must not be called a pass. An endpoint that only partly fails is left to the thresholds.
export function handleSummary(data) {
    const count = (name) => (data.metrics[name] && data.metrics[name].values.count) || 0;
    const lines = ['', '==== Performance test summary ===='];
    const problems = [];

    const failed = data.metrics.http_req_failed && data.metrics.http_req_failed.values;
    const duration = data.metrics.http_req_duration && data.metrics.http_req_duration.values;
    lines.push(`requests: ${count('http_reqs')}, failed (unexpected status): ${failed ? (failed.rate * 100).toFixed(2) : 'n/a'}%`);
    if (duration) {
        const ms = (v) => (typeof v === 'number' ? v.toFixed(0) : 'n/a');
        lines.push(`latency ms: avg ${ms(duration.avg)}, p90 ${ms(duration['p(90)'])}, p95 ${ms(duration['p(95)'])}, p99 ${ms(duration['p(99)'])}, max ${ms(duration.max)}`);
    }

    lines.push('', 'Endpoints:');
    let index = 0;
    for (const ep of config.endpoints || []) {
        index++;
        const stats = endpointStats.get(ep);
        const requests = count(`ep${index}_requests`);
        const okCount = count(`ep${index}_ok`);
        const noResponse = count(`ep${index}_no_response`);
        const bad = data.metrics[`ep${index}_bad_status`] && data.metrics[`ep${index}_bad_status`].values;
        const expected = stats.expected.join(' or ');
        const badText = bad && bad.count > 0 ? `HTTP ${bad.min === bad.max ? bad.min : bad.min + '-' + bad.max}` : '';
        let detail = '';
        if (badText) {
            detail += `, ${badText} x${bad.count}`;
        }
        if (noResponse > 0) {
            detail += `, no response x${noResponse}`;
        }
        lines.push(`  ${okCount > 0 || requests === 0 ? 'OK  ' : 'FAIL'} ${stats.label}: ${requests} requests, ${okCount} returned ${expected}${detail}`);
        if (requests > 0 && okCount === 0) {
            problems.push(noResponse === requests
                ? `${stats.label} got no HTTP response in any of ${requests} requests`
                : `${stats.label} never returned the expected HTTP ${expected} in ${requests} requests (got ${badText || 'no HTTP response'})`);
        }
    }

    lines.push('', 'Thresholds:');
    for (const name of Object.keys(data.metrics)) {
        const thresholds = data.metrics[name].thresholds || {};
        for (const rule of Object.keys(thresholds)) {
            lines.push(`  ${thresholds[rule] && thresholds[rule].ok === false ? 'FAIL' : 'OK  '} ${name}: ${rule}`);
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

    const out = { stdout: lines.join('\n') };
    out[__ENV.K6_VERDICT_FILE || '/apps/k6-verdict.txt'] = verdict; // empty file = every endpoint succeeded at least once
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

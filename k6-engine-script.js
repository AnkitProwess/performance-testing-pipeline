import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { getAuthHandler } from './auth/index.js';
import { emitReason } from './auth/common.js';

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

// Reusable Helper: Prepare request configurations
function prepareRequestSpec(ep, authStates) {
    const method = (ep.method || 'GET').toUpperCase();
    const url = ep.endpoint;
    const headers = Object.assign({}, ep.headers || { 'Content-Type': 'application/json' });
    const authRef = authByEndpoint.get(ep);
    if (authRef) {
        authRef.handler.apply(headers, authRef.authParameters, authStates ? authStates[authRef.index] : null);
    }
    const params = { headers: headers };

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
const NO_SUCCESS_LIMIT = 10; // requests a VU may make without a single expected response before the run is judged invalid
let vuRequests = 0;
let vuSuccesses = 0;

// Stops the whole test. k6 exits with 108, which the pipelines treat as "the test could not run" (red build, email says FAILED).
// The reason line is what the email shows, so it only states what is known.
function abortRun(code, text) {
    exec.test.abort(emitReason(code, text));
}

function describeStatus(status) {
    if (status === 0) return 'no HTTP response (the connection failed)';
    if (status === 404) return 'HTTP 404 (not found)';
    if (status >= 500) return `HTTP ${status} (server error)`;
    return `HTTP ${status}`;
}

function nextStepHint(status) {
    if (status === 0) return 'Check the host name, network access and that the API is running.';
    if (status === 404) return 'Check the endpoint URL / path and that the API is deployed.';
    if (status >= 500) return 'The API itself is failing; check its logs.';
    return 'Check the endpoint URL, the request method / payload and expectedStatus in the profile.';
}

function checkResponse(res, ep) {
    const expectedStatus = ep.expectedStatus || 200;
    check(res, {
        [`status is ${expectedStatus}`]: (r) => r.status === expectedStatus,
    });

    const where = `${(ep.method || 'GET').toUpperCase()} ${String(ep.endpoint).split('?')[0]}`; // no query string: it may carry secrets

    // Rejected credentials make the whole run meaningless (every request is turned away), and as a threshold miss it would pass for an SLA miss (exit 99).
    // A profile that deliberately expects 401/403 is left alone.
    if ((res.status === 401 || res.status === 403) && res.status !== expectedStatus) {
        abortRun('CREDENTIALS_REJECTED', `The API answered HTTP ${res.status} (${res.status === 401 ? 'not authenticated' : 'not permitted'}) for ${where}, so the credentials or token were not accepted. Check that they are correct, not expired, and allowed to call this API.`);
    }

    // A run where nothing ever succeeds is not an SLA miss either: it would only cross the failed-request threshold (exit 99) and look like a pass with a warning.
    // Counters are per VU (each VU has its own copy of this module). Failures after a first success are NOT aborted: they count towards the thresholds.
    vuRequests++;
    if (res.status === expectedStatus) {
        vuSuccesses++;
    } else if (vuSuccesses === 0 && vuRequests >= NO_SUCCESS_LIMIT) {
        abortRun('NO_SUCCESS', `None of the first ${vuRequests} requests of a virtual user returned the expected HTTP ${expectedStatus}; the last one got ${describeStatus(res.status)} from ${where}. ${nextStepHint(res.status)}`);
    }
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

import http from 'k6/http';
import { check, sleep } from 'k6';
import { getAuthHandler } from './auth/index.js';

// Read configuration
const loadProfilePath = __ENV.LOAD_PROFILE_PATH || './load-profile.json';
// Replace {{VAR_NAME}} tokens in the profile with environment values (e.g. secrets from the Azure variable group)
const rawProfile = open(loadProfilePath).replace(/\{\{(\w+)\}\}/g, (match, name) =>
    __ENV[name] !== undefined ? __ENV[name] : match
);
const config = JSON.parse(rawProfile);

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
    const handler = getAuthHandler(authType); // throws on an unknown authType, before any load starts
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
function checkResponse(res, ep) {
    const expectedStatus = ep.expectedStatus || 200;
    check(res, {
        [`status is ${expectedStatus}`]: (r) => r.status === expectedStatus,
    });
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

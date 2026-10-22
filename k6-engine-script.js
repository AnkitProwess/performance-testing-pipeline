import http from 'k6/http';
import { check, sleep } from 'k6';

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

// Reusable Helper: Prepare request configurations
function prepareRequestSpec(ep) {
    const method = (ep.method || 'GET').toUpperCase();
    const url = ep.endpoint;
    const headers = ep.headers || { 'Content-Type': 'application/json' };
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
function executeSingleRequest(ep) {
    const spec = prepareRequestSpec(ep);
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

export default function () {
    for (const step of executionFlow) {
        if (step.type === 'single') {
            const ep = step.item;
            const res = executeSingleRequest(ep);
            checkResponse(res, ep);

            // Pacing for single request
            const sleepDuration = ep.sleepDuration !== undefined ? ep.sleepDuration : 1;
            if (sleepDuration > 0) {
                sleep(sleepDuration);
            }
        } else if (step.type === 'batch') {
            const batchSpecs = step.items.map(prepareRequestSpec);
            
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

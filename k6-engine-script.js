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

// Reusable Helper: Resolve the OAuth settings for an endpoint.
// An endpoint's own authType/auth overrides the root-level default; authType "NONE" opts the endpoint out.
function authTypeFor(ep) {
    return ep.authType !== undefined ? ep.authType : config.authType;
}

function authFor(ep) {
    if (authTypeFor(ep) !== 'OAUTH2_CLIENT_CREDENTIALS') {
        return null;
    }
    return ep.auth || config.auth || {};
}

// One token is fetched per distinct credential set, however many endpoints share it
function authKey(auth) {
    return JSON.stringify([auth.tokenUrl, auth.clientId, auth.scope]);
}

// Reusable Helper: Prepare request configurations
function prepareRequestSpec(ep, tokens) {
    const method = (ep.method || 'GET').toUpperCase();
    const url = ep.endpoint;
    const headers = Object.assign({}, ep.headers || { 'Content-Type': 'application/json' });
    const auth = authFor(ep);
    const token = auth && tokens ? tokens[authKey(auth)] : null;
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    // Client ID Enforcement: auth.clientId / auth.clientSecret are sent as the client_id / client_secret headers
    if (authTypeFor(ep) === 'CLIENT_ID_ENFORCEMENT') {
        const idAuth = ep.auth || config.auth || {};
        headers['client_id'] = idAuth.clientId;
        headers['client_secret'] = idAuth.clientSecret;
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
function executeSingleRequest(ep, tokens) {
    const spec = prepareRequestSpec(ep, tokens);
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

// Fail fast when an auth value was never supplied: missing, an unresolved {{TOKEN}}, or an undefined Azure variable (literal "$(name)")
function requireAuthValues(auth, keys) {
    for (const key of keys) {
        if (!auth[key] || /^\{\{.*\}\}$/.test(auth[key]) || auth[key].startsWith('$(')) {
            throw new Error(`Auth setup failed: auth.${key} is missing or unresolved. Check the variable group and the profile.`);
        }
    }
}

// Fetch an OAuth 2.0 access token (client credentials grant) for one auth block
function fetchToken(auth) {
    requireAuthValues(auth, ['tokenUrl', 'clientId', 'clientSecret', 'scope']);

    const res = http.post(auth.tokenUrl, {
        grant_type: 'client_credentials',
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
        scope: auth.scope,
    }, { tags: { name: 'oauth_token_request' } });

    if (res.status !== 200) {
        // Never print the request (it holds the secret); the IdP error body is safe
        throw new Error(`OAuth token request failed: HTTP ${res.status} ${res.body}`);
    }

    const token = res.json('access_token');
    if (!token) {
        throw new Error('OAuth token response did not contain an access_token.');
    }
    console.log('OAuth access token obtained.');
    return token;
}

// Runs once before the load starts: fetch the tokens needed by the endpoints that use OAuth
export function setup() {
    const tokens = {};
    for (const ep of endpoints) {
        if (authTypeFor(ep) === 'CLIENT_ID_ENFORCEMENT') {
            requireAuthValues(ep.auth || config.auth || {}, ['clientId', 'clientSecret']);
        }
        const auth = authFor(ep);
        if (auth && tokens[authKey(auth)] === undefined) {
            tokens[authKey(auth)] = fetchToken(auth);
        }
    }
    return { tokens: tokens };
}

export default function (data) {
    const tokens = data ? data.tokens : null;
    for (const step of executionFlow) {
        if (step.type === 'single') {
            const ep = step.item;
            const res = executeSingleRequest(ep, tokens);
            checkResponse(res, ep);

            // Pacing for single request
            const sleepDuration = ep.sleepDuration !== undefined ? ep.sleepDuration : 1;
            if (sleepDuration > 0) {
                sleep(sleepDuration);
            }
        } else if (step.type === 'batch') {
            const batchSpecs = step.items.map((ep) => prepareRequestSpec(ep, tokens));
            
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

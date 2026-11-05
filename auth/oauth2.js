// authType "OAUTH2_CLIENT_CREDENTIALS": fetch a token once in setup(), send it as "Authorization: Bearer <token>"
import http from 'k6/http';
import { requireAuthValues, emitReason } from './common.js';

export default {
    validate(authParameters) {
        requireAuthValues(authParameters, ['tokenUrl', 'clientId', 'clientSecret', 'scope']);
        // grantType is optional (defaults to client_credentials); authType is the single selector, so a different value is a profile mistake
        if (authParameters.grantType !== undefined && authParameters.grantType !== 'client_credentials') {
            throw new Error(`Auth setup failed: authParameters.grantType "${authParameters.grantType}" does not match authType OAUTH2_CLIENT_CREDENTIALS (expected client_credentials).`);
        }
    },

    // Returns the access token; it is passed back to apply() for every request
    setup(authParameters) {
        const res = http.post(authParameters.tokenUrl, {
            grant_type: 'client_credentials', // the OAuth wire name; the profile key is grantType
            client_id: authParameters.clientId,
            client_secret: authParameters.clientSecret,
            scope: authParameters.scope,
        }, { tags: { name: 'oauth_token_request' } });

        if (res.status !== 200) {
            // Only the standard OAuth "error" code (e.g. invalid_client) goes into the reason, never the body or the request
            let idpError = '';
            try { idpError = String(res.json('error') || '').replace(/[^A-Za-z0-9_.-]/g, ''); } catch (e) { /* no JSON body */ }
            emitReason('TOKEN_REQUEST_FAILED', res.status === 0
                ? 'The OAuth token URL could not be reached (no HTTP response). Check the token URL and that the agent has network access to it.'
                : `The identity provider answered the OAuth token request with HTTP ${res.status}${idpError ? ` (error: ${idpError})` : ''}. Check the token URL, client ID, client secret (and that it has not expired) and the scope.`);
            // Never print the request (it holds the secret); the IdP error body is safe
            throw new Error(`OAuth token request failed: HTTP ${res.status} ${res.body}`);
        }

        const token = res.json('access_token');
        if (!token) {
            emitReason('TOKEN_RESPONSE_INVALID', 'The OAuth token request returned HTTP 200 but the response contained no access_token. Check the token URL and the scope.');
            throw new Error('OAuth token response did not contain an access_token.');
        }
        console.log('OAuth access token obtained.');
        return token;
    },

    apply(headers, authParameters, token) {
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
    },
};

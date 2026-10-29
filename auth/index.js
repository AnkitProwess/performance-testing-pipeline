// Auth registry: maps the profile's authType to its module.
//
// Every module exports the same three functions:
//   validate(authParameters)               (the profile's authParameters block) fail fast when a value is missing or unresolved
//   setup(authParameters)                  one-time work before the load starts (e.g. fetch a token); returns state for apply()
//   apply(headers, authParameters, state)  add the auth headers to a request
//
// To support a new auth type: add a file in this folder with those three functions, then add one line below.
import oauth2 from './oauth2.js';
import clientId from './clientId.js';
import basic from './basic.js';

const handlers = {
    OAUTH2_CLIENT_CREDENTIALS: oauth2,
    CLIENT_ID_ENFORCEMENT: clientId,
    BASIC: basic,
};

export function getAuthHandler(authType) {
    const handler = handlers[authType];
    if (!handler) {
        throw new Error(`Unknown authType "${authType}". Supported: ${Object.keys(handlers).join(', ')}, NONE.`);
    }
    return handler;
}

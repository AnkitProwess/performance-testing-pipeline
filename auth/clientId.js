// authType "CLIENT_ID_ENFORCEMENT": authParameters.clientId / authParameters.clientSecret are sent as the client_id / client_secret headers
import { requireAuthValues } from './common.js';

export default {
    validate(authParameters) {
        requireAuthValues(authParameters, ['clientId', 'clientSecret']);
    },

    // Nothing to fetch up front
    setup(authParameters) {
        return null;
    },

    apply(headers, authParameters, state) {
        headers['client_id'] = authParameters.clientId;
        headers['client_secret'] = authParameters.clientSecret;
    },
};

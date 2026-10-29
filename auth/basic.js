// authType "BASIC": authParameters.username / authParameters.password are sent as "Authorization: Basic base64(username:password)"
import encoding from 'k6/encoding';
import { requireAuthValues } from './common.js';

export default {
    validate(authParameters) {
        requireAuthValues(authParameters, ['username', 'password']);
    },

    // Nothing to fetch up front
    setup(authParameters) {
        return null;
    },

    apply(headers, authParameters, state) {
        headers['Authorization'] = `Basic ${encoding.b64encode(`${authParameters.username}:${authParameters.password}`)}`;
    },
};

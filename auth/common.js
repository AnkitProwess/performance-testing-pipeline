// Shared helpers for the auth modules and the engine

// Records WHY a run is about to stop, in one machine-readable log line: PERF_REASON|<CODE>|<text>.
// ci/run-k6.sh picks the first such line out of the k6 output and ci/status.sh puts it in the email, so the text must only state
// facts the engine actually knows (a status code, a missing key name, the IdP's error code) and never contain a secret, a token or a request body.
export function cleanReason(text) {
    return String(text).replace(/[|"\\\r\n]+/g, ' ').slice(0, 400);
}

export function emitReason(code, text) {
    const clean = cleanReason(text);
    console.error(`PERF_REASON|${code}|${clean}`);
    return clean;
}

// Fail fast when an auth value was never supplied: missing, an unresolved {{TOKEN}}, or an undefined Azure DevOps variable (literal "$(name)")
export function requireAuthValues(authParameters, keys) {
    for (const key of keys) {
        if (!authParameters[key] || /^\{\{.*\}\}$/.test(authParameters[key]) || authParameters[key].startsWith('$(')) {
            emitReason('MISSING_VALUE', `The value authParameters.${key} was not supplied: it is missing from the profile, or the variable group / Jenkins credential that should fill it does not exist or is empty.`);
            throw new Error(`Auth setup failed: authParameters.${key} is missing or unresolved. Check the pipeline credentials (Jenkins credentials / variable group) and the profile.`);
        }
    }
}

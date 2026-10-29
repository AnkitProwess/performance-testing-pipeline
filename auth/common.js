// Shared helpers for the auth modules

// Fail fast when an auth value was never supplied: missing, an unresolved {{TOKEN}}, or an undefined Azure variable (literal "$(name)")
export function requireAuthValues(authParameters, keys) {
    for (const key of keys) {
        if (!authParameters[key] || /^\{\{.*\}\}$/.test(authParameters[key]) || authParameters[key].startsWith('$(')) {
            throw new Error(`Auth setup failed: authParameters.${key} is missing or unresolved. Check the variable group and the profile.`);
        }
    }
}

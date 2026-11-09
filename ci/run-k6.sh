#!/usr/bin/env bash
# Runs the k6 engine in Docker. Shared by the Azure DevOps and Jenkins pipelines, so the container
# command and the list of credential variables exist in exactly one place.
#
# Usage:  bash ci/run-k6.sh <api-repo-dir> <profile-path-inside-it> [debug]
#   api-repo-dir   folder that holds the profile AND the copied k6-engine-script.js + auth/ (mounted as /apps)
#   profile path   e.g. AI_innovation_poc1/load-profile3.json
#   debug          "true" adds k6 --http-debug=full (writes headers, incl. credentials, to the log)
# Optional env: K6_IMAGE (default grafana/k6); K6_DASHBOARD_PERIOD (time between points in the dashboard charts, default 5s; k6's own default is 10s)
# Also writes <api-repo-dir>/results.json (engine's handleSummary): per-endpoint and overall metrics, the input for the custom report.
#
# Credentials are read from the environment (set by the CI tool) and passed to the container by NAME only,
# never as values on the command line. A name that is not set on the host is simply not passed on.
# Writes <api-repo-dir>/k6-reason.txt when the engine stated why it stopped (empty otherwise).
# Exit code = k6's exit code: 0 passed, 99 thresholds crossed, anything else = the test could not run.
# One remap: 0 / 99 become 108 when an endpoint never returned its expected status (the report is still produced).

API_DIR="${1:?api-repo-dir missing}"
PROFILE_REL="${2:?profile path missing}"
DEBUG="${3:-false}"
K6_IMAGE="${K6_IMAGE:-grafana/k6}"

# The environment contract between the CI tools and the engine. A new auth type that needs a new variable is added here
# (and mapped to its secret in k6-pipeline-job-template.yml and the Jenkinsfile).
PASSTHROUGH=(
  CLIENT_ID CLIENT_SECRET
  OAUTH_TOKEN_URL OAUTH_CLIENT_ID OAUTH_CLIENT_SECRET OAUTH_SCOPE
  BASIC_USERNAME BASIC_PASSWORD
)

ENV_ARGS=()
for name in "${PASSTHROUGH[@]}"; do
  ENV_ARGS+=(-e "$name")
done

K6_ARGS=()
if [ "$DEBUG" = "true" ]; then
  K6_ARGS+=(--http-debug=full)
  echo "HTTP Debugging is enabled."
fi

docker pull -q "$K6_IMAGE" > /dev/null || echo "Could not pull $K6_IMAGE, using the local copy if present."

# The engine logs one line "PERF_REASON|<CODE>|<text>" just before it stops a run (see auth/common.js, emitReason). The output is copied to a
# temporary file (outside the workspace, deleted below) so the FIRST such line can be kept in k6-reason.txt for ci/status.sh and the email.
REASON_FILE="$API_DIR/k6-reason.txt"
VERDICT_FILE="$API_DIR/k6-verdict.txt"   # written by the engine's handleSummary(): empty = every endpoint succeeded at least once
RESULTS_FILE="$API_DIR/results.json"     # written by the engine's handleSummary(): per-endpoint and overall numbers for the custom report (kept as a build artifact)
rm -f "$REASON_FILE" "$VERDICT_FILE" "$RESULTS_FILE"
K6_LOG="$(mktemp)"

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$API_DIR:/apps" \
  -e K6_WEB_DASHBOARD=true \
  -e K6_WEB_DASHBOARD_EXPORT=/apps/report.html \
  -e K6_WEB_DASHBOARD_PERIOD="${K6_DASHBOARD_PERIOD:-5s}" \
  -e LOAD_PROFILE_PATH="/apps/$PROFILE_REL"   -e K6_VERDICT_FILE=/apps/k6-verdict.txt   -e K6_RESULTS_FILE=/apps/results.json \
  "${ENV_ARGS[@]}" \
  "$K6_IMAGE" run "${K6_ARGS[@]}" /apps/k6-engine-script.js 2>&1 | tee "$K6_LOG"
K6_EXIT=${PIPESTATUS[0]}

grep -o 'PERF_REASON|[A-Z_]*|[^"]*' "$K6_LOG" | head -n 1 > "$REASON_FILE"
rm -f "$K6_LOG"

# The run finished and the report exists, but an endpoint NEVER returned its expected status although the API answered (wrong URL, 409, 400, 5xx ...).
# That is not a pass and not an SLA miss: report it as a failed run (108) with the engine's reason, and keep the report for the email.
# Only 0 / 99 are remapped; a run that stopped for another reason keeps its own code and reason.
if { [ "$K6_EXIT" = "0" ] || [ "$K6_EXIT" = "99" ]; } && [ -s "$VERDICT_FILE" ]; then
  head -n 1 "$VERDICT_FILE" | grep -o 'PERF_REASON|[A-Z_]*|.*' > "$REASON_FILE"
  echo "An endpoint never succeeded: k6 exit code $K6_EXIT is reported as 108 (report kept)."
  K6_EXIT=108
fi
rm -f "$VERDICT_FILE"

echo "k6 exit code: $K6_EXIT (0 = passed, 99 = SLA thresholds crossed, other = test could not run)"
exit $K6_EXIT

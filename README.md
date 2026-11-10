# API Performance Testing Pipeline (k6)

One tooling repo, two CI front ends. A user runs a pipeline **manually**, says where a load-profile JSON lives, and the pipeline:

1. clones the API repo that holds the profile,
2. runs the profile with [k6](https://k6.io) in Docker,
3. archives the performance report (`report.html`),
4. emails the report with a clear result (`PASSED` or `FAILED`, plus a message when the SLA was missed).

Use **Azure DevOps** or **Jenkins**, whichever your team has. Both run the same engine, the same auth modules, the same email script and the same result rules.

## 1. Repository layout

| Path | Used by | Purpose |
|---|---|---|
| `azure-pipelines.yml` | Azure DevOps | The pipeline you create in ADO (manual, `trigger: none`). Holds the run parameters. |
| `k6-pipeline-job-template.yml` | Azure DevOps | The job: clone, run k6, archive, email, decide the build result. |
| `Jenkinsfile` | Jenkins | The pipeline you create in Jenkins (**Pipeline script from SCM**). Same steps as above. |
| `k6-engine-script.js` | both | Generic k6 runner. Reads the profile JSON, resolves `{{VAR}}` tokens from environment variables. |
| `auth/` | both | Pluggable authentication: OAuth 2.0 client credentials, client ID enforcement, Basic. |
| `ci/run-k6.sh` | both | The one place that holds the `docker run` command and the list of credential variables passed to k6. |
| `ci/status.sh` | both | The one rule that turns a k6 exit code into `PASSED` / `FAILED` and the one-line message in the email. |
| `send-email.py` | both | SMTP sender (report attached, result label in the subject). |
| `templates/` | API teams | Starter files: `Jenkinsfile`, `azure-pipelines.yml`, example profiles. |
| `run-local.sh`, `run-local.ps1`, `local-run/` | developers | Run a profile on your own machine (not part of the CI flow). |

**The rule that keeps both CI tools working:** the engine and the scripts under `ci/` know nothing about Azure DevOps or Jenkins. Each CI tool only maps its own secret store onto the environment variables listed in section 4. Change shared files once and both tools get the change.

## 2. How a run works

```
Run with parameters
  -> checkout this tooling repo
  -> clone the API repo (apiRepoUrl)
  -> copy k6-engine-script.js + auth/ next to the profile
  -> ci/run-k6.sh : grafana/k6 in Docker -> k6-dashboard.html + results.json (internal inputs, not published), exit code
  -> report/build_report.py : results.json + the time series in k6-dashboard.html -> report.html, see "Custom report" below
  -> archive report.html (Azure: artifact "StressTestReport", Jenkins: build artifact). It is the only output, and the only email attachment
  -> ci/status.sh + send-email.py : email the report
  -> final check: decide the build result from the k6 exit code
```

Run parameters (same names in both tools):

| Parameter | Meaning |
|---|---|
| `apiRepoUrl` | Git URL of the repo that holds the profile (default: `https://github.com/AnkitProwess/sample-api.git`). **The API repo must be public** so the pipeline can clone it without credentials (see the note below the table) |
| `apiName` | Folder in the API repo, case-sensitive (empty = repo root). **Not** the `apiName` label inside the JSON. |
| `profileName` | JSON file name inside that folder, e.g. `load-profile3.json` |
| `reportRecipient` | Who receives the email, comma or semicolon separated (default: `iankit7667@gmail.com` and `ankit.kumar@prowesssoft.com`) |
| `reportCc` | Optional Cc addresses, comma or semicolon separated. No Cc by default: Jenkins leaves it empty, Azure DevOps uses `none` (an empty default would make Azure show the field as required). An address already in `reportRecipient` is not repeated. |
| `debug` | `true` adds `k6 --http-debug=full`. It writes request headers, **including credentials and tokens**, to the log. Use only when needed. |
| Jenkins only: `apiRepoBranch`, `apiRepoCredentialsId` | Branch to clone (default `main`); credentials ID for a private API repo |

**The API repo to be tested must be public.** The pipeline clones it anonymously, so a public repo is the only setup that works out of the box. Each team keeps its own API repo (with its load profiles) wherever it likes and passes that URL as `apiRepoUrl`; the sample API used for testing this tooling is likewise a separate repo, not part of this one. A local `sample-api/` folder next to this repo is only a reference copy and is git-ignored. Never put real secrets in a public repo: profiles reference credentials through `{{NAME}}` tokens that the pipeline fills from its own secret store (section 4). Private API repos need extra credential setup (sections 5 and 6).

## 3. Results: what the build and the email say

| k6 exit | Meaning | Build | Email |
|---|---|---|---|
| `0` | All thresholds met | green | `[PASSED]` |
| `99` | The test ran, but an SLA threshold (latency / error rate) was crossed | **green with a warning** (Azure: "succeeded with issues"; Jenkins: yellow stage, build stays SUCCESS) | `[PASSED]` (green) with the message **"SLA MISSED: ..."** below it |
| `108` | The engine **stopped the run**, or the run finished but **an endpoint never succeeded** (see the reasons below) | **red** | `[FAILED]` + the exact reason (report attached when one exists) |
| `107` | The test could not start: setup or script error (see the reasons below) | **red** | `[FAILED]` + the exact reason |
| anything else | The test could not run (Docker error, killed process, ...) | **red** | `[FAILED]` + what the exit code proves |

Notes:

- `FAILED` is reserved for "the test could not run". An SLA miss is shown as `PASSED` (the test itself worked) with an "SLA MISSED" message under the result, so read that line, not just the subject.
- **Wrong credentials fail the build, per endpoint.** Before the load starts, the engine runs a **credential probe** (profile field `probe`, section 7). By default (`auto`) it groups the endpoints by credential set and sends ONE request to each read-only endpoint (GET / HEAD / OPTIONS, or an endpoint flagged `"readOnly": true`). Write endpoints (POST / PUT / PATCH / DELETE) are **not** probed while the credentials work, so the probe never creates, changes or deletes anything one extra time. If a read-only endpoint answers 401, the write endpoints of that credential set are probed too: the credentials are bad, so those requests are turned away before they change anything, and every endpoint still gets its own result. A credential set with no read-only endpoint gets one probe, on its first endpoint. An endpoint that answers 401 or 403 (and whose profile did not set `expectedStatus` to that code) is marked as rejected and is never called again, so a bad credential costs one request per endpoint and cannot lock an account; the other endpoints are load tested normally, the report is produced and shows the rejected endpoint as "Credentials rejected", and the build still FAILS (exit 108, reason `CREDENTIALS_REJECTED`). Only when EVERY endpoint is rejected does the run stop at once, before any load. The same applies when a token expires mid-run (that endpoint is skipped from then on) and when an OAuth token cannot be fetched (only the endpoints that use that token are skipped). Previously one 401 anywhere stopped the whole test, so the other endpoints were never exercised. One case is found by the load instead of the probe: a write endpoint that answers 403 (no permission) while the read endpoints of the same credentials work. Each virtual user then sends it once before skipping it, so its request count is bounded by the peak number of VUs; the result is the same (rejected, build FAILS). The probe requests of read-only endpoints are real requests and appear in the report's numbers.
- **Multi-endpoint profiles: the run always completes once the API answers.** 404, 409, 400, 5xx on one endpoint never stop the test, so every endpoint is exercised and the report is generated. Only two things stop a run early (no useful report): rejected credentials for EVERY endpoint, and an API that never answers at all (10 requests in a row without any HTTP response).
- **An endpoint that never succeeds fails the build, but with the report.** At the end of the run the engine checks every endpoint. If one had requests but **zero** responses with its `expectedStatus` (wrong URL, 409 on every PUT, 400 for a bad body, ...), the result is `[FAILED]` (exit 108 via `ci/run-k6.sh`) and the report is attached. An endpoint that fails only *some* of the time is an SLA matter: the thresholds decide (99 = `PASSED` + "SLA MISSED"). If a status other than 200 is the correct answer for an endpoint, set `expectedStatus` to it (a number or a list, e.g. `[200, 409]`); it is then neither a failed request nor a failure of the endpoint.
- The k6 log ends with a per-endpoint table (requests, how many returned the expected status, which HTTP codes came back instead) and the threshold results. The report's *checks* are named per endpoint (`PUT <url> returns 200`).
- Each email shows the label and a one-line reason (next section). If the test never got as far as generating load, there is no report attached and the email says so.
- Rules live in `ci/status.sh` and `ci/run-k6.sh`. Changing them changes both tools.

### Why a run failed: how the reason is chosen

The same exit code can have several causes (108 covers both rejected credentials and "nothing ever succeeded"; 107 covers any setup error), so the reason is **not guessed from the exit code**. The engine states it itself, in one log line `PERF_REASON|<CODE>|<text>` written just before it stops. `ci/run-k6.sh` keeps the first such line in `k6-reason.txt` and `ci/status.sh` puts the text into the email and the build log. The text only contains facts the engine knows (a status code, a key name, the identity provider's standard error code). It never contains a secret, a token, a response body, a query string or a host name taken from an error message.

| Reason code | Email says (summary) |
|---|---|
| `CREDENTIALS_REJECTED` | The API answered HTTP 401 (not authenticated) / 403 (not permitted); the credentials or token were not accepted. Either for every endpoint (the run stopped before any load), or only for the endpoints the text names (those were skipped, the others were tested and the report is attached). Check they are correct, not expired and allowed to call the API. |
| `NO_RESPONSE` | The first 10 requests of a virtual user got no HTTP response at all: the API was never reached. Check the host name, network and that the API is running. |
| `ENDPOINT_NO_SUCCESS` | The test ran to the end and the report is attached, but the named endpoint(s) never returned the expected status (shows the HTTP codes that came back). The API answered, so the credentials were accepted. Check URL, method, payload and `expectedStatus`. |
| `TOKEN_REQUEST_FAILED` | The identity provider answered the OAuth token request with HTTP N (error: `invalid_client`, ...). Check the token URL, client ID, client secret (not expired) and scope. Or: the token URL could not be reached. |
| `TOKEN_RESPONSE_INVALID` | The token request returned HTTP 200 but no `access_token`. |
| `MISSING_VALUE` | The value `authParameters.<key>` was not supplied: missing from the profile, or its variable group / Jenkins credential does not exist or is empty. |
| `PROFILE_NOT_FOUND` / `PROFILE_INVALID` | The profile could not be read (check `apiName`, `profileName`, branch) / is not valid JSON. |
| `UNKNOWN_AUTH_TYPE` | The `authType` is not one of the supported values (lists them). |
| *(no reason captured)* | Only what the exit code proves: 107 "could not start or crashed with a script error", 108 "stopped or judged failed by the engine", 125-127 "Docker could not start the container", 137 "killed, which usually means out of memory", otherwise "could not complete (exit code N)". All point to the k6 step log. |

Wording rule: say what was observed ("the API answered HTTP 401"), then what to check, and never claim a cause that was not observed. For example a 401 is reported as "credentials or token not accepted", not as "wrong password".


### results.json: the data behind the report (internal, not published)

The k6 dashboard export (`k6-dashboard.html`) only holds overall numbers. The engine therefore also writes `results.json` (schema `perf-results/1`) at the end of every run, including aborted ones. It contains no headers, payloads, credentials or query strings.

| Section | Content |
|---|---|
| `profile` | apiName, artifact version, auth type names, stages, thresholds |
| `run` | duration, peak VUs, requests and req/s, iterations, failed rate, checks pass rate, bytes sent/received, `stoppedEarly` |
| `latency` | overall and iteration latency (avg, min, median, p90, p95, p99, max, in ms) and the timing breakdown (blocked, connecting, TLS, sending, waiting = server time, receiving) |
| `thresholds` | every k6 threshold with `ok` true/false |
| `endpoints[]` | per endpoint: label, method, URL, expected status, `status` (OK / PARTIAL / NO_SUCCESS / NOT_RUN), `credentialsRejected` (true when its credentials were rejected: skipped after the one-request probe, or after a mid-run 401/403), requests, ok, failed, no response, success and error rate, req/s, **status code counts**, and latency twice: `latencyOk` (requests that returned an expected status, use it for SLAs) and `latencyAll` |
| `engineVerdict` | endpoints that never succeeded (the build result also depends on k6's exit code) |

Notes: status code counts are exact for the codes 200, 201, 202, 204, 301, 302, 304, 400, 401, 403, 404, 405, 408, 409, 415, 422, 429, 500, 502, 503, 504 and the endpoint's own `expectedStatus` values; anything else is counted under `other` (`badStatusRange` gives its min and max). The time series use a 5 s step (`K6_DASHBOARD_PERIOD`, k6's default is 10 s). The same per-endpoint metrics (`epN_*`) are inside `k6-dashboard.html`, which is where the report reads the time series from.

### The report (report.html)

`report/build_report.py` turns `results.json` (numbers) and the dashboard export `k6-dashboard.html` (the time series, one point per 5 s window) into **one self-contained HTML file**, `report.html`: everything is inline (CSS, JS, SVG charts), so it opens offline and as an email attachment. The one optional external request is the Inter web font (three `<link>` lines at the top of `report/report-template.html`); offline, or with those lines deleted, the report uses the system UI font. It is the only file that is published and the only one attached to the email; `k6-dashboard.html` and `results.json` stay in the workspace as inputs. Python standard library only. It never fails the build: on a problem it prints a warning and the pipeline carries on.

What the page shows, and why only this:

| Block | Answers |
|---|---|
| Result banner | PASSED, PASSED - SLA missed, or FAILED, with the one-line reason |
| **Endpoint drop-down** | scopes everything below to "All endpoints" or one endpoint (link to one: `report.html#ep=2`) |
| Stat tiles | requests, success rate, throughput, average, p95, p99, slowest (successful requests only), each with a small trend line |
| What stands out | plain-language findings: endpoints whose credentials were rejected, failing endpoints and their status codes, SLA thresholds missed, timeouts, "passed only because errors are fast", the slowest endpoint, a throughput-saturation hint |
| Endpoints table (all view) | one row per endpoint with a result pill (OK / Partly failing / Failing / **Credentials rejected** / Not called), click to open it |
| **Performance overview** (the one big chart) | k6's "HTTP Performance overview": request rate (left axis, /s), p95 request duration (right axis) and failed requests (drawn on a fixed 0-100 % of the height, no axis) overlaid on one timeline. Read each line against its own axis; the legend and tooltip give the exact values |
| Response time | average, p95, p99 per window: does latency grow with load? (half width) |
| Virtual users | the load profile over time, with ramp / hold markers (half width) |
| p95 and throughput by endpoint | which endpoint is slow, over time. Drawn only for 2-3 endpoints (three validated colours); with more, use the table's p95 bars or open each endpoint |
| Distribution, status codes | percentile bars; every status code with its meaning, count and share |
| SLA thresholds, time split (all view) | each k6 threshold with the observed value; server time vs connection set-up vs transfer |

It works for any number of endpoints (the drop-down and the table grow with the profile; each endpoint also gets its own overview).

Look and interaction rules: a header with the result, a sticky toolbar, straight lines between samples (every point is one 5 s aggregate, so nothing is invented between windows) with a small dot on each sample, a flat translucent fill under each line (as in k6), only the overview is large, a **live legend** under every chart (whole-run figures, switching to the values at the cursor on all charts at once), a crosshair that moves in all charts together, **drag across a chart to zoom** all charts (double-click, Escape or the Reset chip to restore), keyboard arrows on a focused chart, a Charts/Tables switch that shows the same data as tables, a **Light | Dark** switch (Light is the default; the report never follows the operating system), and a Print / PDF button (always printed in Light). Colours are neighbours on the spectrum, like k6's own: teal (request rate, average), blue (p95), violet (p99, failed requests), validated with the dataviz palette checker against the white and dark surfaces (colour-blind and contrast rules). The SLA thresholds are not drawn as lines on the charts: they appear in the findings and in the SLA table. A load-stage hairline marks every stage boundary. Open it locally: `python report/build_report.py --results results.json --dashboard k6-dashboard.html --out report.html`.

## 4. Credential contract (the part that must stay the same)

The engine reads **environment variable names**. The names of the Azure variable groups and Jenkins credential IDs are only storage labels. **Never rename an environment variable for one CI tool**: it would break the other tool and every profile that uses `{{NAME}}`.

| Environment variable | Used by `authType` | Azure DevOps (variable group -> variable) | Jenkins (credential ID, type) |
|---|---|---|---|
| `CLIENT_ID`, `CLIENT_SECRET` | `CLIENT_ID_ENFORCEMENT` | `perf-client-id` -> `client_id`, `client_secret` | `perf-client-id` (username with password) |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | `OAUTH2_CLIENT_CREDENTIALS` | `perf-oauth` -> `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | `perf-oauth-client` (username with password) |
| `OAUTH_TOKEN_URL` | `OAUTH2_CLIENT_CREDENTIALS` | `perf-oauth` -> `OAUTH_TOKEN_URL` | `perf-oauth-token-url` (secret text) |
| `OAUTH_SCOPE` | `OAUTH2_CLIENT_CREDENTIALS` | `perf-oauth` -> `OAUTH_SCOPE` | `perf-oauth-scope` (secret text) |
| `BASIC_USERNAME`, `BASIC_PASSWORD` | `BASIC` | `perf-basic-auth` -> `BASIC_USERNAME`, `BASIC_PASSWORD` | `perf-basic-auth` (username with password) |
| `SMTP_USER`, `SMTP_PASSWORD` | email | `perf-smtp` -> `SMTP_USER`, `SMTP_PASS` | `perf-smtp` (username with password) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS`, `SMTP_FROM` | email | `perf-smtp` | `environment` block of the `Jenkinsfile` (`SMTP_FROM` defaults to the SMTP user) |
| `MANDATORY_RECIPIENTS` (optional) | email | `perf-smtp` | global environment variable |

Two storage differences, both handled in each CI tool's own mapping (no engine change): Azure stores the OAuth client ID and secret as two variables, Jenkins as one username/password credential; Azure's SMTP password variable is `SMTP_PASS`, which the template maps to `SMTP_PASSWORD`.

If a profile needs a value that was never supplied, or a variable that still holds its raw `{{NAME}}` / `$(name)` text, the engine stops in `setup()` and names the missing key (exit 107).

## 5. Azure DevOps setup

1. **Variable groups** (Pipelines -> Library), each authorised for the pipeline. Create only what your profiles use, but note that the template references all four groups, so **a missing group fails every run**:
   - `perf-client-id`: `client_id`, `client_secret` (secret); optional `GITHUB_PAT` (secret) for a private API repo.
   - `perf-oauth`: `OAUTH_TOKEN_URL`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` (secret), `OAUTH_SCOPE`.
   - `perf-basic-auth`: `BASIC_USERNAME`, `BASIC_PASSWORD` (secret).
   - `perf-smtp`: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (secret), `SMTP_FROM`, `SMTP_TLS`; optional `MANDATORY_RECIPIENTS`.
     Gmail: `smtp.gmail.com`, `465`, `SMTP_TLS=ssl`, an app password.
2. **Create the pipeline:** New pipeline -> GitHub -> this repo -> *Existing Azure Pipelines YAML file* -> `/azure-pipelines.yml`. A pushed YAML change needs no pipeline update; every run reads the YAML from the branch.
3. **Agent:** Microsoft-hosted `ubuntu-latest` (has Docker, git, Python). A new organisation has 0 hosted parallel jobs by default: request the free grant (https://aka.ms/azpipelines-parallelism-request) or use a self-hosted Ubuntu agent with Docker, Python 3 and git and change the `pool` in `k6-pipeline-job-template.yml`.
4. **Run:** Run pipeline -> set the parameters from section 2. Results arrive by email and as the build artifact `StressTestReport`.
   **Private repos:** the tooling repo needs no token (Azure fetches it through its own GitHub connection, the Azure Pipelines GitHub app). A private **API repo** needs a read-only GitHub token (fine-grained: only the repos it must read, permission *Contents: Read-only*, with an expiry) stored as the secret variable `GITHUB_PAT` in `perf-client-id`; without it the clone is anonymous.
5. Defaults for `apiName` / `profileName` are set in `azure-pipelines.yml`.

## 6. Jenkins setup

1. **Plugins:** Pipeline, Git, Credentials Binding, Timestamper.
2. **Agent:** Linux with `git` and `docker` (the agent user must be allowed to run `docker`). Nothing else: k6 and the email script both run in containers (`grafana/k6`, `python:3.12-alpine`). If the agent is itself a container that uses the host's Docker socket, `-v $WORKSPACE:...` mounts a host path that does not exist: use a VM/host agent, or mount the workspace at the same path on both sides.
3. **Credentials** (Manage Jenkins -> Credentials), IDs and types as in section 4. A credential that does not exist is skipped (the console says so), so create only what your profiles use; a profile that needs a missing value fails fast naming the key. For a private API repo create a *Username with password* credential (any user + a read-only access token) and put its ID in `apiRepoCredentialsId`. Unlike Azure, Jenkins has no built-in GitHub connection, so a private **tooling** repo also needs a credential: select one in the job's *Pipeline script from SCM* settings (the same kind of token, or an SSH deploy key).
4. **Job:** New Item -> Pipeline -> *Pipeline script from SCM* -> Git -> this repo, branch `*/main`, Script Path `Jenkinsfile`. The **first** run only registers the parameters and may fail validation; from the second run use **Build with Parameters**.
5. Non-secret SMTP settings (`smtp.gmail.com`, `465`, `ssl`) are in the `environment` block of the `Jenkinsfile`.
6. **Things to know:**
   - Jenkins' default Content-Security-Policy blocks scripts in archived HTML, so the report does not render on the build page. Download it or open the email attachment. Do not weaken the CSP.
   - Builds are serialised (`disableConcurrentBuilds`) so two load tests do not distort each other.
   - The k6 image is `grafana/k6:latest`; pin it in the `environment` block once you have a tested version.
   - `debug=true` writes credentials and tokens to the console log. Jenkins masks bound credentials, not a token fetched at run time.
7. **API teams that want their own Jenkins job:** copy `templates/Jenkinsfile` into the API repo and fill in its `environment` block. It only calls the central job (`build job:`) with the repo, folder and profile, so test logic, credentials and email stay in one place.

Azure -> Jenkins at a glance: variable groups -> credentials; `GITHUB_PAT` -> `apiRepoCredentialsId`; `##vso[task.setvariable]` -> `env.K6_EXIT_CODE`; `PublishBuildArtifacts` -> `archiveArtifacts`; Microsoft-hosted agent -> your own Docker-capable Linux agent.

## 7. Load profile format

The profile lives in the API repo (`<apiName>/<profileName>`); the API repo needs no pipeline YAML. `{{NAME}}` tokens are replaced with the environment variable `NAME`.

```json
{
  "apiName": "AI Innovation POC1 API",
  "artifact_version": "1.0.105",
  "authType": "OAUTH2_CLIENT_CREDENTIALS",
  "authParameters": {
    "tokenUrl": "{{OAUTH_TOKEN_URL}}",
    "clientId": "{{OAUTH_CLIENT_ID}}",
    "clientSecret": "{{OAUTH_CLIENT_SECRET}}",
    "scope": "{{OAUTH_SCOPE}}",
    "grantType": "client_credentials"
  },
  "stages": [ { "duration": "10s", "target": 15 }, { "duration": "10s", "target": 0 } ],
  "thresholds": { "http_req_failed": ["rate<0.01"], "http_req_duration": ["p(95)<2000"] },
  "endpoints": [
    { "endpoint": "https://example.cloudhub.io/api/orders/ORD102", "method": "GET", "expectedStatus": 200, "sleepDuration": 0.5 }
  ]
}
```

- `apiName` and `artifact_version` are labels for the email subject only (`artifact_version` is typed by hand, default `N/A`).
- `authType` / `authParameters` at the root are the default; an endpoint may override them with its own, or opt out with `"authType": "NONE"`. One token is fetched per distinct credential set.
- Supported `authType` values and their `authParameters`:

  | `authType` | `authParameters` | Effect |
  |---|---|---|
  | `OAUTH2_CLIENT_CREDENTIALS` | `tokenUrl`, `clientId`, `clientSecret`, `scope`, optional `grantType` (`client_credentials` only) | token fetched once in `setup()`, sent as `Authorization: Bearer` |
  | `CLIENT_ID_ENFORCEMENT` | `clientId`, `clientSecret` | sent as `client_id` / `client_secret` headers |
  | `BASIC` | `username`, `password` | `Authorization: Basic base64(user:pass)` |

- Per endpoint: `method`, `payload` (object or string, for POST/PUT/PATCH), `headers`, `expectedStatus` (number or list, default 200), `sleepDuration`, optional `name` (label used in checks and logs), optional `readOnly` (`true` = safe to call as a credential probe although the method is POST, e.g. a GraphQL query; `false` on a GET = never probe it). Example with two methods: `sample-api/AI_innovation_poc1/load-profile5-multi-put-nulls.json`.
- Root field `probe` (optional): `"auto"` (default, see section 3), `"all"` (one probe request to every endpoint, writes included: the previous behaviour) or `"off"` (no probe: every virtual user finds out for itself, so bad credentials are sent once per VU and can lock an account).
- Consecutive endpoints with the same `batchGroup` run in parallel. Old profiles that put `{{CLIENT_ID}}` straight into endpoint headers still work.
- Other examples: `templates/load-profile*.json`.

## 8. Adding a new auth type

1. Add `auth/<name>.js` exporting `validate(authParameters)`, `setup(authParameters)` and `apply(headers, authParameters, state)`.
2. Register it with one line in `auth/index.js`.
3. If it needs **new variables**: add the names to `PASSTHROUGH` in `ci/run-k6.sh`, map the secret in `k6-pipeline-job-template.yml` (`env:`) and in the `Jenkinsfile` (`credentialBindings`), and add a row to the table in section 4.

## 9. Email

`send-email.py` sends the report over SMTP (implicit SSL for port 465 or `SMTP_TLS=ssl`, otherwise STARTTLS). The subject is `[RESULT] Performance Test Report - <apiName> - Version <artifact_version>`, with the values read from the profile. Recipients are `reportRecipient` plus `MANDATORY_RECIPIENTS` if defined (none by default); `reportCc` (empty by default) goes into the Cc header. A delivery failure never hides the test result: Azure logs it and carries on, Jenkins marks the build UNSTABLE.

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Azure run fails before any step: variable group not found / not authorised | A group the template references does not exist or the pipeline is not authorised for it |
| `[FAILED]`, k6 exit 108 | The email states the reason (`CREDENTIALS_REJECTED` or `ENDPOINT_NO_SUCCESS`, see section 3). Same text is in the k6 step log |
| `[FAILED]`, k6 exit 107 | Setup or script error. The email states the reason when the engine knows it (token request failed, missing value, bad profile; section 3). Otherwise read the k6 step log |
| `[PASSED]` with "SLA MISSED" in the message | The test is fine; latency or error rate crossed a threshold in the profile. Open the report, or agree new thresholds with the team lead |
| Azure: "No hosted parallelism has been purchased or granted" | See section 5, step 3 |
| Jenkins: "Load profile not found in the API repo" | Check `apiName` (case-sensitive), `profileName` and `apiRepoBranch` |
| No email arrived | Read the email step log for "Error sending email" (a send failure does not fail the build); check the SMTP settings and, for Gmail, the app password |

## 11. Security notes

- Secrets are never written to the repo or passed as command-line values; they reach the container by name only. Do not paste tokens or secrets into profiles, issues or chat.
- Rotate any credential that was ever committed (it stays in git history).
- Treat `debug=true` as sensitive (see section 2).
- Track expiry of the OAuth client secret.

## 12. Third-party software and licenses

| Component | Role | License | Where it is stated |
|---|---|---|---|
| **[Grafana k6](https://github.com/grafana/k6)** | Generates the load and the measurements. Run as the official `grafana/k6` container image, unmodified, as a separate program. | **GNU AGPL-3.0** ([license text](https://github.com/grafana/k6/blob/master/LICENSE.md)) | Footer and "Test details" of `report.html` (with the exact k6 version of the run). Deliberately **not** in the email |
| k6 web dashboard export (`k6-dashboard.html`) | k6's own dashboard file, used only as an input for the time series | part of k6 | Not published or attached |
| Python standard library | `send-email.py`, `report/build_report.py` | PSF license | not shown |
| Docker images `python:3.12-alpine` (Jenkins email and report step) | Runtime | their upstream licenses | not shown |

How the k6 notice works: `ci/run-k6.sh` writes the first line of `k6 version` to `k6-version.txt`; `report/build_report.py` reads it and puts, for example, "Grafana k6 v1.4.2 ... licensed under the GNU AGPL-3.0" with links to the license and the source code into the report. The wording lives in `report/report-template.html` (search for `K6_LICENSE`). The email does not mention k6 or the license. If the version cannot be determined the notice is shown without it.

`report.html` contains no k6 code and no third-party libraries: charts are drawn with plain JavaScript and SVG. Its links to the k6 documentation, license and source are ordinary links, not loaded resources. The only resource it loads from outside is the optional Inter web font (three `<link>` lines at the top of `report/report-template.html`); delete them for a fully offline report, which then uses the system UI font.

This section states facts about how the tooling uses k6. It is not legal advice: whether and how AGPL-3.0 affects your organisation (for example if k6 itself is ever modified, redistributed, or offered to others as a service) is a question for your compliance or legal team.

# API Performance Testing Pipeline (k6)

One tooling repo, two CI front ends. A user runs a pipeline **manually**, says where a load-profile JSON lives, and the pipeline:

1. clones the API repo that holds the profile,
2. runs the profile with [k6](https://k6.io) in Docker,
3. archives the HTML dashboard report,
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
  -> ci/run-k6.sh : grafana/k6 in Docker -> report.html, exit code
  -> archive report.html (Azure: artifact "StressTestReport", Jenkins: build artifact)
  -> ci/status.sh + send-email.py : email the report
  -> final check: decide the build result from the k6 exit code
```

Run parameters (same names in both tools):

| Parameter | Meaning |
|---|---|
| `apiRepoUrl` | Git URL of the repo that holds the profile (default: `https://github.com/AnkitProwess/sample-api.git`) |
| `apiName` | Folder in the API repo, case-sensitive (empty = repo root). **Not** the `apiName` label inside the JSON. |
| `profileName` | JSON file name inside that folder, e.g. `load-profile3.json` |
| `reportRecipient` | Who receives the email (comma or semicolon separated) |
| `debug` | `true` adds `k6 --http-debug=full`. It writes request headers, **including credentials and tokens**, to the log. Use only when needed. |
| Jenkins only: `apiRepoBranch`, `apiRepoCredentialsId` | Branch to clone (default `main`); credentials ID for a private API repo |

## 3. Results: what the build and the email say

| k6 exit | Meaning | Build | Email |
|---|---|---|---|
| `0` | All thresholds met | green | `[PASSED]` |
| `99` | The test ran, but an SLA threshold (latency / error rate) was crossed | **green with a warning** (Azure: "succeeded with issues"; Jenkins: yellow stage, build stays SUCCESS) | `[PASSED]` (green) with the message **"SLA MISSED: ..."** below it |
| `108` | The engine **stopped the run early** (see the reasons below) | **red** | `[FAILED]` + the exact reason |
| `107` | The test could not start: setup or script error (see the reasons below) | **red** | `[FAILED]` + the exact reason |
| anything else | The test could not run (Docker error, killed process, ...) | **red** | `[FAILED]` + what the exit code proves |

Notes:

- `FAILED` is reserved for "the test could not run". An SLA miss is shown as `PASSED` (the test itself worked) with an "SLA MISSED" message under the result, so read that line, not just the subject.
- **Wrong credentials fail the build.** If any request gets 401 or 403 (and the profile did not set `expectedStatus` to that code), the engine aborts the run at once. Previously a 100%-failed run only crossed a threshold and looked like an SLA miss.
- **A run where nothing succeeds fails the build too.** If a VU makes 10 requests and none returns the expected status (404 from a wrong URL, 500, host unreachable), the engine aborts the same way. Without this, such a run only crossed the failed-request threshold (exit 99) and looked like an SLA miss. Once at least one request has succeeded, later errors are *not* aborted: they count towards the thresholds, so a real degradation is still reported as an SLA miss.
- Each email shows the label and a one-line reason (next section). If the test never got as far as generating load, there is no report attached and the email says so.
- Rules live in `ci/status.sh` and `ci/run-k6.sh`. Changing them changes both tools.

### Why a run failed: how the reason is chosen

The same exit code can have several causes (108 covers both rejected credentials and "nothing ever succeeded"; 107 covers any setup error), so the reason is **not guessed from the exit code**. The engine states it itself, in one log line `PERF_REASON|<CODE>|<text>` written just before it stops. `ci/run-k6.sh` keeps the first such line in `k6-reason.txt` and `ci/status.sh` puts the text into the email and the build log. The text only contains facts the engine knows (a status code, a key name, the identity provider's standard error code). It never contains a secret, a token, a response body, a query string or a host name taken from an error message.

| Reason code | Email says (summary) |
|---|---|
| `CREDENTIALS_REJECTED` | The API answered HTTP 401 (not authenticated) / 403 (not permitted) for `GET <url>`; the credentials or token were not accepted. Check they are correct, not expired and allowed to call this API. |
| `NO_SUCCESS` | None of the first 10 requests of a virtual user returned the expected status; the last one got HTTP 404 (not found) / 5xx (server error) / no HTTP response. Followed by a matching hint (check the URL, the API's logs, or the network). |
| `TOKEN_REQUEST_FAILED` | The identity provider answered the OAuth token request with HTTP N (error: `invalid_client`, ...). Check the token URL, client ID, client secret (not expired) and scope. Or: the token URL could not be reached. |
| `TOKEN_RESPONSE_INVALID` | The token request returned HTTP 200 but no `access_token`. |
| `MISSING_VALUE` | The value `authParameters.<key>` was not supplied: missing from the profile, or its variable group / Jenkins credential does not exist or is empty. |
| `PROFILE_NOT_FOUND` / `PROFILE_INVALID` | The profile could not be read (check `apiName`, `profileName`, branch) / is not valid JSON. |
| `UNKNOWN_AUTH_TYPE` | The `authType` is not one of the supported values (lists them). |
| *(no reason captured)* | Only what the exit code proves: 107 "could not start or crashed with a script error", 108 "stopped early by the engine", 125-127 "Docker could not start the container", 137 "killed, which usually means out of memory", otherwise "could not complete (exit code N)". All point to the k6 step log. |

Wording rule: say what was observed ("the API answered HTTP 401"), then what to check, and never claim a cause that was not observed. For example a 401 is reported as "credentials or token not accepted", not as "wrong password".


## 4. Credential contract (the part that must stay the same)

The engine reads **environment variable names**. The names of the Azure variable groups and Jenkins credential IDs are only storage labels. **Never rename an environment variable for one CI tool**: it would break the other tool and every profile that uses `{{NAME}}`.

| Environment variable | Used by `authType` | Azure DevOps (variable group -> variable) | Jenkins (credential ID, type) |
|---|---|---|---|
| `CLIENT_ID`, `CLIENT_SECRET` | `CLIENT_ID_ENFORCEMENT` | `dev-test` -> `client_id`, `client_secret` | `perf-client-id` (username with password) |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | `OAUTH2_CLIENT_CREDENTIALS` | `Oauth` -> `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | `perf-oauth-client` (username with password) |
| `OAUTH_TOKEN_URL` | `OAUTH2_CLIENT_CREDENTIALS` | `Oauth` -> `OAUTH_TOKEN_URL` | `perf-oauth-token-url` (secret text) |
| `OAUTH_SCOPE` | `OAUTH2_CLIENT_CREDENTIALS` | `Oauth` -> `OAUTH_SCOPE` | `perf-oauth-scope` (secret text) |
| `BASIC_USERNAME`, `BASIC_PASSWORD` | `BASIC` | `BasicAuth` -> `BASIC_USERNAME`, `BASIC_PASSWORD` | `perf-basic-auth` (username with password) |
| `SMTP_USER`, `SMTP_PASSWORD` | email | `email-testing-vg` -> `SMTP_USER`, `SMTP_PASS` | `perf-smtp` (username with password) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS`, `SMTP_FROM` | email | `email-testing-vg` | `environment` block of the `Jenkinsfile` (`SMTP_FROM` defaults to the SMTP user) |
| `MANDATORY_RECIPIENTS` (optional) | email | `email-testing-vg` | global environment variable |

Two storage differences, both handled in each CI tool's own mapping (no engine change): Azure stores the OAuth client ID and secret as two variables, Jenkins as one username/password credential; Azure's SMTP password variable is `SMTP_PASS`, which the template maps to `SMTP_PASSWORD`.

If a profile needs a value that was never supplied, or a variable that still holds its raw `{{NAME}}` / `$(name)` text, the engine stops in `setup()` and names the missing key (exit 107).

## 5. Azure DevOps setup

1. **Variable groups** (Pipelines -> Library), each authorised for the pipeline. Create only what your profiles use, but note that the template references all four groups, so **a missing group fails every run**:
   - `dev-test`: `client_id`, `client_secret` (secret); optional `GITHUB_PAT` (secret) for a private API repo.
   - `Oauth`: `OAUTH_TOKEN_URL`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` (secret), `OAUTH_SCOPE`.
   - `BasicAuth`: `BASIC_USERNAME`, `BASIC_PASSWORD` (secret).
   - `email-testing-vg`: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (secret), `SMTP_FROM`, `SMTP_TLS`; optional `MANDATORY_RECIPIENTS`.
     Gmail: `smtp.gmail.com`, `465`, `SMTP_TLS=ssl`, an app password.
2. **Create the pipeline:** New pipeline -> GitHub -> this repo -> *Existing Azure Pipelines YAML file* -> `/azure-pipelines.yml`. A pushed YAML change needs no pipeline update; every run reads the YAML from the branch.
3. **Agent:** Microsoft-hosted `ubuntu-latest` (has Docker, git, Python). A new organisation has 0 hosted parallel jobs by default: request the free grant (https://aka.ms/azpipelines-parallelism-request) or use a self-hosted Ubuntu agent with Docker, Python 3 and git and change the `pool` in `k6-pipeline-job-template.yml`.
4. **Run:** Run pipeline -> set the parameters from section 2. Results arrive by email and as the build artifact `StressTestReport`.
5. Defaults for `apiName` / `profileName` are set in `azure-pipelines.yml`.

## 6. Jenkins setup

1. **Plugins:** Pipeline, Git, Credentials Binding, Timestamper.
2. **Agent:** Linux with `git` and `docker` (the agent user must be allowed to run `docker`). Nothing else: k6 and the email script both run in containers (`grafana/k6`, `python:3.12-alpine`). If the agent is itself a container that uses the host's Docker socket, `-v $WORKSPACE:...` mounts a host path that does not exist: use a VM/host agent, or mount the workspace at the same path on both sides.
3. **Credentials** (Manage Jenkins -> Credentials), IDs and types as in section 4. A credential that does not exist is skipped (the console says so), so create only what your profiles use; a profile that needs a missing value fails fast naming the key. For a private API repo create a *Username with password* credential (any user + an access token) and put its ID in `apiRepoCredentialsId`.
4. **Job:** New Item -> Pipeline -> *Pipeline script from SCM* -> Git -> this repo, branch `*/main`, Script Path `Jenkinsfile`. The **first** run only registers the parameters and may fail validation; from the second run use **Build with Parameters**.
5. Non-secret SMTP settings (`smtp.gmail.com`, `465`, `ssl`) are in the `environment` block of the `Jenkinsfile`.
6. **Things to know:**
   - Jenkins' default Content-Security-Policy blocks scripts in archived HTML, so the k6 dashboard does not render on the build page. Download it or open the email attachment. Do not weaken the CSP.
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

- Consecutive endpoints with the same `batchGroup` run in parallel. `expectedStatus` defaults to 200. Old profiles that put `{{CLIENT_ID}}` straight into endpoint headers still work.
- Other examples: `templates/load-profile*.json`.

## 8. Adding a new auth type

1. Add `auth/<name>.js` exporting `validate(authParameters)`, `setup(authParameters)` and `apply(headers, authParameters, state)`.
2. Register it with one line in `auth/index.js`.
3. If it needs **new variables**: add the names to `PASSTHROUGH` in `ci/run-k6.sh`, map the secret in `k6-pipeline-job-template.yml` (`env:`) and in the `Jenkinsfile` (`credentialBindings`), and add a row to the table in section 4.

## 9. Email

`send-email.py` sends the report over SMTP (implicit SSL for port 465 or `SMTP_TLS=ssl`, otherwise STARTTLS). The subject is `[RESULT] Performance Test Report - <apiName> - Version <artifact_version>`, with the values read from the profile. Recipients are `reportRecipient` plus `MANDATORY_RECIPIENTS` if defined (none by default). A delivery failure never hides the test result: Azure logs it and carries on, Jenkins marks the build UNSTABLE.

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Azure run fails before any step: variable group not found / not authorised | A group the template references does not exist or the pipeline is not authorised for it |
| `[FAILED]`, k6 exit 108 | The email states the reason (`CREDENTIALS_REJECTED` or `NO_SUCCESS`, see section 3). Same text is in the k6 step log |
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

# Prerequisites

Everything that must be in place **before** you follow [INSTALLATION-STEPS.md](INSTALLATION-STEPS.md). For what the application does and how it is built, see [README.md](README.md).

You need **one** CI platform: Azure DevOps **or** Jenkins. Both run the same engine, the same auth modules, the same email script and the same result rules.

---

## 1. Summary Checklist

| # | Prerequisite | Azure DevOps | Jenkins |
|---|---|---|---|
| 1 | This tooling repository in Git (GitHub) | Required | Required |
| 2 | A **public** API repository holding the load-profile JSON | Required | Required |
| 3 | An agent that can run Docker | Microsoft-hosted `ubuntu-latest` or self-hosted Ubuntu | Linux agent with `git` and `docker` |
| 4 | Permission to create the secret store | Variable groups (Pipelines -> Library) | Credentials (Manage Jenkins -> Credentials) |
| 5 | An SMTP account to send the report | Required | Required |
| 6 | Credentials for the API under test | Only if its profile needs them | Only if its profile needs them |
| 7 | Permission to load test the target API | Required | Required |

---

## 2. Source Code and Repositories

### 2.1 This tooling repository
- Hosted in a Git service the CI tool can read (the setup assumes **GitHub**).
- Azure DevOps reads it through the Azure Pipelines GitHub app (a service connection is created when you set up the pipeline). Jenkins reads it through *Pipeline script from SCM*; a private tooling repo needs a Jenkins credential (token or SSH deploy key).

### 2.2 The API repository (the repo being tested)

> [!NOTE]
> **The API repo to be tested must be public** so the pipeline can clone it anonymously. Each team keeps its own API repo in its own location; this tooling repo does not contain it. Because the repo is public, never commit secrets in it: profiles reference credentials with `{{NAME}}` tokens that the pipeline fills from its own secret store.

It must contain:
- A load-profile JSON file, at the repo root or in a folder (the folder name is the `apiName` run parameter, case-sensitive).
- A valid profile (see the profile format in [README.md](README.md), section 3). Profiles can be taken from `templates/load-profile*.json`.
- Nothing else: the repo needs no pipeline YAML when the pipeline is run by URL (manual mode).

---

## 3. CI Platform Requirements

### 3.1 Azure DevOps

| Requirement | Detail |
|---|---|
| Organisation and project | A project where you can create pipelines |
| Permissions | Create pipelines, and create and authorise **variable groups** (Pipelines -> Library) |
| Agent | **Microsoft-hosted `ubuntu-latest`** (includes Docker, git and Python), or a self-hosted Ubuntu agent with Docker, Python 3 and git |
| Hosted parallelism | A new organisation has **0 hosted parallel jobs** by default. Request the free grant at https://aka.ms/azpipelines-parallelism-request, or use a self-hosted agent and change the `pool` in `k6-pipeline-job-template.yml` |
| GitHub connection | The Azure Pipelines GitHub app, authorised for this tooling repo |
| Variable groups | Four groups referenced by the template: `perf-client-id`, `perf-oauth`, `perf-basic-auth`, `perf-smtp`. **A missing group fails every run**, so create all four (they may hold only the values you need) |

### 3.2 Jenkins

| Requirement | Detail |
|---|---|
| Jenkins | A working controller with a Linux agent |
| Plugins | **Pipeline**, **Git**, **Credentials Binding**, **Timestamper** |
| Agent | Linux with `git` and `docker`. The agent user must be allowed to run `docker`. Nothing else: k6 and the email/report scripts run in containers (`grafana/k6`, `python:3.12-alpine`) |
| Docker socket | If the agent is itself a container that uses the host's Docker socket, `-v $WORKSPACE:...` mounts a host path that does not exist. Use a VM/host agent, or mount the workspace at the same path on both sides |
| Credentials | Created in Manage Jenkins -> Credentials with the IDs listed in section 5. A credential that does not exist is skipped, so create only what your profiles use |
| Windows agents | Not supported: the pipeline scripts are `bash` / `sh` |

---

## 4. Software and Network

### 4.1 Software on the agent

| Software | Azure DevOps | Jenkins |
|---|---|---|
| Docker (to run `grafana/k6`) | Included on `ubuntu-latest` | Must be installed |
| git | Included on `ubuntu-latest` | Must be installed |
| Python 3 | Included on `ubuntu-latest` (runs the report builder and email script) | **Not needed** (runs in `python:3.12-alpine`) |
| k6 | **Not needed** (official `grafana/k6` image) | **Not needed** |

### 4.2 Outbound network access from the agent

| Destination | Why |
|---|---|
| Docker Hub (`grafana/k6`; `python:3.12-alpine` on Jenkins) | Image pulls. Anonymous pulls are rate limited, so busy shared agents may need a Docker Hub login or a registry mirror |
| `github.com` | Cloning the tooling repo and the API repo |
| The API host(s) under test | The load itself. The agent must be allowed to reach them, and must not be rate limited by them |
| The OAuth token URL | Only for `OAUTH2_CLIENT_CREDENTIALS` profiles |
| The SMTP host and port (e.g. `smtp.gmail.com:465`) | Sending the report email |

The person opening `report.html` needs no special access. It loads one optional web font (Inter) from Google Fonts and falls back to the system font when offline.

---

## 5. Secrets and Credentials

Create only what your profiles use. The names below are storage labels; the **environment variable names** are what the engine reads and must not change (see [README.md](README.md), section 6).

| Used for | Azure DevOps variable group -> variables | Jenkins credential ID (type) |
|---|---|---|
| `CLIENT_ID_ENFORCEMENT` | `perf-client-id` -> `client_id`, `client_secret` (secret) | `perf-client-id` (username with password) |
| `OAUTH2_CLIENT_CREDENTIALS` | `perf-oauth` -> `OAUTH_TOKEN_URL`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` (secret), `OAUTH_SCOPE` | `perf-oauth-client` (username with password), `perf-oauth-token-url` (secret text), `perf-oauth-scope` (secret text) |
| `BASIC` | `perf-basic-auth` -> `BASIC_USERNAME`, `BASIC_PASSWORD` (secret) | `perf-basic-auth` (username with password) |
| Report email | `perf-smtp` -> `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (secret), `SMTP_FROM`, `SMTP_TLS`, optional `MANDATORY_RECIPIENTS` | `perf-smtp` (username with password); the non-secret SMTP settings live in the `Jenkinsfile` `environment` block |

Keep track of when the OAuth client secret and the SMTP password expire.

---

## 6. Email (SMTP) Requirements

- An SMTP server you can authenticate against, with its host, port, user and password (or API key).
- **Gmail:** `smtp.gmail.com`, port `465`, `SMTP_TLS=ssl`, and an **app password** (it needs 2-Step Verification enabled on the Google account; the normal account password will not work).
- **SendGrid and similar:** use the provider's SMTP host and an API key as the password.
- A sender address (`SMTP_FROM`) that the provider allows you to send from. It defaults to the SMTP user.
- At least one recipient address for the `reportRecipient` run parameter.
- Port rule used by the script: port `465` or `SMTP_TLS=ssl`/`true` means implicit SSL, anything else means STARTTLS.

---

## 7. The System Under Test

Agree these **before** the first run, especially if the target is shared:

| Question | Why it matters |
|---|---|
| Are you allowed to load test this API, and in this environment? | A load test looks like an attack to a monitored or rate-limited system. Prefer dev, test or staging, not production |
| Who is told when it runs? | Operations and the API owners should expect the traffic |
| Do you have a dedicated test account and test data? | Write endpoints (POST / PUT / DELETE) really create, change and delete data on every iteration |
| What are the rate limits and quotas? | Exceeding them produces 429 / 503 and turns the results into a test of the limiter |
| Are the SLA thresholds agreed? | Thresholds in the profile decide `PASSED` vs "SLA MISSED". The defaults are `http_req_failed rate<0.01` and `http_req_duration p(95)<2000` |
| Can the agent generate the load? | One hosted agent has limited CPU and memory. If it saturates, the report shows the agent's limits, not the API's |

---

## 8. Local Run Prerequisites (Optional)

Only needed for `run-local.ps1` / `run-local.sh` (not part of the CI flow):

| Requirement | Detail |
|---|---|
| Docker **or** the k6 binary | The scripts use Docker when available, otherwise a local `k6` |
| PowerShell (Windows) or Bash (Linux / macOS) | For `run-local.ps1` / `run-local.sh` |
| Python 3 | Only if you want to build the custom report locally with `report/build_report.py` |
| Internet access | The sample profiles in `templates/` call `https://httpbin.org` |

---

## 9. Quick Self-Check

Before starting the installation, you should be able to answer **yes** to each:

- [ ] I can push to the tooling repo and CI can read it.
- [ ] My API repo is public and contains a valid profile JSON.
- [ ] I know the exact folder name (`apiName`) and file name (`profileName`).
- [ ] My agent can run `docker run hello-world` (or Azure hosted parallelism is granted).
- [ ] I have the SMTP host, port, user and password, and at least one recipient.
- [ ] I have the API credentials needed by my profile, or the profile needs none.
- [ ] I have permission to load test the target API.

Next: [INSTALLATION-STEPS.md](INSTALLATION-STEPS.md).

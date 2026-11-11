# Installation Steps

Step-by-step setup for **Azure DevOps**, **Jenkins** and the **report email**. Complete [PREREQUISITES.md](PREREQUISITES.md) first. For what the application does, see [README.md](README.md).

Follow **Part 1**, then **either Part 2 (Azure DevOps) or Part 3 (Jenkins)**, then **Part 4 (Email)** and **Part 5 (Verify)**.

| Part | Topic |
|---|---|
| 1 | Common preparation (all platforms) |
| 2 | Azure DevOps |
| 3 | Jenkins |
| 4 | Email (SMTP) |
| 5 | Verify the installation |
| 6 | Optional: private API repo, pinning versions |

---

## Part 1: Common Preparation

1. **Put this tooling repository in GitHub** (push this folder, branch `main`).
2. **Prepare the API repository** (the repo to be tested):
   - It must be **public** (the pipeline clones it anonymously).
   - Add a load-profile JSON at the root or in a folder, e.g. `my-api/load-profile.json`. Start from `templates/load-profile*.json`; the format is in [README.md](README.md), section 3.
   - Use `{{NAME}}` tokens for any secret (e.g. `{{OAUTH_CLIENT_SECRET}}`); never commit a real secret.
3. **Decide which credentials your profile needs** and collect the values:

   | Profile `authType` | Values needed |
   |---|---|
   | `CLIENT_ID_ENFORCEMENT` | client ID, client secret |
   | `OAUTH2_CLIENT_CREDENTIALS` | token URL, client ID, client secret, scope |
   | `BASIC` | username, password |
   | none | nothing |

4. **Collect the SMTP values** (host, port, user, password, optional from address) and the recipient addresses (see Part 4).

> [!NOTE]
> Use the exact names in the tables below. The Azure group names and the Jenkins credential IDs are labels, but they must match what the pipeline files reference. Do not rename the **environment variable** names (see [README.md](README.md), section 6).

---

## Part 2: Azure DevOps

### Step 2.1: Create the variable groups

In your project open **Pipelines -> Library -> + Variable group** and create these four groups. **All four must exist**, because the job template references all of them and a missing group fails every run. A group may hold only the values you need, but create it.

| Group name | Variables | Notes |
|---|---|---|
| `perf-client-id` | `client_id`, `client_secret` | Mark `client_secret` as secret (padlock). Optional `GITHUB_PAT` is only for a private API repo (Part 6). |
| `perf-oauth` | `OAUTH_TOKEN_URL`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_SCOPE` | Mark `OAUTH_CLIENT_SECRET` as secret. |
| `perf-basic-auth` | `BASIC_USERNAME`, `BASIC_PASSWORD` | Mark `BASIC_PASSWORD` as secret. |
| `perf-smtp` | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_TLS`, optional `MANDATORY_RECIPIENTS` | Mark `SMTP_PASS` as secret. Values: see Part 4. |

> [!NOTE]
> If you rename a group later, change the matching `- group:` line in `k6-pipeline-job-template.yml` in the same change. The name in the YAML must match the Library exactly.

### Step 2.2: Make sure the pipeline can use a hosted agent

- The pipeline uses Microsoft-hosted `ubuntu-latest`.
- A new organisation has **0 hosted parallel jobs**. Request the free grant at https://aka.ms/azpipelines-parallelism-request, or use a self-hosted Ubuntu agent with Docker, Python 3 and git and change the `pool` in `k6-pipeline-job-template.yml`.

### Step 2.3: Create the pipeline (Dynamic Manual Mode)

1. **Pipelines -> New pipeline -> GitHub**, select this tooling repository (authorise the Azure Pipelines GitHub app if asked).
2. Choose **Existing Azure Pipelines YAML file** and select `/azure-pipelines.yml`.
3. **Save** (do not have to run yet). A pushed YAML change needs no pipeline update: every run reads the YAML from the branch.

### Step 2.4: Run it

1. **Run pipeline** and fill in the parameters:

   | Parameter | Value |
   |---|---|
   | Target API Git Repo URL | Clone URL of your **public** API repo |
   | Email Report Recipient(s) | Comma separated addresses |
   | Email Cc | `none` for no Cc |
   | API Name | Folder of the profile in the API repo, case-sensitive (empty = repo root) |
   | Profile Name | JSON file name, e.g. `load-profile.json` |
   | Enable HTTP Debugging | `false` (`true` writes credentials and tokens to the log) |

2. On the first run Azure may show **"This pipeline needs permission to access a resource"** for each variable group. Click **View -> Permit** for all four.
3. When it finishes, the report is in the build artifact **`StressTestReport`** and in the email. Defaults for the parameters are set in `azure-pipelines.yml`.

### Step 2.5 (alternative): Imported Mode (the API repo owns a small pipeline)

Use this when an API team wants a pipeline inside its own repository that calls this one as a template.

1. In the API repo add the load profile (root or folder).
2. Copy `templates/azure-pipelines.yml` into the API repo and edit it:
   - `resources.repositories[].name`: `<organisation or user>/<tooling repo>` of this repository.
   - `endpoint`: the name of your Azure DevOps **GitHub service connection** (Project settings -> Service connections). For a repository hosted on GitHub, Azure expects the resource to be declared with `type: github`; the sample file says `type: git`, so check it against your setup before the first run.
   - `parameters`: `apiName` (folder), `reportRecipient`, and optionally `profileName` (default `load-profile.json`) and `debug`.
3. Create a pipeline in Azure DevOps that points to **the API repo** and uses that YAML.
4. Create the same four variable groups as in Step 2.1, and permit the pipeline to use them.

In this mode the API repo is the pipeline's own repository, so it is checked out by Azure and does not need to be cloned by URL.

---

## Part 3: Jenkins

### Step 3.1: Install the plugins

**Manage Jenkins -> Plugins**: install **Pipeline**, **Git**, **Credentials Binding** and **Timestamper**.

### Step 3.2: Prepare the agent

- Linux, with `git` and `docker` installed.
- The Jenkins agent user must be allowed to run Docker (e.g. member of the `docker` group). Check with `docker run --rm hello-world` as that user.
- Nothing else is needed: k6 and the email/report scripts run in containers (`grafana/k6`, `python:3.12-alpine`).
- To restrict the job to specific agents, change `agent any` in the `Jenkinsfile` to e.g. `agent { label 'linux && docker' }`.

### Step 3.3: Create the credentials

**Manage Jenkins -> Credentials -> (global) -> Add Credentials.** Use these exact IDs. A credential that does not exist is skipped (the console says so), so create only what your profiles use; a profile that needs a missing value fails fast and names the key.

| ID | Kind | Username / Secret | Used by |
|---|---|---|---|
| `perf-client-id` | Username with password | client ID / client secret | `CLIENT_ID_ENFORCEMENT` |
| `perf-oauth-client` | Username with password | OAuth client ID / client secret | `OAUTH2_CLIENT_CREDENTIALS` |
| `perf-oauth-token-url` | Secret text | the token URL | `OAUTH2_CLIENT_CREDENTIALS` |
| `perf-oauth-scope` | Secret text | the scope | `OAUTH2_CLIENT_CREDENTIALS` |
| `perf-basic-auth` | Username with password | username / password | `BASIC` |
| `perf-smtp` | Username with password | SMTP user / SMTP password | report email (skipped with a warning if missing) |

### Step 3.4: Set the non-secret SMTP settings

Open the `Jenkinsfile` and check the `environment` block (committed defaults are for Gmail):

```groovy
SMTP_HOST = 'smtp.gmail.com'
SMTP_PORT = '465'
SMTP_TLS  = 'ssl'
```

- `SMTP_FROM` defaults to the SMTP user. To set it, add `SMTP_FROM = '<address>'` to the same block.
- Optional fixed recipients: define `MANDATORY_RECIPIENTS` (comma separated) as a **global environment variable** (Manage Jenkins -> System -> Global properties).

### Step 3.5: Create the job

1. **New Item -> Pipeline.**
2. Under *Pipeline*, choose **Pipeline script from SCM -> Git**.
3. Repository URL: this tooling repo (add a credential if it is private). Branch: `*/main`. **Script Path: `Jenkinsfile`.**
4. Save.

### Step 3.6: Run it

1. The **first** build only registers the parameters and may fail validation. That is expected.
2. From the second run use **Build with Parameters**:

   | Parameter | Value |
   |---|---|
   | `apiRepoUrl` | Clone URL of your **public** API repo |
   | `apiRepoBranch` | Branch to clone (default `main`) |
   | `apiRepoCredentialsId` | Leave empty for a public repo |
   | `apiName` | Folder of the profile in the API repo, case-sensitive (empty = repo root) |
   | `profileName` | JSON file name, e.g. `load-profile.json` |
   | `reportRecipient` | Comma separated addresses |
   | `reportCc` | Empty for no Cc |
   | `debug` | `false` |

3. The report is the build artifact **`api-repo/report.html`** and arrives by email.

> [!NOTE]
> Jenkins' default Content-Security-Policy blocks scripts in archived HTML, so the report does not render on the build page. **Download it** or open the email attachment. Do not weaken the CSP. Builds are serialised (`disableConcurrentBuilds`), so two load tests never run at the same time.

### Step 3.7 (optional): A Jenkins job owned by an API team

Copy `templates/Jenkinsfile` into the API repo and fill in its `environment` block (`PERF_JOB_NAME`, `API_REPO_URL`, `API_NAME`, `PROFILE_NAME`, `REPORT_RECIPIENT`). It only calls the central job with those values, so test logic, credentials and email stay in one place. Create a Pipeline job for that repo (*Pipeline script from SCM*).

---

## Part 4: Email (SMTP)

The pipeline sends the report with `send-email.py` over SMTP.

### Step 4.1: Get the SMTP values

| Provider | Host | Port | `SMTP_TLS` | User / password |
|---|---|---|---|---|
| Gmail | `smtp.gmail.com` | `465` | `ssl` | Your address / an **app password** (Google account -> Security -> 2-Step Verification -> App passwords) |
| SendGrid | `smtp.sendgrid.net` | `587` | `false` | `apikey` / your API key |
| Other | the provider's host | `587` (STARTTLS) or `465` (SSL) | `ssl` for 465 | per provider |

Rule used by the script: port `465`, or `SMTP_TLS` set to `ssl` or `true`, uses implicit SSL; anything else uses STARTTLS.

### Step 4.2: Store the values

| Setting | Azure DevOps (`perf-smtp` group) | Jenkins |
|---|---|---|
| Host | `SMTP_HOST` | `environment` block of the `Jenkinsfile` |
| Port | `SMTP_PORT` | `environment` block |
| TLS mode | `SMTP_TLS` | `environment` block |
| User | `SMTP_USER` | `perf-smtp` credential (username) |
| Password | `SMTP_PASS` (secret) | `perf-smtp` credential (password) |
| From address | `SMTP_FROM` | optional `SMTP_FROM` in the `environment` block (defaults to the SMTP user) |
| Fixed recipients | optional `MANDATORY_RECIPIENTS` | optional global environment variable `MANDATORY_RECIPIENTS` |

### Step 4.3: Recipients

- `reportRecipient` (run parameter): who receives the email.
- `MANDATORY_RECIPIENTS` (optional): always added to the recipients. Empty by default.
- `reportCc` (run parameter): optional Cc (Azure DevOps uses `none` for no Cc).
- An address that appears twice is sent once. Use commas or semicolons between addresses.

### Step 4.4: Test the email on its own (optional)

From a machine with Python 3, send a test mail without running a load test. The SMTP password is read from an environment variable, never from the command line:

```bash
export SMTP_HOST=smtp.gmail.com SMTP_PORT=465 SMTP_TLS=ssl SMTP_USER=you@example.com
read -s -p "SMTP password: " SMTP_PASSWORD && export SMTP_PASSWORD
python send-email.py --to you@example.com --report no-such-report.html --status PASSED --detail "SMTP test" --subject "SMTP test"
```

```powershell
$env:SMTP_HOST="smtp.gmail.com"; $env:SMTP_PORT="465"; $env:SMTP_TLS="ssl"; $env:SMTP_USER="you@example.com"
$env:SMTP_PASSWORD = Read-Host "SMTP password"
python send-email.py --to you@example.com --report no-such-report.html --status PASSED --detail "SMTP test" --subject "SMTP test"
```

You should see `Email report sent successfully!`. The email says that no report was produced, which is expected here. A send failure prints `Error sending email: ...` and does not fail a pipeline build.

---

## Part 5: Verify the Installation

Run one smoke test that needs no credentials:

1. In your **public API repo**, add a folder (e.g. `smoke`) with the file `templates/load-profile-batch.json` from this repo (two public `httpbin.org` GET calls).
2. Run the pipeline with `apiName = smoke` and `profileName = load-profile-batch.json`, and your own address as recipient.
3. Check the outcome:

   | Check | Expected |
   |---|---|
   | Build | Green |
   | k6 step log | Ends with the summary and `k6 exit code: 0` |
   | Email | Subject `[PASSED] Performance Test Report - Parallel-Batch-StressTest - Version 1.0.0`, with `report.html` attached |
   | Report | Opens in a browser, shows 2 endpoints, status `PASSED` |

4. To verify the credential handling, run once with a profile that uses wrong credentials. Expected: build **red**, email `[FAILED]` with a `CREDENTIALS_REJECTED` reason, one request per endpoint.

If something fails, use the troubleshooting table in [README.md](README.md), section 12.

---

## Part 6: Optional Extras

### 6.1 A private API repository

The supported setup is a public API repo. If you must use a private one:

- **Azure DevOps:** create a read-only GitHub token (fine-grained, only the repos it must read, permission *Contents: Read-only*, with an expiry) and store it as the secret variable `GITHUB_PAT` in the `perf-client-id` group. Without it the clone is anonymous.
- **Jenkins:** create a *Username with password* credential (any user + a read-only access token) and put its ID in the `apiRepoCredentialsId` parameter. A private **tooling** repo also needs a credential, selected in the job's *Pipeline script from SCM* settings.

### 6.2 Pin the versions

- **Jenkins:** `K6_IMAGE = 'grafana/k6:latest'` in the `environment` block. Pin it to a tested version (e.g. `grafana/k6:1.x.y`). `EMAIL_IMAGE` is `python:3.12-alpine`.
- **Azure DevOps:** the image defaults to `grafana/k6` (`ci/run-k6.sh` reads the `K6_IMAGE` environment variable). To pin it, pass `K6_IMAGE: grafana/k6:1.x.y` in the `env:` of the "Execute k6 Stress Test Container" step in `k6-pipeline-job-template.yml`.

### 6.3 Run a profile locally

See [README.md](README.md), section 11 (`run-local.ps1` / `run-local.sh`).

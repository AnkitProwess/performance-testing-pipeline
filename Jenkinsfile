// Jenkinsfile
// MASTER MANUAL RUNNER: create ONE Jenkins "Pipeline" job with "Pipeline script from SCM" pointing at this repo.
// Nothing triggers it automatically: a user runs "Build with Parameters" and says where the load profile lives.
//
// Agent requirements: Linux, git and docker only. k6 and the email script both run in containers.
// Shared with Azure DevOps (see README.md): k6-engine-script.js, auth/, send-email.py, ci/run-k6.sh, ci/status.sh.
// Credentials (Manage Jenkins > Credentials). Any that do not exist are skipped, so create only what your profiles use:
//   perf-client-id        Username with password   CLIENT_ID / CLIENT_SECRET              authType CLIENT_ID_ENFORCEMENT
//   perf-oauth-client     Username with password   OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET  authType OAUTH2_CLIENT_CREDENTIALS
//   perf-oauth-token-url  Secret text              OAUTH_TOKEN_URL                        authType OAUTH2_CLIENT_CREDENTIALS
//   perf-oauth-scope      Secret text              OAUTH_SCOPE                            authType OAUTH2_CLIENT_CREDENTIALS
//   perf-basic-auth       Username with password   BASIC_USERNAME / BASIC_PASSWORD        authType BASIC
//   perf-smtp             Username with password   SMTP_USER / SMTP_PASSWORD              report email (skipped with a warning if missing)
// A private API repo uses the apiRepoCredentialsId parameter (Username with password: any user + a personal access token).

// True when the credential exists and is of the expected type. Probes with an empty body, so a failing step is never swallowed.
boolean credentialUsable(String id, String kind) {
    try {
        if (kind == 'userpass') {
            withCredentials([usernamePassword(credentialsId: id, usernameVariable: 'PROBE_U', passwordVariable: 'PROBE_P')]) { }
        } else {
            withCredentials([string(credentialsId: id, variable: 'PROBE_S')]) { }
        }
        return true
    } catch (org.jenkinsci.plugins.workflow.steps.FlowInterruptedException e) {
        throw e // build aborted or timed out: never treat as "credential missing"
    } catch (Exception e) {
        echo "Credential '${id}' not usable, skipping it: ${e.message}"
        return false
    }
}

// Builds the withCredentials binding list from the credentials that exist
List credentialBindings(List specs) {
    List bindings = []
    for (spec in specs) {
        if (!credentialUsable(spec.id, spec.kind)) {
            continue
        }
        if (spec.kind == 'userpass') {
            bindings << usernamePassword(credentialsId: spec.id, usernameVariable: spec.user, passwordVariable: spec.pass)
        } else {
            bindings << string(credentialsId: spec.id, variable: spec.variable)
        }
    }
    return bindings
}

pipeline {
    agent any // restrict to your Docker-capable Linux agents, e.g. agent { label 'linux && docker' }

    options {
        skipDefaultCheckout(true)
        disableConcurrentBuilds() // two load tests from one setup would distort each other's results
        timeout(time: 2, unit: 'HOURS')
        buildDiscarder(logRotator(numToKeepStr: '30', artifactNumToKeepStr: '30'))
        timestamps()
    }

    parameters {
        string(name: 'apiRepoUrl', defaultValue: 'https://github.com/AnkitProwess/sample-api.git', description: 'Target API Git repo URL (holds the load profile JSON files)')
        string(name: 'apiRepoBranch', defaultValue: 'main', description: 'Branch of the API repo')
        string(name: 'apiRepoCredentialsId', defaultValue: '', description: 'Jenkins credentials ID for a PRIVATE API repo (Username with password: any user + access token). Leave empty for a public repo')
        string(name: 'apiName', defaultValue: 'AI_innovation_poc1', description: 'API name = folder name in the API repo, case-sensitive (empty = repo root)')
        string(name: 'profileName', defaultValue: 'load-profile3.json', description: 'Profile name = JSON file name inside that folder')
        string(name: 'reportRecipient', defaultValue: 'ankit.kumar@prowesssoft.com', description: 'Email report recipient(s), comma separated')
        booleanParam(name: 'debug', defaultValue: false, description: 'Enable k6 HTTP debugging (writes request/response headers, including credentials and tokens, to the console log)')
    }

    environment {
        K6_IMAGE = 'grafana/k6:latest' // pin to a tested version (e.g. grafana/k6:1.x.y) once you have one
        EMAIL_IMAGE = 'python:3.12-alpine'
        // Non-secret SMTP settings (Gmail). SMTP_FROM defaults to SMTP_USER; the secrets come from the perf-smtp credential.
        SMTP_HOST = 'smtp.gmail.com'
        SMTP_PORT = '465'
        SMTP_TLS = 'ssl'
    }

    stages {
        stage('Validate Parameters') {
            steps {
                script {
                    String apiRepoUrl = (params.apiRepoUrl ?: '').trim()
                    String apiRepoBranch = (params.apiRepoBranch ?: '').trim()
                    String apiName = (params.apiName ?: '').trim()
                    String profileName = (params.profileName ?: '').trim() ?: 'load-profile.json'
                    String recipients = (params.reportRecipient ?: '').trim()

                    // Parameters are free text that ends up in file paths and shell commands, so reject anything unexpected up front.
                    if (!(apiRepoUrl ==~ /^(https:\/\/|ssh:\/\/|git@)\S+$/)) {
                        error("apiRepoUrl must start with https://, ssh:// or git@ and contain no spaces: '${apiRepoUrl}'")
                    }
                    if (!(apiRepoBranch ==~ /^[A-Za-z0-9._\/-]+$/) || apiRepoBranch.contains('..')) {
                        error("apiRepoBranch has unexpected characters: '${apiRepoBranch}'")
                    }
                    if (!(apiName ==~ /^([A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*)?$/) || apiName.contains('..')) {
                        error("apiName must be a folder path such as 'AI_innovation_poc1' (letters, digits, _ . - and /): '${apiName}'")
                    }
                    if (!(profileName ==~ /^[A-Za-z0-9_.-]+\.json$/) || profileName.contains('..')) {
                        error("profileName must be a plain JSON file name such as 'load-profile3.json': '${profileName}'")
                    }
                    for (String address : recipients.split(/[,;]/)) {
                        if (address.trim() && !(address.trim() ==~ /^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
                            error("reportRecipient contains an invalid address: '${address.trim()}'")
                        }
                    }

                    env.PROFILE_REL = apiName ? "${apiName}/${profileName}" : profileName // relative to the API repo root
                    env.REPORT_RECIPIENT = recipients.replace(';', ',')
                    env.K6_HTTP_DEBUG = params.debug ? 'true' : 'false'
                    currentBuild.description = env.PROFILE_REL
                }
            }
        }

        stage('Checkout Tooling') {
            steps {
                deleteDir() // fresh workspace: no stale report.html or clone from a previous run
                dir('master-pipeline-repo') {
                    checkout scm
                }
            }
        }

        stage('Fetch API Load Configuration') {
            steps {
                dir('api-repo') {
                    checkout([
                        $class: 'GitSCM',
                        branches: [[name: "*/${params.apiRepoBranch.trim()}"]],
                        userRemoteConfigs: [[url: params.apiRepoUrl.trim(), credentialsId: (params.apiRepoCredentialsId ?: '').trim()]],
                        extensions: [[$class: 'CloneOption', shallow: true, depth: 1, noTags: true]]
                    ])
                }
            }
        }

        stage('Prepare Engine Script') {
            steps {
                // The engine and its auth modules (auth/) must sit next to the profile: k6 resolves imports relative to the engine script inside the /apps mount
                sh '''
                    cp master-pipeline-repo/k6-engine-script.js api-repo/
                    cp -r master-pipeline-repo/auth api-repo/
                    if [ ! -f "api-repo/$PROFILE_REL" ]; then
                        echo "Load profile not found in the API repo: $PROFILE_REL"
                        echo "Check apiName (folder, case-sensitive), profileName and apiRepoBranch."
                        exit 1
                    fi
                '''
            }
        }

        stage('Execute k6 Stress Test') {
            steps {
                script {
                    List bindings = credentialBindings([
                        [id: 'perf-client-id',       kind: 'userpass', user: 'CLIENT_ID',        pass: 'CLIENT_SECRET'],
                        [id: 'perf-oauth-client',    kind: 'userpass', user: 'OAUTH_CLIENT_ID',  pass: 'OAUTH_CLIENT_SECRET'],
                        [id: 'perf-oauth-token-url', kind: 'string',   variable: 'OAUTH_TOKEN_URL'],
                        [id: 'perf-oauth-scope',     kind: 'string',   variable: 'OAUTH_SCOPE'],
                        [id: 'perf-basic-auth',      kind: 'userpass', user: 'BASIC_USERNAME',   pass: 'BASIC_PASSWORD'],
                    ])
                    withCredentials(bindings) {
                        // Do not fail the stage on a k6 failure: the report and email must still go out. The exit code is recorded and enforced in the last stage.
                        // The docker command and the credential variable list live in ci/run-k6.sh (shared with Azure DevOps).
                        // The credentials are bound as environment variables above and passed to the container by name only.
                        int rc = sh(returnStatus: true, script: 'bash master-pipeline-repo/ci/run-k6.sh "$WORKSPACE/api-repo" "$PROFILE_REL" "$K6_HTTP_DEBUG"')
                        env.K6_EXIT_CODE = "${rc}"
                        currentBuild.description = "${env.PROFILE_REL} - k6 exit ${rc}"
                    }
                }
            }
        }

        stage('Archive Report and Email') {
            steps {
                archiveArtifacts artifacts: 'api-repo/report.html', allowEmptyArchive: true // no report exists when k6 failed before the load started

                // A delivery problem must not hide the test result: mark the build UNSTABLE and carry on to the final check
                catchError(buildResult: 'UNSTABLE', stageResult: 'UNSTABLE', message: 'Report email could not be sent') {
                    script {
                        List bindings = credentialBindings([
                            [id: 'perf-smtp', kind: 'userpass', user: 'SMTP_USER', pass: 'SMTP_PASSWORD'],
                        ])
                        withCredentials(bindings) {
                            sh '''
                                # PASSED / FAILED (+ detail line): one rule shared with Azure DevOps (ci/status.sh)
                                STATUS=$(sh master-pipeline-repo/ci/status.sh "$K6_EXIT_CODE")
                                DETAIL=$(sh master-pipeline-repo/ci/status.sh "$K6_EXIT_CODE" detail)
                                echo "Sending report email for $PROFILE_REL, status: $STATUS"

                                # send-email.py runs in a container, so the agent needs no Python. Secrets are passed by name only.
                                # Optional: define MANDATORY_RECIPIENTS (comma separated) as a Jenkins global environment variable to always CC a fixed list.
                                docker run --rm \
                                    --user "$(id -u):$(id -g)" \
                                    -v "$WORKSPACE:/work:ro" \
                                    -e PYTHONDONTWRITEBYTECODE=1 \
                                    -e SMTP_HOST \
                                    -e SMTP_PORT \
                                    -e SMTP_TLS \
                                    -e SMTP_USER \
                                    -e SMTP_PASSWORD \
                                    -e SMTP_FROM \
                                    -e MANDATORY_RECIPIENTS \
                                    -e JOB_NAME \
                                    -e BUILD_NUMBER \
                                    "$EMAIL_IMAGE" python /work/master-pipeline-repo/send-email.py \
                                        --to "$REPORT_RECIPIENT" \
                                        --profile "/work/api-repo/$PROFILE_REL" \
                                        --status "$STATUS" \
                                        --detail "$DETAIL" \
                                        --report /work/api-repo/report.html \
                                        --build-url "$BUILD_URL"
                            '''
                        }
                    }
                }
            }
        }

        // Decide the build result after the report and email have gone out.
        //   exit 0  = green.
        //   exit 99 = SLA MISSED (thresholds crossed): the build stays SUCCESS but this stage turns yellow, and the email is PASSED with an "SLA MISSED" message.
        //   other   = the test could not run (rejected credentials = 108, setup/script error = 107, bad profile ...): the build fails.
        stage('Check Test Execution') {
            steps {
                script {
                    if (env.K6_EXIT_CODE == '0') {
                        echo 'k6 passed all thresholds.'
                    } else if (env.K6_EXIT_CODE == '99') {
                        // Green with a warning: the build result stays SUCCESS, but this stage turns yellow and the build description says why
                        currentBuild.description = "${env.PROFILE_REL} - SLA MISSED (k6 exit 99)"
                        catchError(buildResult: 'SUCCESS', stageResult: 'UNSTABLE', message: 'SLA MISSED: k6 thresholds were crossed') {
                            error('WARNING: SLA MISSED, k6 thresholds were crossed (exit code 99). See the report; the build is not failed for SLA misses.')
                        }
                    } else {
                        String detail = sh(returnStdout: true, script: 'sh master-pipeline-repo/ci/status.sh "$K6_EXIT_CODE" detail').trim()
                        error("${detail} (k6 exit code ${env.K6_EXIT_CODE})")
                    }
                }
            }
        }
    }
}

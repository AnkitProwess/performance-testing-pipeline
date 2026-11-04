#!/bin/sh
# One rule for turning a k6 exit code into a result, shared by the Azure DevOps and Jenkins pipelines.
#
# Usage:  sh ci/status.sh <k6-exit-code> [label|detail]      (default: label)
#
#   exit  label        build                      meaning
#   0     PASSED       green                      all thresholds met
#   99    PASSED       green + warning            the test ran, but a latency / error threshold was crossed (the detail line says "SLA MISSED")
#   other FAILED       red                        the test could not run (credentials, profile, script error)
#
# "FAILED" is deliberately kept for runs that could not execute. An SLA miss is shown as PASSED (the test itself worked) with an "SLA MISSED" message.

code="${1:?k6 exit code missing}"
mode="${2:-label}"

case "$code" in
  0)   label="PASSED";     detail="All thresholds were met." ;;
  99)  label="PASSED";     detail="SLA MISSED: the test ran, but one or more SLA thresholds (latency / error rate) were crossed. See the attached report." ;;
  108) label="FAILED";     detail="The test was aborted because the API rejected the credentials (HTTP 401/403). Check the credentials in the pipeline." ;;
  107) label="FAILED";     detail="The test could not start (script or authentication setup error, e.g. wrong OAuth secret or an unresolved variable). No load was generated." ;;
  *)   label="FAILED";     detail="The test could not complete (k6 exit code $code). Check the k6 step log: credentials, profile or endpoint." ;;
esac

if [ "$mode" = "detail" ]; then echo "$detail"; else echo "$label"; fi

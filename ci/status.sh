#!/bin/sh
# One rule for turning a k6 exit code into a result, shared by the Azure DevOps and Jenkins pipelines.
#
# Usage:  sh ci/status.sh <k6-exit-code> [label|detail] [reason-file]      (default mode: label)
#
#   exit  label    build                meaning
#   0     PASSED   green                all thresholds met
#   99    PASSED   green + warning      the test ran, but a latency / error threshold was crossed (the detail says "SLA MISSED")
#   other FAILED   red                  the test could not run
#
# "FAILED" is reserved for runs that could not execute. An SLA miss is shown as PASSED (the test itself worked) with an "SLA MISSED" message.
#
# Why a run failed: the same exit code can have several causes (108 = the engine stopped the run, for rejected credentials OR because nothing ever
# succeeded; 107 = any setup / script error). So the exact reason is NOT guessed from the exit code. The engine states it itself in
# <reason-file> (written by ci/run-k6.sh from the line "PERF_REASON|<CODE>|<text>"), and that text is used when present. Without it, the detail says
# only what the exit code proves and points to the k6 log.

code="${1:?k6 exit code missing}"
mode="${2:-label}"
reason_file="${3:-}"

case "$code" in
  0)   label="PASSED";     detail="All thresholds were met." ;;
  99)  label="PASSED";     detail="SLA MISSED: the test ran, but one or more SLA thresholds (latency / error rate) were crossed. See the attached report." ;;
  107) label="FAILED";     detail="The test could not start or crashed with a script error. The reason was not captured; see the k6 step log." ;;
  108) label="FAILED";     detail="The test was stopped early by the engine. The reason was not captured; see the k6 step log." ;;
  125|126|127)
       label="FAILED";     detail="Docker could not start the k6 container (exit code $code). Check that Docker is available on the agent; see the step log." ;;
  137) label="FAILED";     detail="The k6 process was killed (exit code 137), which usually means the agent ran out of memory. See the step log." ;;
  *)   label="FAILED";     detail="The test could not complete (exit code $code). The reason was not captured; see the k6 step log." ;;
esac

# A reason stated by the engine is exact, so it replaces the generic text. It is only used for runs that did not complete normally.
if [ "$code" != "0" ] && [ "$code" != "99" ] && [ -n "$reason_file" ] && [ -s "$reason_file" ]; then
  reason=$(head -n 1 "$reason_file" | cut -d'|' -f3-)
  [ -n "$reason" ] && detail="$reason"
fi

if [ "$mode" = "detail" ]; then echo "$detail"; else echo "$label"; fi

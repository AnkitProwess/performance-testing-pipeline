#!/bin/bash
# run-local.sh
# Script to simulate the master pipeline locally on Unix/macOS.

set -e

PROFILE_TYPE=${1:-"basic"}
RUNNER=${2:-"auto"}

echo "=== Local Performance Test Simulator ==="

# Resolve script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# 1. Resolve Profile path
if [ "$PROFILE_TYPE" = "basic" ]; then
    PROFILE_SOURCE="$SCRIPT_DIR/templates/load-profile.json"
elif [ "$PROFILE_TYPE" = "advanced" ]; then
    PROFILE_SOURCE="$SCRIPT_DIR/templates/load-profile-advanced.json"
else
    if [ -f "$PROFILE_TYPE" ]; then
        PROFILE_SOURCE=$(realpath "$PROFILE_TYPE")
    else
        echo "Error: Profile path '$PROFILE_TYPE' does not exist."
        exit 1
    fi
fi

echo "Using load profile: $PROFILE_SOURCE"

# 2. Setup local-run workspace folder
RUN_DIR="$SCRIPT_DIR/local-run"
rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"

# Copy files to simulate the cloned repository structure
cp "$PROFILE_SOURCE" "$RUN_DIR/load-profile.json"
cp "$SCRIPT_DIR/k6-engine-script.js" "$RUN_DIR/k6-engine-script.js"
cp -r "$SCRIPT_DIR/auth" "$RUN_DIR/auth"

# 3. Detect Runner
RESOLVED_RUNNER=$RUNNER
if [ "$RESOLVED_RUNNER" = "auto" ]; then
    if command -v docker &> /dev/null; then
        RESOLVED_RUNNER="docker"
    elif command -v k6 &> /dev/null; then
        RESOLVED_RUNNER="k6"
    else
        echo "Error: Neither Docker nor k6 command-line tool was found. Please install one of them to run tests locally."
        exit 1
    fi
fi

# 4. Run Stress Test
echo "Running performance test using runner: $RESOLVED_RUNNER"

REPORT_PATH="$RUN_DIR/report.html"

if [ "$RESOLVED_RUNNER" = "docker" ]; then
    # Mount local-run dir
    docker run --rm \
      --user "$(id -u):$(id -g)" \
      -v "$RUN_DIR:/apps" \
      -e K6_WEB_DASHBOARD=true \
      -e K6_WEB_DASHBOARD_EXPORT=/apps/report.html \
      grafana/k6 run /apps/k6-engine-script.js
      
elif [ "$RESOLVED_RUNNER" = "k6" ]; then
    # Run using local k6 binary
    export K6_WEB_DASHBOARD=true
    export K6_WEB_DASHBOARD_EXPORT="$REPORT_PATH"
    
    cd "$RUN_DIR"
    k6 run k6-engine-script.js
    
    unset K6_WEB_DASHBOARD
    unset K6_WEB_DASHBOARD_EXPORT
fi

# 5. Check Output
if [ -f "$REPORT_PATH" ]; then
    echo -e "\n[SUCCESS] Performance test completed successfully!"
    echo "Local HTML report generated at: $REPORT_PATH"
    echo "You can open this file in your browser to view the interactive dashboard."
else
    echo -e "\n[WARNING] Performance test executed, but report.html was not generated."
fi

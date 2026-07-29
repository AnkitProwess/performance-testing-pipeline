# run-local.ps1
# Script to simulate the master pipeline locally for verification and testing.

param(
    [string]$ProfileType = "basic", # "basic", "advanced", or path to a custom json file
    [string]$Runner = "auto"        # "auto", "docker", or "k6"
)

$ErrorActionPreference = "Stop"

Write-Host "=== Local Performance Test Simulator ===" -ForegroundColor Cyan

# 1. Resolve Profile path
$profileSource = ""
if ($ProfileType -eq "basic") {
    $profileSource = Join-Path $PSScriptRoot "templates\load-profile.json"
} elseif ($ProfileType -eq "advanced") {
    $profileSource = Join-Path $PSScriptRoot "templates\load-profile-advanced.json"
} else {
    if (Test-Path $ProfileType) {
        $profileSource = Resolve-Path $ProfileType
    } else {
        Write-Error "Profile path '$ProfileType' does not exist."
    }
}

Write-Host "Using load profile: $profileSource" -ForegroundColor Gray

# 2. Setup local-run workspace folder
$runDir = Join-Path $PSScriptRoot "local-run"
if (Test-Path $runDir) {
    Remove-Item $runDir -Recurse -Force | Out-Null
}
New-Item -ItemType Directory -Path $runDir | Out-Null

# Copy files to simulate the cloned repository structure
Copy-Item $profileSource (Join-Path $runDir "load-profile.json")
Copy-Item (Join-Path $PSScriptRoot "k6-engine-script.js") (Join-Path $runDir "k6-engine-script.js")

# 3. Detect Runner
$resolvedRunner = $Runner
if ($resolvedRunner -eq "auto") {
    # Check if docker is available
    $dockerCheck = Get-Command docker -ErrorAction SilentlyContinue
    $k6Check = Get-Command k6 -ErrorAction SilentlyContinue

    if ($dockerCheck) {
        $resolvedRunner = "docker"
    } elseif ($k6Check) {
        $resolvedRunner = "k6"
    } else {
        Write-Error "Neither Docker nor k6 command-line tool was found. Please install one of them to run tests locally."
    }
}

# 4. Run Stress Test
Write-Host "Running performance test using runner: $resolvedRunner" -ForegroundColor Yellow

$reportPath = Join-Path $runDir "report.html"

if ($resolvedRunner -eq "docker") {
    # On Windows, docker volumes require absolute paths. We need to convert the path to a format docker understands.
    # Convert local-run dir to absolute path
    $absoluteRunDir = (Resolve-Path $runDir).Path
    Write-Host "Mounting directory: $absoluteRunDir" -ForegroundColor Gray
    
    docker run --rm `
      -v "${absoluteRunDir}:/apps" `
      -e K6_WEB_DASHBOARD=true `
      -e K6_WEB_DASHBOARD_EXPORT=/apps/report.html `
      grafana/k6 run /apps/k6-engine-script.js
      
} elseif ($resolvedRunner -eq "k6") {
    # Run using local k6 binary
    # For local k6 binary, we can set env variables
    $env:K6_WEB_DASHBOARD = "true"
    $env:K6_WEB_DASHBOARD_EXPORT = $reportPath
    
    Push-Location $runDir
    try {
        k6 run k6-engine-script.js
    } finally {
        Pop-Location
        # Clear environment variables
        Remove-Item Env:\K6_WEB_DASHBOARD -ErrorAction SilentlyContinue
        Remove-Item Env:\K6_WEB_DASHBOARD_EXPORT -ErrorAction SilentlyContinue
    }
}

# 5. Check Output
if (Test-Path $reportPath) {
    Write-Host "`n[SUCCESS] Performance test completed successfully!" -ForegroundColor Green
    Write-Host "Local HTML report generated at: $reportPath" -ForegroundColor Green
    Write-Host "You can open this file in your browser to view the interactive dashboard." -ForegroundColor Gray
} else {
    Write-Host "`n[WARNING] Performance test executed, but report.html was not generated." -ForegroundColor Yellow
}

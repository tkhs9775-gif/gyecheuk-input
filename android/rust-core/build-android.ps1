$ErrorActionPreference = "Stop"
$CoreDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$JniDir = Join-Path (Split-Path -Parent $CoreDir) "app\src\main\jniLibs"

Push-Location $CoreDir
try {
    Write-Host "[1/2] Building arm64-v8a (aarch64-linux-android)..." -ForegroundColor Cyan
    cargo build --release --target aarch64-linux-android
    if ($LASTEXITCODE -ne 0) { throw "aarch64 build failed" }

    $Arm64Out = Join-Path $JniDir "arm64-v8a"
    New-Item -ItemType Directory -Force -Path $Arm64Out | Out-Null
    Copy-Item "target\aarch64-linux-android\release\libgyecheuk_core.so" (Join-Path $Arm64Out "libgyecheuk_core.so") -Force

    Write-Host "[2/2] Building x86_64 (x86_64-linux-android)..." -ForegroundColor Cyan
    cargo build --release --target x86_64-linux-android
    if ($LASTEXITCODE -ne 0) { throw "x86_64 build failed" }

    $X64Out = Join-Path $JniDir "x86_64"
    New-Item -ItemType Directory -Force -Path $X64Out | Out-Null
    Copy-Item "target\x86_64-linux-android\release\libgyecheuk_core.so" (Join-Path $X64Out "libgyecheuk_core.so") -Force

    Write-Host "Done! jniLibs updated at: $JniDir" -ForegroundColor Green
} finally {
    Pop-Location
}

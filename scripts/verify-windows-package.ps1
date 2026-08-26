param(
    [Parameter(Mandatory = $true)]
    [string]$BundleDir
)

$ErrorActionPreference = "Stop"

$bundleRoot = (Resolve-Path -LiteralPath $BundleDir).Path
$installers = @(Get-ChildItem -LiteralPath $bundleRoot -Filter "*-setup.exe" -File)
if ($installers.Count -ne 1) {
    throw "Expected exactly one NSIS installer in $bundleRoot, found $($installers.Count)"
}

$runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
$installDir = [System.IO.Path]::GetFullPath(
    (Join-Path $runnerTemp "pdf-reader-translate-smoke")
)
$smokeLogDir = [System.IO.Path]::GetFullPath(
    (Join-Path $runnerTemp "pdf-reader-translate-smoke-logs")
)
if (-not $installDir.StartsWith($runnerTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use install directory outside RUNNER_TEMP: $installDir"
}

$appProcess = $null
$installer = $installers[0].FullName

function Copy-DiagnosticLogs {
    New-Item -ItemType Directory -Force -Path $smokeLogDir | Out-Null
    $source = Join-Path $env:LOCALAPPDATA "PDF Reader Translate"
    if (Test-Path -LiteralPath $source) {
        Get-ChildItem -LiteralPath $source -Filter "*.log" -File -ErrorAction SilentlyContinue |
            ForEach-Object {
                Copy-Item -LiteralPath $_.FullName -Destination $smokeLogDir -Force
            }
    }
}

function Stop-InstalledProcesses {
    if ($null -ne $appProcess -and -not $appProcess.HasExited) {
        Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ExecutablePath -and
            $_.ExecutablePath.StartsWith(
                $installDir,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
}

try {
    if (Test-Path -LiteralPath $installDir) {
        Remove-Item -LiteralPath $installDir -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null

    Write-Host "Installing $installer into $installDir"
    # Start-Process 对字符串数组会重新拼接参数；NSIS 的 /D= 必须作为最后一段原样传入。
    $install = Start-Process -FilePath $installer -ArgumentList "/S /D=$installDir" -Wait -PassThru
    if ($install.ExitCode -ne 0) {
        throw "NSIS installer exited with code $($install.ExitCode)"
    }

    $mainExe = Join-Path $installDir "pdf-reader-translate.exe"
    $requiredFiles = @(
        $mainExe,
        (Join-Path $installDir "backend.exe"),
        (Join-Path $installDir "WebView2Loader.dll")
    )
    $requiredDirs = @(
        (Join-Path $installDir "_internal"),
        (Join-Path $installDir "_internal\pdf2zh"),
        (Join-Path $installDir "_internal\babeldoc"),
        (Join-Path $installDir "_internal\onnxruntime"),
        (Join-Path $installDir "_internal\cv2"),
        (Join-Path $installDir "_internal\pymupdf")
    )
    foreach ($path in $requiredFiles) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Installed package is missing required file: $path"
        }
    }
    foreach ($path in $requiredDirs) {
        if (-not (Test-Path -LiteralPath $path -PathType Container)) {
            throw "Installed package is missing required directory: $path"
        }
    }

    Write-Host "Package contents: ok"
    $appProcess = Start-Process -FilePath $mainExe -PassThru

    $health = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($appProcess.HasExited) {
            throw "Desktop process exited before backend health became ready"
        }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/api/health" -TimeoutSec 3
            if ($health.status -eq "ok") {
                break
            }
        }
        catch {
            # Backend cold start is expected to refuse connections briefly.
        }
        Start-Sleep -Seconds 1
    }
    if ($null -eq $health -or $health.status -ne "ok") {
        throw "Backend health check did not return { status: ok } within 60 seconds"
    }

    Write-Host "Installed desktop app and /api/health smoke: ok"
}
catch {
    Copy-DiagnosticLogs
    throw
}
finally {
    Stop-InstalledProcesses
    Start-Sleep -Milliseconds 500

    $uninstaller = Join-Path $installDir "uninstall.exe"
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
        Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $installDir) {
        Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

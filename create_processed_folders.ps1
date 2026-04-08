# ============================================================
# create_processed_folders.ps1
# Scans Z:\RAW for all date\object sessions and pre-creates
# the matching processed folder structure so PixInsight
# never has to create folders itself.
#
# Run this before astro_preprocess.js whenever you have
# sessions in RAW that haven't been processed yet.
# ============================================================

. "$PSScriptRoot\config.ps1"   # loads $NasRawRoot, $NasProcessedRoot, $ProcessedSubDirs

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Pre-create Processed Folders" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $NasRawRoot)) {
    Write-Host "ERROR: Cannot reach $NasRawRoot - is $NasDriveLetter mapped?" -ForegroundColor Red
    exit 1
}

$created  = 0
$sessions = 0

foreach ($dateFolder in Get-ChildItem -Path $NasRawRoot -Directory) {
    $dateSessions = [System.Collections.Generic.List[PSObject]]::new()

    foreach ($objectFolder in Get-ChildItem -Path $dateFolder.FullName -Directory) {
        $sessions++
        $rawName    = $objectFolder.Name
        $destName   = Sanitize-Name $(if ($FriendlyNames.ContainsKey($rawName)) { $FriendlyNames[$rawName] } else { $rawName })
        $sessionDir = Join-Path $NasProcessedRoot "$destName\$($dateFolder.Name)"
        $dateSessions.Add([PSCustomObject]@{ Object = $destName; Path = $sessionDir })

        foreach ($sub in $ProcessedSubDirs) {
            $full = Join-Path $sessionDir $sub
            if (-not (Test-Path $full)) {
                New-Item -ItemType Directory -Path $full -Force | Out-Null
                Write-Host "  Created: $full" -ForegroundColor Green
                $created++
            }
        }
    }

    if ($dateSessions.Count -gt 0) {
        $summaryPath = Join-Path $dateFolder.FullName "_processed_paths.txt"
        $lines = @(
            "# Processed locations for $($dateFolder.Name)",
            "# Generated $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
            ""
        )
        foreach ($s in $dateSessions) {
            $lines += "$($s.Object.PadRight(30)) $($s.Path)"
        }
        $lines | Set-Content -Path $summaryPath -Encoding UTF8
        Write-Host "  Written: $summaryPath" -ForegroundColor DarkCyan
    }
}

# ── Pre-create calibration folders ───────────────────────────
# Scans Z:\RAW\calibration\darks\<date>\<exp>s\ and flats\<date>\
# so PixInsight never needs to create folders on the network share.
$calibDarkRoot = Join-Path $NasCalibrationRoot "darks"
$calibFlatRoot = Join-Path $NasCalibrationRoot "flats"

if (Test-Path $calibDarkRoot) {
    foreach ($dateFolder in Get-ChildItem -Path $calibDarkRoot -Directory) {
        foreach ($expFolder in Get-ChildItem -Path $dateFolder.FullName -Directory) {
            # Dark raws land here — no sub-structure needed beyond the exp folder itself
            Write-Host "  Calibration dark folder exists: $($expFolder.FullName)" -ForegroundColor DarkGray
        }
    }
}

if (Test-Path $calibFlatRoot) {
    foreach ($dateFolder in Get-ChildItem -Path $calibFlatRoot -Directory) {
        Write-Host "  Calibration flat folder exists: $($dateFolder.FullName)" -ForegroundColor DarkGray
    }
}

if ($created -eq 0) {
    Write-Host "  All session folders already exist." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  Done. $sessions sessions, $created folders created." -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

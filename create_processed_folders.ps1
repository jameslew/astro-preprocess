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
    Write-Host "ERROR: Cannot reach $NasRawRoot — is $NasDriveLetter mapped?" -ForegroundColor Red
    exit 1
}

$created  = 0
$sessions = 0

foreach ($dateFolder in Get-ChildItem -Path $NasRawRoot -Directory) {
    foreach ($objectFolder in Get-ChildItem -Path $dateFolder.FullName -Directory) {
        $sessions++
        $sessionDir = Join-Path $NasProcessedRoot "$($objectFolder.Name)\$($dateFolder.Name)"
        foreach ($sub in $ProcessedSubDirs) {
            $full = Join-Path $sessionDir $sub
            if (-not (Test-Path $full)) {
                New-Item -ItemType Directory -Path $full -Force | Out-Null
                Write-Host "  Created: $full" -ForegroundColor Green
                $created++
            }
        }
    }
}

if ($created -eq 0) {
    Write-Host "  All folders already exist." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  Done. $sessions sessions, $created folders created." -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

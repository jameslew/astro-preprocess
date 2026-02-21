# ============================================================
# create_processed_folders.ps1
# Scans Z:\RAW for all date\object sessions and pre-creates
# the matching processed folder structure so PixInsight
# never has to create folders itself.
#
# Run this before astro_preprocess.js whenever you have
# sessions in RAW that haven't been processed yet.
# ============================================================

$NasRawRoot       = "Z:\RAW"
$NasProcessedRoot = "Z:\processed"

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Pre-create Processed Folders" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

$created = 0

foreach ($dateFolder in Get-ChildItem -Path $NasRawRoot -Directory) {
    foreach ($objectFolder in Get-ChildItem -Path $dateFolder.FullName -Directory) {
        $sessionDir = Join-Path $NasProcessedRoot "$($objectFolder.Name)\$($dateFolder.Name)"
        foreach ($sub in @("debayered", "registered", "master", "logs")) {
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
Write-Host "  Done. $created folders created." -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

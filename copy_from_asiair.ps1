# ============================================================
# copy_from_asiair.ps1
# Copies FITS subs from ASIAIR to NAS RAW folder,
# organized by capture date parsed from filename.
#
# Source:  \\asiair\EMMC Images\Plan\Light\<Object>\*.fit
# Dest:    Z:\RAW\<YYYY-MM-DD>\<Object>\*.fit
#
# Usage:   Run from PowerShell on your desktop.
#          .\copy_from_asiair.ps1
# ============================================================

. "$PSScriptRoot\config.ps1"   # loads $AsiairRoot, $NasRawRoot, $NasProcessedRoot, $ProcessedSubDirs

# ASIAIR guest access — no credentials needed
# If prompted, just hit Enter with blank password

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  ASIAIR → NAS Copy Script" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

# Verify ASIAIR is reachable
if (-not (Test-Path $AsiairRoot)) {
    Write-Host "ERROR: Cannot reach $AsiairRoot" -ForegroundColor Red
    Write-Host "Make sure you are on the same network as the ASIAIR and it is powered on." -ForegroundColor Yellow
    exit 1
}

# Verify NAS is mapped
if (-not (Test-Path $NasRawRoot)) {
    try {
        New-Item -ItemType Directory -Path $NasRawRoot -Force | Out-Null
    } catch {
        Write-Host "ERROR: Cannot reach $NasRawRoot — is $NasDriveLetter mapped?" -ForegroundColor Red
        exit 1
    }
}

# Filename pattern:
# Light_<ObjectName>_<Alt>deg_<ExpTime>s_Bin<N>_<YYYYMMDD><HHMMSS>.fit
# Example: Light_IC 434_74deg_120.0s_Bin1_20260119223045.fit
$filenameRegex = '^Light_.+_\d+deg_.+s_Bin\d+_(\d{4})(\d{2})(\d{2})\d{6}\.fit$'

$copiedCount  = 0
$skippedCount = 0
$errorCount   = 0

# Enumerate object folders
$objectFolders = Get-ChildItem -Path $AsiairRoot -Directory

if ($objectFolders.Count -eq 0) {
    Write-Host "No object folders found under $AsiairRoot" -ForegroundColor Yellow
    exit 0
}

foreach ($objectFolder in $objectFolders) {
    $objectName = $objectFolder.Name
    Write-Host "Processing object: $objectName" -ForegroundColor White

    # Only copy individual light frames (Light_*.fit).
    # ASIAIR also saves running in-camera stacks (Stacked*_*.fit) to the same
    # folder; those must be excluded or ImageIntegration rejects nearly every
    # frame due to wildly unequal PSF weights.
    $fitFiles = Get-ChildItem -Path $objectFolder.FullName -Filter "Light_*.fit" -File

    if ($fitFiles.Count -eq 0) {
        Write-Host "  No Light_*.fit files found, skipping." -ForegroundColor DarkGray
        continue
    }

    # Track all date sessions seen for this object (including already-copied files)
    # so processed folders are pre-created even when every file is skipped.
    $sessionsForObject = @{}

    foreach ($file in $fitFiles) {
        if ($file.Name -match $filenameRegex) {
            $year  = $Matches[1]
            $month = $Matches[2]
            $day   = $Matches[3]
            $dateStr = "$year-$month-$day"
        } else {
            # Fallback: use file's last write date
            $dateStr = $file.LastWriteTime.ToString("yyyy-MM-dd")
            Write-Host "  WARNING: Could not parse date from '$($file.Name)', using file date $dateStr" -ForegroundColor Yellow
        }

        $sessionsForObject[$dateStr] = $true  # record session regardless of copy outcome

        $destDir = Join-Path $NasRawRoot "$dateStr\$objectName"

        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }

        $destFile = Join-Path $destDir $file.Name

        if (Test-Path $destFile) {
            $skippedCount++
            continue  # Already copied
        }

        try {
            Copy-Item -Path $file.FullName -Destination $destFile
            Write-Host "  Copied: $($file.Name)  →  $destDir" -ForegroundColor Green
            $copiedCount++
        } catch {
            Write-Host "  ERROR copying $($file.Name): $_" -ForegroundColor Red
            $errorCount++
        }
    }

    # Pre-create the processed folder tree for every session date seen.
    # Done once per session (not per file) and covers skipped/already-copied files.
    foreach ($dateStr in $sessionsForObject.Keys) {
        $processedSessionDir = Join-Path $NasProcessedRoot "$objectName\$dateStr"
        foreach ($subDir in $ProcessedSubDirs) {
            $fullSubDir = Join-Path $processedSessionDir $subDir
            if (-not (Test-Path $fullSubDir)) {
                New-Item -ItemType Directory -Path $fullSubDir -Force | Out-Null
            }
        }
    }
}

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Done." -ForegroundColor Cyan
Write-Host "  Copied:  $copiedCount files" -ForegroundColor Green
Write-Host "  Skipped: $skippedCount files (already on NAS)" -ForegroundColor DarkGray
if ($errorCount -gt 0) {
    Write-Host "  Errors:  $errorCount files" -ForegroundColor Red
}
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

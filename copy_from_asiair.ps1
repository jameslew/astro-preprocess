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
    $objectName     = $objectFolder.Name
    $destObjectName = Sanitize-Name $(if ($FriendlyNames.ContainsKey($objectName)) { $FriendlyNames[$objectName] } else { $objectName })
    Write-Host "Processing object: $objectName" -ForegroundColor White
    if ($destObjectName -ne $objectName) {
        Write-Host "  → $destObjectName" -ForegroundColor DarkCyan
    }

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

        $destDir = Join-Path $NasRawRoot "$dateStr\$destObjectName"

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
        $processedSessionDir = Join-Path $NasProcessedRoot "$destObjectName\$dateStr"
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
Write-Host "  Lights Done." -ForegroundColor Cyan
Write-Host "  Copied:  $copiedCount files" -ForegroundColor Green
Write-Host "  Skipped: $skippedCount files (already on NAS)" -ForegroundColor DarkGray
if ($errorCount -gt 0) {
    Write-Host "  Errors:  $errorCount files" -ForegroundColor Red
}
Write-Host "=======================================" -ForegroundColor Cyan

# ── Copy Darks ───────────────────────────────────────────────
# Dark filename: Dark_<ExpTime>s_Bin<N>_<YYYYMMDD><HHMMSS>_<Alt>deg_<Seq>.fit
# Dest: Z:\RAW\calibration\darks\<YYYY-MM-DD>\<ExpTime>s\
Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Copying Darks" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan

$darkRegex   = '^Dark_(\d+(?:\.\d+)?)s_Bin\d+_(\d{4})(\d{2})(\d{2})\d{6}_.*\.fit$'
$darkCopied  = 0
$darkSkipped = 0
$darkErrors  = 0

if (Test-Path $AsiairDarkRoot) {
    $darkFiles = Get-ChildItem -Path $AsiairDarkRoot -Filter "Dark_*.fit" -File
    foreach ($file in $darkFiles) {
        if ($file.Name -match $darkRegex) {
            $expTime = $Matches[1]
            $dateStr = "$($Matches[2])-$($Matches[3])-$($Matches[4])"
        } else {
            $dateStr = $file.LastWriteTime.ToString("yyyy-MM-dd")
            $expTime = "unknown"
            Write-Host "  WARNING: Could not parse dark filename '$($file.Name)', using file date." -ForegroundColor Yellow
        }

        $destDir = Join-Path $NasCalibrationRoot "darks\$dateStr\$($expTime)s"
        if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }

        $destFile = Join-Path $destDir $file.Name
        if (Test-Path $destFile) { $darkSkipped++; continue }

        try {
            Copy-Item -Path $file.FullName -Destination $destFile
            Write-Host "  Copied dark: $($file.Name)  →  $destDir" -ForegroundColor Green
            $darkCopied++
        } catch {
            Write-Host "  ERROR copying dark $($file.Name): $_" -ForegroundColor Red
            $darkErrors++
        }
    }
} else {
    Write-Host "  No Autorun\Dark folder found on ASIAIR — skipping darks." -ForegroundColor DarkGray
}

Write-Host "  Darks — Copied: $darkCopied  Skipped: $darkSkipped$(if ($darkErrors -gt 0) { "  Errors: $darkErrors" })" -ForegroundColor Cyan

# ── Copy Flats ───────────────────────────────────────────────
# Flat filename: Flat_<ExpTime>ms_Bin<N>_<YYYYMMDD><HHMMSS>_<Alt>deg_<Seq>.fit
# Dest: Z:\RAW\calibration\flats\<YYYY-MM-DD>\
Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Copying Flats" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan

$flatRegex   = '^Flat_(\d+(?:\.\d+)?(?:ms|s))_Bin\d+_(\d{4})(\d{2})(\d{2})\d{6}_.*\.fit$'
$flatCopied  = 0
$flatSkipped = 0
$flatErrors  = 0

if (Test-Path $AsiairFlatRoot) {
    $flatFiles = Get-ChildItem -Path $AsiairFlatRoot -Filter "Flat_*.fit" -File
    foreach ($file in $flatFiles) {
        if ($file.Name -match $flatRegex) {
            $dateStr = "$($Matches[2])-$($Matches[3])-$($Matches[4])"
        } else {
            $dateStr = $file.LastWriteTime.ToString("yyyy-MM-dd")
            Write-Host "  WARNING: Could not parse flat filename '$($file.Name)', using file date." -ForegroundColor Yellow
        }

        $destDir = Join-Path $NasCalibrationRoot "flats\$dateStr"
        if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }

        $destFile = Join-Path $destDir $file.Name
        if (Test-Path $destFile) { $flatSkipped++; continue }

        try {
            Copy-Item -Path $file.FullName -Destination $destFile
            Write-Host "  Copied flat: $($file.Name)  →  $destDir" -ForegroundColor Green
            $flatCopied++
        } catch {
            Write-Host "  ERROR copying flat $($file.Name): $_" -ForegroundColor Red
            $flatErrors++
        }
    }
} else {
    Write-Host "  No Autorun\Flat folder found on ASIAIR — skipping flats." -ForegroundColor DarkGray
}

Write-Host "  Flats — Copied: $flatCopied  Skipped: $flatSkipped$(if ($flatErrors -gt 0) { "  Errors: $flatErrors" })" -ForegroundColor Cyan
Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  All done." -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

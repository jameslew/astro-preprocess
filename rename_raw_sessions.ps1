# ============================================================
# rename_raw_sessions.ps1
# Renames RAW session folders that pre-date the FriendlyNames
# scheme so they match the canonical destination name used by
# copy_from_asiair.ps1.
#
# For each Z:\RAW\<date>\<object> folder where a FriendlyNames
# mapping exists and the current name differs from the canonical
# name, three outcomes are possible:
#
#   RENAME  — canonical folder does not exist; safe to rename.
#   CLEAN   — canonical folder exists but is empty (stale stub
#             created by an earlier run); stub is removed first,
#             then the source folder is renamed.
#   SKIP    — canonical folder exists AND contains files; both
#             copies have data, so manual intervention is needed.
#
# Only processes date-pattern folders (YYYY-MM-DD) in RAW root
# to avoid touching unrelated subdirectories.
#
# Dry-run by default — shows the plan and asks for confirmation.
# ============================================================

. "$PSScriptRoot\config.ps1"   # loads $NasRawRoot, $FriendlyNames, Sanitize-Name

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Rename RAW Sessions to Friendly Names" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Root: $NasRawRoot"
Write-Host ""

if (-not (Test-Path $NasRawRoot)) {
    Write-Host "ERROR: Cannot reach $NasRawRoot - is $NasDriveLetter mapped?" -ForegroundColor Red
    exit 1
}

# Collect work items across all date folders.
$workItems = [System.Collections.Generic.List[PSObject]]::new()

foreach ($dateFolder in Get-ChildItem -Path $NasRawRoot -Directory) {
    # Only process date-pattern folders (YYYY-MM-DD).
    if ($dateFolder.Name -notmatch '^\d{4}-\d{2}-\d{2}$') { continue }

    foreach ($objectFolder in Get-ChildItem -Path $dateFolder.FullName -Directory) {
        $rawName  = $objectFolder.Name
        $destName = Sanitize-Name $(if ($FriendlyNames.ContainsKey($rawName)) { $FriendlyNames[$rawName] } else { $rawName })

        # Nothing to do if the name is already correct.
        if ($destName -eq $rawName) { continue }

        $srcPath  = $objectFolder.FullName
        $destPath = Join-Path $dateFolder.FullName $destName

        # Determine outcome.
        if (-not (Test-Path $destPath)) {
            $action = 'RENAME'
        } else {
            $destFileCount = (Get-ChildItem -Path $destPath -Recurse -File).Count
            $action = if ($destFileCount -eq 0) { 'CLEAN' } else { 'SKIP' }
        }

        $workItems.Add([PSCustomObject]@{
            Date     = $dateFolder.Name
            RawName  = $rawName
            DestName = $destName
            SrcPath  = $srcPath
            DestPath = $destPath
            Action   = $action
        })
    }
}

if ($workItems.Count -eq 0) {
    Write-Host "  All RAW session folders already use canonical names." -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}

# Display plan.
$renames = $workItems | Where-Object { $_.Action -eq 'RENAME' }
$cleans  = $workItems | Where-Object { $_.Action -eq 'CLEAN'  }
$skips   = $workItems | Where-Object { $_.Action -eq 'SKIP'   }

if ($renames.Count -gt 0) {
    Write-Host "  RENAME ($($renames.Count)):" -ForegroundColor Green
    foreach ($item in $renames) {
        Write-Host "    [$($item.Date)]  $($item.RawName)  ->  $($item.DestName)" -ForegroundColor White
    }
    Write-Host ""
}

if ($cleans.Count -gt 0) {
    Write-Host "  CLEAN + RENAME ($($cleans.Count))  [dest folder exists but is empty]:" -ForegroundColor Yellow
    foreach ($item in $cleans) {
        Write-Host "    [$($item.Date)]  $($item.RawName)  ->  $($item.DestName)" -ForegroundColor White
    }
    Write-Host ""
}

if ($skips.Count -gt 0) {
    Write-Host "  SKIP ($($skips.Count))  [dest folder exists AND has files — manual action needed]:" -ForegroundColor Red
    foreach ($item in $skips) {
        Write-Host "    [$($item.Date)]  $($item.RawName)  [dest has files -> $($item.DestName)]" -ForegroundColor White
        Write-Host "      $($item.SrcPath)" -ForegroundColor DarkGray
        Write-Host "      $($item.DestPath)" -ForegroundColor DarkGray
    }
    Write-Host ""
}

$actionCount = $renames.Count + $cleans.Count
if ($actionCount -eq 0) {
    Write-Host "  Nothing to rename (all pending items are conflicts)." -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}

$confirm = Read-Host "  Proceed with $actionCount rename(s)? [y/N]"
if ($confirm -notmatch '^[Yy]$') {
    Write-Host ""
    Write-Host "  Aborted — nothing was changed." -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}

Write-Host ""
$done = 0
foreach ($item in $renames) {
    Rename-Item -Path $item.SrcPath -NewName $item.DestName
    Write-Host "  Renamed      : [$($item.Date)]  $($item.RawName)  ->  $($item.DestName)" -ForegroundColor Green
    $done++
}
foreach ($item in $cleans) {
    Remove-Item -Path $item.DestPath -Recurse -Force
    Write-Host "  Removed stub : $($item.DestPath)" -ForegroundColor DarkYellow
    Rename-Item -Path $item.SrcPath -NewName $item.DestName
    Write-Host "  Renamed      : [$($item.Date)]  $($item.RawName)  ->  $($item.DestName)" -ForegroundColor Green
    $done++
}

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Done. $done folder(s) renamed." $(if ($skips.Count -gt 0) { "  $($skips.Count) conflict(s) need manual review." }) -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

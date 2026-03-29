# ============================================================
# remove_empty_processed_sessions.ps1
# Finds every <Object>\<Date> session folder under the
# Processed root whose entire folder tree contains no files,
# lists them, and asks for confirmation before deleting.
#
# After deletion, any <Object> folder left with no remaining
# date subfolders is also removed.
# ============================================================

. "$PSScriptRoot\config.ps1"   # loads $NasProcessedRoot

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Remove Empty Processed Sessions" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Root: $NasProcessedRoot"
Write-Host ""

if (-not (Test-Path $NasProcessedRoot)) {
    Write-Host "ERROR: Cannot reach $NasProcessedRoot - is $NasDriveLetter mapped?" -ForegroundColor Red
    exit 1
}

$emptySessions = [System.Collections.Generic.List[string]]::new()
$totalSessions = 0

foreach ($objectFolder in Get-ChildItem -Path $NasProcessedRoot -Directory) {
    foreach ($dateFolder in Get-ChildItem -Path $objectFolder.FullName -Directory) {
        $totalSessions++
        $fileCount = (Get-ChildItem -Path $dateFolder.FullName -Recurse -File).Count
        if ($fileCount -eq 0) {
            $emptySessions.Add($dateFolder.FullName)
        }
    }
}

if ($emptySessions.Count -eq 0) {
    Write-Host "  No empty session folders found — nothing to do." -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}

Write-Host "  $($emptySessions.Count) of $totalSessions session(s) would be removed:" -ForegroundColor Yellow
Write-Host ""
foreach ($path in $emptySessions) {
    Write-Host "  $path" -ForegroundColor White
}
Write-Host ""

$confirm = Read-Host "  Delete these $($emptySessions.Count) session(s)? [y/N]"
if ($confirm -notmatch '^[Yy]$') {
    Write-Host ""
    Write-Host "  Aborted — nothing was deleted." -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}

Write-Host ""
$removed = 0
foreach ($path in $emptySessions) {
    Remove-Item -Path $path -Recurse -Force
    Write-Host "  Removed: $path" -ForegroundColor Green
    $removed++
}

# Clean up any <Object> folders that are now empty.
$pruned = 0
foreach ($objectFolder in Get-ChildItem -Path $NasProcessedRoot -Directory) {
    $remaining = (Get-ChildItem -Path $objectFolder.FullName -Directory).Count
    if ($remaining -eq 0) {
        Remove-Item -Path $objectFolder.FullName -Recurse -Force
        Write-Host "  Pruned:  $($objectFolder.FullName) (no sessions remaining)" -ForegroundColor DarkYellow
        $pruned++
    }
}

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Done. $removed session(s) removed, $pruned object folder(s) pruned." -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

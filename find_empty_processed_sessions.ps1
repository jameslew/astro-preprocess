# ============================================================
# find_empty_processed_sessions.ps1
# Lists every <Object>\<Date> session folder under the
# Processed root whose entire folder tree contains no files.
#
# These are typically stub directories created by
# copy_from_asiair.ps1 or create_processed_folders.ps1 for
# sessions that were never actually run through PixInsight.
#
# DRY-RUN ONLY — this script prints candidates; it does not
# delete anything.  Pipe the output into
# remove_empty_processed_sessions.ps1 when you are ready to act.
# ============================================================

. "$PSScriptRoot\config.ps1"   # loads $NasProcessedRoot

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Find Empty Processed Sessions" -ForegroundColor Cyan
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
        # A session is considered empty when its entire subtree contains no files.
        $fileCount = (Get-ChildItem -Path $dateFolder.FullName -Recurse -File).Count
        if ($fileCount -eq 0) {
            $emptySessions.Add($dateFolder.FullName)
        }
    }
}

if ($emptySessions.Count -eq 0) {
    Write-Host "  No empty session folders found." -ForegroundColor DarkGray
} else {
    Write-Host "  $($emptySessions.Count) of $totalSessions session(s) are empty:" -ForegroundColor Yellow
    Write-Host ""
    foreach ($path in $emptySessions) {
        Write-Host "  $path" -ForegroundColor White
    }
}

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  DRY RUN - nothing was deleted." -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

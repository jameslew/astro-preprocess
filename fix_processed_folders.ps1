# ============================================================
# fix_processed_folders.ps1
# One-off migration: normalize and deduplicate Z:\Processed.
#
# What it does:
#   • Renames folders to canonical "CATALOG - Friendly Name" format
#     using the same $FriendlyNames table as copy_from_asiair.ps1
#   • Groups duplicates (same catalog ID, different naming)
#   • Merges duplicate contents into the canonical folder
#   • Renames originals to "{originalname} - deleteable"
#   • Leaves non-catalog folders (Psi Eridani, FOV, gdr3, …) untouched
#
# Usage:
#   .\fix_processed_folders.ps1           # live run
#   .\fix_processed_folders.ps1 -DryRun   # preview only — no changes
# ============================================================

param(
    [switch]$DryRun
)

. "$PSScriptRoot\config.ps1"   # loads $NasProcessedRoot, $FriendlyNames

$ProcessedRoot = $NasProcessedRoot

# ── Helpers ───────────────────────────────────────────────────

# Return the normalised catalog ID for a folder name, or $null if
# the folder doesn't follow a recognised catalog naming convention.
function Get-CatalogId ([string]$Name) {
    if ($Name -match '^M\s*(\d+)')            { return "M $($Matches[1])" }
    if ($Name -match '^NGC\s*(\d+)')          { return "NGC $($Matches[1])" }
    if ($Name -match '^IC\s*(\d+)')           { return "IC $($Matches[1])" }
    if ($Name -match '^SH\s*2\s*-\s*(\d+)')  { return "SH 2-$($Matches[1])" }
    if ($Name -match '^C\s*(\d+)')            { return "C $($Matches[1])" }
    if ($Name -match '^VdB\s*(\d+)')          { return "VdB $($Matches[1])" }
    return $null
}

# Extract the descriptive suffix after the catalog prefix+number.
# E.g. "NGC2244SatelliteCluster" → "SatelliteCluster"
#      "SH2-131 Elephant Trunk Nebula" → "Elephant Trunk Nebula"
#      "M42 Orion"    → "Orion"
#      "M 42 Processed" → "Processed"
function Get-Description ([string]$FolderName) {
    $rest = $null
    switch -Regex ($FolderName) {
        '^M\s*\d+\s*(.*)'            { $rest = $Matches[1]; break }
        '^NGC\s*\d+\s*(.*)'          { $rest = $Matches[1]; break }
        '^IC\s*\d+\s*(.*)'           { $rest = $Matches[1]; break }
        '^SH\s*2\s*-\s*\d+\s*(.*)'  { $rest = $Matches[1]; break }
        '^C\s*\d+\s*(.*)'            { $rest = $Matches[1]; break }
        '^VdB\s*\d+\s*(.*)'          { $rest = $Matches[1]; break }
    }
    if ($rest) { return ($rest -replace '^[-–\s]+', '').Trim() }
    return ''
}

# Recursively move the contents of $Src into $Dst.
# Subdirectories are merged; files are skipped if they already exist.
function Merge-Folder ([string]$Src, [string]$Dst) {
    foreach ($item in Get-ChildItem -LiteralPath $Src) {
        $destItem = Join-Path $Dst $item.Name
        if ($item.PSIsContainer) {
            if (-not $DryRun -and -not (Test-Path -LiteralPath $destItem)) {
                New-Item -ItemType Directory -Path $destItem | Out-Null
            }
            Merge-Folder -Src $item.FullName -Dst $destItem
        }
        else {
            if (Test-Path -LiteralPath $destItem) {
                Write-Host "      Skip (exists): $($item.Name)" -ForegroundColor DarkGray
            }
            else {
                Write-Host "      Move: $($item.Name)" -ForegroundColor DarkGreen
                if (-not $DryRun) {
                    Move-Item -LiteralPath $item.FullName -Destination $destItem
                }
            }
        }
    }
}

# ── Main ──────────────────────────────────────────────────────

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Normalize: $ProcessedRoot"             -ForegroundColor Cyan
if ($DryRun) {
    Write-Host "  [DRY RUN — no changes will be made]" -ForegroundColor Magenta
}
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path -LiteralPath $ProcessedRoot)) {
    Write-Host "ERROR: $ProcessedRoot not found." -ForegroundColor Red
    exit 1
}

# ── Phase 1: scan, parse, skip already-marked folders ─────────

$allFolders = Get-ChildItem -LiteralPath $ProcessedRoot -Directory |
    Where-Object { $_.Name -notmatch ' - deleteable' }

$catalogued    = [System.Collections.Generic.List[PSObject]]::new()
$skippedNames  = [System.Collections.Generic.List[string]]::new()

foreach ($f in $allFolders) {
    $cid = Get-CatalogId $f.Name
    if ($cid) {
        $catalogued.Add([PSCustomObject]@{ Folder = $f; CatalogId = $cid })
    }
    else {
        $skippedNames.Add($f.Name)
    }
}

if ($skippedNames.Count -gt 0) {
    Write-Host "Non-catalog folders (left untouched):" -ForegroundColor DarkGray
    foreach ($n in ($skippedNames | Sort-Object)) {
        Write-Host "  $n" -ForegroundColor DarkGray
    }
    Write-Host ""
}

# ── Phase 2: group by catalog ID and apply changes ────────────

$groups  = $catalogued | Group-Object CatalogId | Sort-Object Name
$renamed = 0
$merged  = 0

foreach ($group in $groups) {

    $catalogId = $group.Name
    $members   = @($group.Group)

    # Canonical name: FriendlyNames table wins; otherwise build from the
    # longest descriptive suffix found among the group's folder names.
    if ($FriendlyNames.ContainsKey($catalogId)) {
        $canonicalName = $FriendlyNames[$catalogId]
    }
    else {
        $bestDesc = ''
        foreach ($m in $members) {
            $d = Get-Description $m.Folder.Name
            if ($d.Length -gt $bestDesc.Length) { $bestDesc = $d }
        }
        $canonicalName = if ($bestDesc) { "$catalogId - $bestDesc" } else { $catalogId }
    }

    $canonicalPath = Join-Path $ProcessedRoot $canonicalName

    # ── Single folder ─────────────────────────────────────────
    if ($members.Count -eq 1) {
        $f = $members[0].Folder
        if ($f.Name -eq $canonicalName) {
            Write-Host "OK  : '$($f.Name)'" -ForegroundColor DarkGreen
        }
        else {
            Write-Host "Rename '$($f.Name)'" -ForegroundColor White
            Write-Host "    → '$canonicalName'" -ForegroundColor Green
            if (-not $DryRun) {
                Rename-Item -LiteralPath $f.FullName -NewName $canonicalName
            }
            $renamed++
        }
        continue
    }

    # ── Multiple folders (duplicates) ─────────────────────────
    Write-Host ""
    Write-Host "Merge [$catalogId] → '$canonicalName'" -ForegroundColor Cyan
    foreach ($m in $members) {
        Write-Host "  Source: '$($m.Folder.Name)'" -ForegroundColor White
    }

    # Ensure the canonical destination exists
    if (-not (Test-Path -LiteralPath $canonicalPath)) {
        Write-Host "  Create: '$canonicalName'" -ForegroundColor Green
        if (-not $DryRun) {
            New-Item -ItemType Directory -Path $canonicalPath | Out-Null
        }
    }

    foreach ($m in $members) {

        # If this member is already the canonical folder, nothing to do
        if ($m.Folder.Name -eq $canonicalName) {
            Write-Host "  (keep) '$($m.Folder.Name)' is already canonical" -ForegroundColor DarkGray
            continue
        }

        # Merge contents into canonical folder
        Write-Host "  Merging '$($m.Folder.Name)'..." -ForegroundColor Yellow
        if (-not $DryRun) {
            Merge-Folder -Src $m.Folder.FullName -Dst $canonicalPath
        }

        # Mark original as deleteable
        $deleteableName = "$($m.Folder.Name) - deleteable"
        $deleteablePath = Join-Path $ProcessedRoot $deleteableName
        if (Test-Path -LiteralPath $deleteablePath) {
            # Collision (shouldn't happen in practice): add a suffix
            $deleteableName = "$($m.Folder.Name) - deleteable-$(Get-Date -Format 'HHmmss')"
        }
        Write-Host "  Mark deleteable: '$($m.Folder.Name)'" -ForegroundColor DarkYellow
        if (-not $DryRun) {
            Rename-Item -LiteralPath $m.Folder.FullName -NewName $deleteableName
        }
        $merged++
    }
}

# ── Summary ───────────────────────────────────────────────────

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
if ($DryRun) {
    Write-Host "  [DRY RUN — no changes were made]"  -ForegroundColor Magenta
}
Write-Host "  Done."                                  -ForegroundColor Cyan
Write-Host "  Renamed (simple):     $renamed"         -ForegroundColor Green
Write-Host "  Merged + deleteable:  $merged"          -ForegroundColor Yellow
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

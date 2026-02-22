# ============================================================
# config.ps1  —  Shared configuration for AstroScripts
#
# Edit this file to match your hardware and storage setup.
# copy_from_asiair.ps1 and create_processed_folders.ps1
# both source this file automatically.
#
# astro_preprocess.js has its own matching config block at the
# top of the file — keep the NAS paths in sync if you change
# the drive letter or folder names here.
# ============================================================

# ── ASIAIR ───────────────────────────────────────────────────
$AsiairHost      = "asiair"                 # Hostname or IP address of your ASIAIR
$AsiairSharePath = "EMMC Images\Plan\Light" # SMB share path (typically unchanged)
$AsiairRoot      = "\\$AsiairHost\$AsiairSharePath"

# ── NAS / local storage ──────────────────────────────────────
$NasDriveLetter   = "Z:"                        # Drive letter your NAS is mapped to
$NasRawRoot       = "$NasDriveLetter\RAW"       # Where raw .fit/.fits files land
$NasProcessedRoot = "$NasDriveLetter\processed" # Where processed output goes

# ── Processed session subfolder names ────────────────────────
# Subfolders created under each <Object>\<Date> session directory.
# Must match the paths expected by astro_preprocess.js.
$ProcessedSubDirs = @("debayered", "registered", "master", "logs")

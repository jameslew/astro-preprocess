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

# ── Object friendly-name mapping ─────────────────────────────
# Maps your ASIAIR Plan name to a richer destination folder name.
# Keys must match the Plan name exactly as it appears in ASIAIR
# (case-insensitive on Windows). Both "M42" and "M 42" variants
# are included for Messier objects since ASIAIR accepts either.
# Add your own targets at the bottom; remove entries you never use.
$FriendlyNames = @{

    # ── Messier ──────────────────────────────────────────────
    "M 1"   = "M 1 - Crab Nebula"
    "M 6"   = "M 6 - Butterfly Cluster"
    "M 7"   = "M 7 - Ptolemy Cluster"
    "M 8"   = "M 8 - Lagoon Nebula"
    "M 11"  = "M 11 - Wild Duck Cluster"
    "M 13"  = "M 13 - Hercules Globular Cluster"
    "M 16"  = "M 16 - Eagle Nebula"
    "M 17"  = "M 17 - Omega Nebula"
    "M 20"  = "M 20 - Trifid Nebula"
    "M 22"  = "M 22 - Sagittarius Cluster"
    "M 24"  = "M 24 - Sagittarius Star Cloud"
    "M 27"  = "M 27 - Dumbbell Nebula"
    "M 31"  = "M 31 - Andromeda Galaxy"
    "M 33"  = "M 33 - Triangulum Galaxy"
    "M 42"  = "M 42 - Orion Nebula"
    "M 43"  = "M 43 - De Mairan's Nebula"
    "M 44"  = "M 44 - Beehive Cluster"
    "M 45"  = "M 45 - Pleiades"
    "M 51"  = "M 51 - Whirlpool Galaxy"
    "M 57"  = "M 57 - Ring Nebula"
    "M 63"  = "M 63 - Sunflower Galaxy"
    "M 64"  = "M 64 - Black Eye Galaxy"
    "M 74"  = "M 74 - Phantom Galaxy"
    "M 76"  = "M 76 - Little Dumbbell Nebula"
    "M 81"  = "M 81 - Bode's Galaxy"
    "M 82"  = "M 82 - Cigar Galaxy"
    "M 83"  = "M 83 - Southern Pinwheel Galaxy"
    "M 87"  = "M 87 - Virgo A"
    "M 97"  = "M 97 - Owl Nebula"
    "M 99"  = "M 99 - Coma Pinwheel"
    "M 101" = "M 101 - Pinwheel Galaxy"
    "M 104" = "M 104 - Sombrero Galaxy"

    # Messier no-space variants (ASIAIR accepts both "M42" and "M 42")
    "M1"    = "M 1 - Crab Nebula"
    "M6"    = "M 6 - Butterfly Cluster"
    "M7"    = "M 7 - Ptolemy Cluster"
    "M8"    = "M 8 - Lagoon Nebula"
    "M11"   = "M 11 - Wild Duck Cluster"
    "M13"   = "M 13 - Hercules Globular Cluster"
    "M16"   = "M 16 - Eagle Nebula"
    "M17"   = "M 17 - Omega Nebula"
    "M20"   = "M 20 - Trifid Nebula"
    "M22"   = "M 22 - Sagittarius Cluster"
    "M24"   = "M 24 - Sagittarius Star Cloud"
    "M27"   = "M 27 - Dumbbell Nebula"
    "M31"   = "M 31 - Andromeda Galaxy"
    "M33"   = "M 33 - Triangulum Galaxy"
    "M42"   = "M 42 - Orion Nebula"
    "M43"   = "M 43 - De Mairan's Nebula"
    "M44"   = "M 44 - Beehive Cluster"
    "M45"   = "M 45 - Pleiades"
    "M51"   = "M 51 - Whirlpool Galaxy"
    "M57"   = "M 57 - Ring Nebula"
    "M63"   = "M 63 - Sunflower Galaxy"
    "M64"   = "M 64 - Black Eye Galaxy"
    "M74"   = "M 74 - Phantom Galaxy"
    "M76"   = "M 76 - Little Dumbbell Nebula"
    "M81"   = "M 81 - Bode's Galaxy"
    "M82"   = "M 82 - Cigar Galaxy"
    "M83"   = "M 83 - Southern Pinwheel Galaxy"
    "M87"   = "M 87 - Virgo A"
    "M97"   = "M 97 - Owl Nebula"
    "M99"   = "M 99 - Coma Pinwheel"
    "M101"  = "M 101 - Pinwheel Galaxy"
    "M104"  = "M 104 - Sombrero Galaxy"

    # ── NGC ──────────────────────────────────────────────────
    "NGC 104"  = "NGC 104 - 47 Tucanae"
    "NGC 253"  = "NGC 253 - Sculptor Galaxy"
    "NGC 281"  = "NGC 281 - Pacman Nebula"
    "NGC 869"  = "NGC 869 - Double Cluster"
    "NGC 884"  = "NGC 884 - Double Cluster"
    "NGC 1499" = "NGC 1499 - California Nebula"
    "NGC 1977" = "NGC 1977 - Running Man Nebula"
    "NGC 2024" = "NGC 2024 - Flame Nebula"
    "NGC 2174" = "NGC 2174 - Monkey Head Nebula"
    "NGC 2237" = "NGC 2237 - Rosette Nebula"
    "NGC 2244" = "NGC 2244 - Rosette Cluster"
    "NGC 2264" = "NGC 2264 - Cone Nebula"
    "NGC 2359" = "NGC 2359 - Thor's Helmet"
    "NGC 2392" = "NGC 2392 - Eskimo Nebula"
    "NGC 3372" = "NGC 3372 - Eta Carinae Nebula"
    "NGC 4565" = "NGC 4565 - Needle Galaxy"
    "NGC 4631" = "NGC 4631 - Whale Galaxy"
    "NGC 5139" = "NGC 5139 - Omega Centauri"
    "NGC 6188" = "NGC 6188 - Fighting Dragons of Ara"
    "NGC 6302" = "NGC 6302 - Bug Nebula"
    "NGC 6826" = "NGC 6826 - Blinking Planetary"
    "NGC 6960" = "NGC 6960 - Western Veil Nebula"
    "NGC 6992" = "NGC 6992 - Eastern Veil Nebula"
    "NGC 7000" = "NGC 7000 - North America Nebula"
    "NGC 7023" = "NGC 7023 - Iris Nebula"
    "NGC 7293" = "NGC 7293 - Helix Nebula"
    "NGC 7380" = "NGC 7380 - Wizard Nebula"
    "NGC 7635" = "NGC 7635 - Bubble Nebula"
    "NGC 7662" = "NGC 7662 - Blue Snowball"
    "NGC 7789" = "NGC 7789 - Caroline's Rose"

    # ── IC ───────────────────────────────────────────────────
    "IC 405"  = "IC 405 - Flaming Star Nebula"
    "IC 410"  = "IC 410 - Tadpoles Nebula"
    "IC 434"  = "IC 434 - Horsehead Nebula"
    "IC 443"  = "IC 443 - Jellyfish Nebula"
    "IC 1396" = "IC 1396 - Elephant's Trunk Nebula"
    "IC 1805" = "IC 1805 - Heart Nebula"
    "IC 1848" = "IC 1848 - Soul Nebula"
    "IC 2118" = "IC 2118 - Witch Head Nebula"
    "IC 2177" = "IC 2177 - Seagull Nebula"
    "IC 5070" = "IC 5070 - Pelican Nebula"
    "IC 5146" = "IC 5146 - Cocoon Nebula"

    # ── Add your own below ───────────────────────────────────
}

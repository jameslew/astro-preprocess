# astro-preprocess

Automated astrophotography preprocessing pipeline for ZWO ASI533 MC Pro (OSC) with ASIAIR and PixInsight. All code and scripts generated with Claude Code.

## Overview

Three scripts that handle the full workflow from ASIAIR capture to drizzle-stacked master:

| Script | Purpose |
|--------|---------|
| `copy_from_asiair.ps1` | Copy FITS subs (lights, darks, flats) from ASIAIR to NAS, pre-create output folders |
| `create_processed_folders.ps1` | Pre-create processed folder structure for existing RAW sessions |
| `astro_preprocess.js` | PixInsight PJSR pipeline: Debayer → Master Dark → Master Flat → Calibration → StarAlignment → ImageIntegration → DrizzleIntegration |

## Folder Structure

```
Z:\
├── RAW\
│   └── 2026-04-08\
│       ├── NGC 2683\          ← lights
│       │   └── Light_*.fit
│       ├── darks\
│       │   ├── 60.0s\         ← Dark_60.0s_*.fit + master_dark_60.0s.xisf
│       │   ├── 120.0s\        ← Dark_120.0s_*.fit + master_dark_120.0s.xisf
│       │   ├── 180.0s\
│       │   ├── 300.0s\
│       │   └── 600.0s\
│       └── flats\             ← Flat_*.fit + master_flat_2026-04-08.xisf
└── processed\
    └── NGC 2683\
        └── 2026-04-08\
            ├── debayered\    ← _d.xisf (RGB, per light sub)
            ├── calibrated\   ← _d_c.xisf (dark/flat corrected, per light sub)
            ├── registered\   ← _d_c_r.xisf + _d_c_r.xdrz (per sub)
            ├── master\       ← integration.xisf + drizzle_NGC_2683_2026-04-08.xisf
            └── logs\         ← preprocess_<timestamp>.log (includes calibration summary)
```

## Requirements

- ZWO ASIAIR (any model) on local network
- NAS mapped as `Z:` (share: `\\truenas\astro`)
- PixInsight 1.9.3+ with WBPP 2.9.1+
- PowerShell 5.1+ (built into Windows 10/11)

## Workflow

### 1. After an imaging session

Run from PowerShell:
```powershell
.\copy_from_asiair.ps1
```

This connects to the ASIAIR over the network and copies:
- **Lights** from `EMMC Images\Plan\Light\<Object>\` → `Z:\RAW\<YYYY-MM-DD>\<Object>\`
- **Darks** from `EMMC Images\Autorun\Dark\` → `Z:\RAW\calibration\darks\<date>\<exp>s\`
- **Flats** from `EMMC Images\Autorun\Flat\` → `Z:\RAW\calibration\flats\<date>\`

It also pre-creates all required processed output folders.

### 2. Preprocess in PixInsight

Run the script from the PixInsight Script Editor or console:
```
run --execute-mode=auto "G:/AstroWorkingDir/astro_preprocess.js"
```

A folder picker opens — select either:
- A specific date folder (e.g. `Z:/RAW/2026-02-11`) to process one night
- The RAW root (`Z:/RAW`) to process all unprocessed nights

The pipeline runs automatically per session:
1. **Debayer lights** — RGGB/VNG, outputs `_d.xisf` RGB files
2. **Master dark** — integrates raw darks matched by exposure length (exact match, same date)
3. **Master flat** — debayers each raw flat, then integrates into a master flat
4. **ImageCalibration** — subtracts dark, divides by flat, outputs `_d_c.xisf`
5. **StarAlignment** — registers all calibrated subs, outputs `_d_c_r.xisf` + `_d_c_r.xdrz`
6. **ImageIntegration** — Winsorized sigma clipping, PSF signal weighting
7. **DrizzleIntegration** — 2× drizzle, outputs final color stack

**Calibration rules:**
- Darks are matched by **exact exposure length** and **same capture date** as lights. If no match is found, calibration is skipped and a warning is logged.
- Flats must be from the **same capture date** as lights (required because the imaging train is manually assembled each session and may shift). If absent, calibration is skipped.
- Each session log includes a **CALIBRATION SUMMARY** section showing exactly what was used or skipped.
- Masters are always rebuilt from raw frames — no library reuse across sessions.

Multiple objects captured on the same night are processed automatically in sequence.

### 3. If you have existing RAW sessions without processed folders

```powershell
.\create_processed_folders.ps1
```

This scans all of `Z:\RAW` and pre-creates the output folder structure for every session found.

## Configuration

Edit the top of `astro_preprocess.js`:

```javascript
var NAS_RAW_ROOT       = "Z:/Raw";       // RAW input root
var NAS_PROCESSED_ROOT = "Z:/Processed"; // Processed output root
var BAYER_PATTERN      = 0;              // 0=RGGB (ASI533 MC Pro)
var DRIZZLE_SCALE      = 2.0;            // Drizzle scale factor
// Darks and flats are discovered automatically under NAS_RAW_ROOT/<date>/darks/ and /flats/
```

Edit `config.ps1` to match your hardware:
```powershell
$AsiairHost      = "asiair"
$NasDriveLetter  = "Z:"
```

## Notes

- PixInsight cannot reliably create folders on network shares — PowerShell handles all folder creation
- To force a full reprocess of a session, delete `debayered/`, `calibrated/`, `registered/`, and `_processed.txt` from the RAW session folder
- `integration.xisf` in `master/` is the non-drizzled stack — useful as a reference or if drizzle is not needed
- The `_processed.txt` sentinel in each RAW session folder prevents reprocessing on subsequent runs
- The reflection artifact visible in some frames is an optical issue with the imaging train, not a pipeline artifact

## Camera / Equipment

- Camera: ZWO ASI533 MC Pro (3008×3008, 3.76µm pixels, RGGB Bayer)
- Mount: ZWO AM5N
- Controller: ZWO ASIAIR Plus
- NAS: TrueNAS (`\\truenas\astro`)

## Known Issues & TODO

### High Priority

**1. Fix calibration order (quality impact)**
Currently: Debayer → Calibrate → Register → Integrate → Drizzle
Correct:   Calibrate (raw CFA) → Debayer → Register → Integrate → Drizzle
Applying a flat to an already-debayered image is incorrect — flat correction must happen at the CFA pixel level before Bayer interpolation. This is causing a purple/green gradient in output vs WBPP reference. Fix: move `runImageCalibration()` before `runDebayer()`, set `enableCFA=true`, feed debayer the calibrated CFA output.

**2. Add Local Normalization**
WBPP applies LocalNormalization between registration and integration. This significantly improves background consistency across frames and reduces gradients. Add a `runLocalNormalization()` step between StarAlignment and ImageIntegration.

### Medium Priority

**3. Remove diagnostic logging**
`IC targetFrames count`, `IC outputDirectory` etc. log lines were added to debug ImageCalibration. Remove once calibration order is fixed and stable.

**4. Add debayer skip optimization**
Step 1 (debayer) reruns every time because `_processed.txt` is only written on full pipeline success. Add per-step skip: if debayered file count matches light frame count, skip debayer. Same logic could apply to calibration step.

**5. Drop shrink tuning**
Current `dropShrink = 1.00` may contribute to drizzle pattern artifacts with low frame counts. Try `0.9` as default. Consider making this a config constant.

### Low Priority

**6. Add auto-crop**
WBPP crops registered frame edges automatically post-integration. Could add a crop step after DrizzleIntegration to remove the black border artifacts from registration.

**7. Cleanup old processed folders**
Verify no incorrectly-structured folders remain from earlier pipeline runs (flat NGC 4884 panel structure, darks/flats folders in processed\, etc.).

**8. Rotate GitHub token**
Token used during development sessions should be rotated at https://github.com/settings/tokens if not already done.

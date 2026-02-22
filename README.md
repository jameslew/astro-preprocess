# astro-preprocess

Automated astrophotography preprocessing pipeline for ZWO ASI533 MC Pro (OSC) with ASIAIR and PixInsight. All code and scripts generated with Claude Code.

## Overview

Three scripts that handle the full workflow from ASIAIR capture to drizzle-stacked master:

| Script | Purpose |
|--------|---------|
| `copy_from_asiair.ps1` | Copy FITS subs from ASIAIR to NAS, pre-create output folders |
| `create_processed_folders.ps1` | Pre-create processed folder structure for existing RAW sessions |
| `astro_preprocess.js` | PixInsight PJSR pipeline: Debayer → StarAlignment → ImageIntegration → DrizzleIntegration |

## Folder Structure

```
Z:\
├── RAW\
│   └── 2026-02-11\
│       └── NGC 2683\
│           └── Light_NGC 2683_180.0s_Bin1_*.fit
└── processed\
    └── NGC 2683\
        └── 2026-02-11\
            ├── debayered\    ← _d.xisf (RGB, per sub)
            ├── registered\   ← _d_r.xisf + _d_r.xdrz (per sub)
            ├── master\       ← integration.xisf + drizzle_NGC_2683_2026-02-11.xisf
            └── logs\         ← preprocess_<timestamp>.log
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

This connects to the ASIAIR over the network, copies all new `.fit` files to `Z:\RAW\<YYYY-MM-DD>\<Object>\`, and pre-creates the matching processed output folders.

### 2. Preprocess in PixInsight

Run the script from the PixInsight Script Editor or console:
```
run --execute-mode=auto "G:/AstroWorkingDir/astro_preprocess.js"
```

A folder picker opens — select either:
- A specific date folder (e.g. `Z:/RAW/2026-02-11`) to process one night
- The RAW root (`Z:/RAW`) to process all unprocessed nights

The pipeline runs automatically:
1. **Debayer** — RGGB/VNG, outputs `_d.xisf` RGB files
2. **StarAlignment** — registers all subs to first frame, outputs `_d_r.xisf` + `_d_r.xdrz`
3. **ImageIntegration** — Winsorized sigma clipping, PSF signal weighting, writes LocationEstimates into `.xdrz` files
4. **DrizzleIntegration** — 2× drizzle, outputs final color stack

Multiple objects captured on the same night are processed automatically in sequence.

### 3. If you have existing RAW sessions without processed folders

Run from PowerShell:
```powershell
.\create_processed_folders.ps1
```

This scans all of `Z:\RAW` and pre-creates the output folder structure for every session found. Only needed for sessions that predate running `copy_from_asiair.ps1`.

## Configuration

Edit the top of `astro_preprocess.js`:

```javascript
var NAS_RAW_ROOT       = "Z:/RAW";       // RAW input root
var NAS_PROCESSED_ROOT = "Z:/processed"; // Processed output root
var BAYER_PATTERN      = 0;              // 0=RGGB (ASI533 MC Pro)
var DRIZZLE_SCALE      = 2.0;            // Drizzle scale factor
```

Edit the top of `copy_from_asiair.ps1`:
```powershell
$AsiairRoot       = "\\asiair\EMMC Images\Plan\Light"
$NasRawRoot       = "Z:\RAW"
$NasProcessedRoot = "Z:\processed"
```

## Notes

- PixInsight cannot reliably create folders on network shares — PowerShell handles all folder creation
- The pipeline skips Debayer for files already in `debayered/` only when they are confirmed RGB (3-channel). Delete `debayered/` and `registered/` to force a full reprocess.
- `integration.xisf` in `master/` is the non-drizzled stack — useful as a reference or if drizzle is not needed
- The reflection artifact visible in some frames is an optical issue with the imaging train, not a pipeline artifact

## Camera / Equipment

- Camera: ZWO ASI533 MC Pro (3008×3008, 3.76µm pixels, RGGB Bayer)
- Mount: ZWO AM5N
- Controller: ZWO ASIAIR Plus
- NAS: TrueNAS (`\\truenas\astro`)

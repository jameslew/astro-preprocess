// ============================================================
// astro_preprocess.js — OSC Preprocessing Pipeline
// ZWO ASI533 MC Pro (RGGB) · PixInsight PJSR
//
// Pipeline per object/date session:
//   1. Debayer lights   → _d.xisf  (RGGB/VNG, per-image)
//   2. Master dark      → calibration/darks/<date>/<exp>s/master_dark_<exp>s.xisf
//   3. Master flat      → calibration/flats/<date>/master_flat_<date>.xisf
//                         (flats debayered first, then integrated)
//   4. ImageCalibration → calibrated/<sub>_d_c.xisf
//   5. StarAlignment    → registered/<sub>_d_c_r.xisf + .xdrz
//   6. ImageIntegration → master/integration.xisf
//   7. DrizzleIntegration (2x) → master/drizzle_<Object>_<Date>.xisf
//
// Calibration rules:
//   - Darks:  matched by exact exposure length, same capture date as lights.
//             If no same-date darks found for the light exposure, calibration
//             is skipped and a warning is written to the log.
//   - Flats:  same capture date as lights, required. If no same-date flats
//             exist, calibration is skipped and a warning is written to the log.
//   - When both are absent, the pipeline proceeds without calibration and
//             notes this clearly in the session summary section of the log.
//
// Output structure:
//   Z:/processed/<Object>/<Date>/debayered/   <- debayered light subs _d.xisf
//   Z:/processed/<Object>/<Date>/calibrated/  <- calibrated light subs _d_c.xisf
//   Z:/processed/<Object>/<Date>/registered/  <- registered subs + .xdrz
//   Z:/processed/<Object>/<Date>/master/      <- integration + drizzle stack
//   Z:/RAW/<date>/darks/<exp>s/              <- dark raws (copied by copy_from_asiair.ps1)
//   Z:/RAW/<date>/flats/                     <- flat raws (copied by copy_from_asiair.ps1)
//
// Prerequisites:
//   - Run copy_from_asiair.ps1 to copy RAW+calibration files and pre-create folders
//   - PI cannot reliably create folders on network shares; PowerShell handles this
// ============================================================

// ── Configuration ────────────────────────────────────────────
var isWindows = CoreApplication.platform === "MSWINDOWS";

// NAS paths — actual folder names on the share are "Raw" and "Processed".
// Windows: edit the drive letter if your NAS is mapped differently.
// macOS:   edit the volume name if your NAS mounts under a different name.
var NAS_RAW_ROOT       = isWindows ? "Z:/Raw"       : "/Volumes/Astro/Raw";
var NAS_PROCESSED_ROOT = isWindows ? "Z:/Processed" : "/Volumes/Astro/Processed";
//   Darks: NAS_RAW_ROOT/<YYYY-MM-DD>/darks/<exp>s/*.fit
//   Flats: NAS_RAW_ROOT/<YYYY-MM-DD>/flats/*.fit

// Bayer pattern for your OSC camera:
//   0 = RGGB  (ZWO ASI533 MC Pro, most ZWO colour cameras)
//   1 = BGGR
//   2 = GBRG
//   3 = GRBG
var BAYER_PATTERN = 0;

// Drizzle output scale factor. 2.0 produces a 2× larger final stack.
// Requires generateDrizzleData = true in StarAlignment (already set).
var DRIZZLE_SCALE = 2.0;

// Maximum number of days to search forward/backward from session date
// when looking for matching darks or flats. Covers the common case of
// capturing calibration frames the morning after an imaging session.
var CALIB_DATE_TOLERANCE_DAYS = 1;
// ─────────────────────────────────────────────────────────────

// Mosaic panel suffix pattern: objectName ends with _<row>-<col>
// e.g. "NGC 4884_1-2" -> base "NGC 4884", panel "1-2"
var MOSAIC_PANEL_RE = /^(.+)_(\d+-\d+)$/;

function fileExists(p) { return File.exists(p); }

function ensureDir(p) {
    // Folders are pre-created by create_processed_folders.ps1 (run from Windows).
    // Shell fallback handles any edge cases PI cannot manage itself.
    if (!File.directoryExists(p)) {
        var mk = new ExternalProcess;
        if (isWindows) {
            var winPath = p.split("/").join("\\");
            mk.start("cmd.exe", ["/c", "mkdir \"" + winPath + "\" 2>nul"]);
        } else {
            mk.start("/bin/mkdir", ["-p", p]);
        }
        mk.waitForFinished();
        if (!File.directoryExists(p))
            throw new Error("Folder missing — could not create:\n  " + p);
    }
}

// Remove files in dir whose names do not start with "Light_".
// Cleans up stale artefacts written by earlier runs of the old script
// that lacked the Light_-only filter (e.g. Stacked*_d.xisf files).
function removeNonLightFiles(dir) {
    var removed = 0;
    var ff = new FileFind;
    if (!ff.begin(dir + "/*")) return 0;
    do {
        if (!ff.isDirectory && !/^Light_/i.test(ff.name)) {
            File.remove(dir + "/" + ff.name);
            removed++;
        }
    } while (ff.next());
    ff.end();
    return removed;
}

function closeAllWindows() {
    var wins = ImageWindow.windows;
    for (var i = wins.length - 1; i >= 0; i--)
        if (!wins[i].isNull) wins[i].close();
}

// ── Logging ──────────────────────────────────────────────────
var g_logFile = null;
function logOpen(logDir) {
    var now = new Date;
    var ts = now.getFullYear() +
        "-" + ("0"+(now.getMonth()+1)).slice(-2) +
        "-" + ("0"+now.getDate()).slice(-2) +
        "_" + ("0"+now.getHours()).slice(-2) +
        ("0"+now.getMinutes()).slice(-2) +
        ("0"+now.getSeconds()).slice(-2);
    var logPath = logDir + "/preprocess_" + ts + ".log";
    g_logFile = new File;
    g_logFile.createForWriting(logPath);
    Console.writeln("  Log: " + logPath);
}
function log(msg) {
    Console.writeln(msg);
    if (g_logFile && g_logFile.isOpen)
        g_logFile.outTextLn(msg);
}
// Mirror PI's console output to log file by replacing Console.noteln etc.
// For step functions (SA/II/DI), PI writes directly to Console and we
// cannot intercept it, but we log all our own step markers and errors.
function logClose() {
    if (g_logFile && g_logFile.isOpen) g_logFile.close();
    g_logFile = null;
}

// ── Calibration discovery ─────────────────────────────────────
// Parse exposure from a Light filename: Light_..._180.0s_Bin1_...fit → "180.0"
function parseLightExposure(filename) {
    var m = filename.match(/_(\d+(?:\.\d+)?)s_Bin/i);
    return m ? m[1] : null;
}

// Return the dominant exposure length (seconds) across all light frames,
// as a string like "120.0" — needed to find the matching dark folder.
function dominantExposure(fitFiles) {
    var counts = {};
    for (var i = 0; i < fitFiles.length; i++) {
        var exp = parseLightExposure(File.extractName(fitFiles[i]));
        if (exp) counts[exp] = (counts[exp] || 0) + 1;
    }
    var best = null, bestCount = 0;
    for (var k in counts) {
        if (counts[k] > bestCount) { best = k; bestCount = counts[k]; }
    }
    return best;
}

// Collect all .fit files in a directory (no recursion, no thumbnails).
function fitFilesIn(dir) {
    var files = [];
    var ff = new FileFind;
    if (!ff.begin(dir + "/*.fit")) return files;
    do {
        if (!ff.isDirectory) files.push(dir + "/" + ff.name);
    } while (ff.next());
    ff.end();
    return files;
}

// ── Calibration date search ──────────────────────────────────
// Returns a date string offset by `days` from the given YYYY-MM-DD string.
function offsetDate(dateStr, days) {
    var parts = dateStr.split("-");
    var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    d.setDate(d.getDate() + days);
    var y = d.getFullYear();
    var m = ("0" + (d.getMonth() + 1)).slice(-2);
    var day = ("0" + d.getDate()).slice(-2);
    return y + "-" + m + "-" + day;
}

// Search for a calibration directory within CALIB_DATE_TOLERANCE_DAYS of
// sessionDate. Checks same date first, then alternates +1/-1, +2/-2, etc.
// subPath is appended to NAS_RAW_ROOT/<date>/ — e.g. "darks/120.0s" or "flats"
// Returns { dir, date, dayOffset } or null if not found within tolerance.
function findCalibDir(sessionDate, subPath) {
    for (var delta = 0; delta <= CALIB_DATE_TOLERANCE_DAYS; delta++) {
        var offsets = delta === 0 ? [0] : [delta, -delta];
        for (var oi = 0; oi < offsets.length; oi++) {
            var candidateDate = offsetDate(sessionDate, offsets[oi]);
            var candidateDir  = NAS_RAW_ROOT + "/" + candidateDate + "/" + subPath;
            if (File.directoryExists(candidateDir)) {
                var files = fitFilesIn(candidateDir);
                if (files.length > 0)
                    return { dir: candidateDir, date: candidateDate, dayOffset: offsets[oi] };
            }
        }
    }
    return null;
}

// ── Step 2: Master dark ───────────────────────────────────────
// Integrates raw dark frames (no debayer — darks are mono CFA) into a master.
// outputFile: full path for the master dark xisf.
// Returns the output path on success, null if no frames available.
function buildMasterDark(darkRawFiles, outputFile) {
    if (!darkRawFiles || darkRawFiles.length === 0) return null;

    var images = [];
    for (var i = 0; i < darkRawFiles.length; i++)
        images.push([true, darkRawFiles[i], "", ""]);

    var II = new ImageIntegration;
    II.images                   = images;
    II.inputHints               = "fits-keywords normalize raw cfa use-roworder-keywords signed-is-physical";
    II.combination              = ImageIntegration.prototype.Average;
    II.weightMode               = ImageIntegration.prototype.NoiseEvaluation;
    II.normalization            = ImageIntegration.prototype.NoNormalization;
    II.rejection                = ImageIntegration.prototype.WinsorizedSigmaClip;
    II.rejectionNormalization   = ImageIntegration.prototype.Scale;
    II.sigmaLow                 = 4.000;
    II.sigmaHigh                = 3.000;
    II.winsorizationCutoff      = 5.000;
    II.clipLow                  = true;
    II.clipHigh                 = true;
    II.rangeClipLow             = true;
    II.rangeLow                 = 0.000000;
    II.rangeClipHigh            = false;
    II.generateRejectionMaps    = false;
    II.generateIntegratedImage  = true;
    II.generateDrizzleData      = false;
    II.closePreviousImages      = false;
    II.noGUIMessages            = true;
    II.showImages               = true;
    II.useFileThreads           = true;
    II.fileThreadOverload       = 1.00;
    II.autoMemorySize           = true;
    II.autoMemoryLimit          = 0.75;
    II.generateFITSKeywords     = true;
    II.evaluateSNR              = false;

    if (!II.executeGlobal())
        throw new Error("Master dark ImageIntegration failed.");

    var wins = ImageWindow.windows;
    var saved = false;
    for (var i = wins.length - 1; i >= 0; i--) {
        if (!wins[i].isNull) {
            var id = wins[i].currentView.id;
            if (id.indexOf("rejection") < 0 && id.indexOf("slope") < 0) {
                wins[i].saveAs(outputFile, false, false, false, false);
                saved = true;
                break;
            }
        }
    }
    var allWins = ImageWindow.windows;
    for (var i = allWins.length - 1; i >= 0; i--)
        if (!allWins[i].isNull) allWins[i].close();

    if (!saved) throw new Error("Master dark: integration window not found.");
    return outputFile;
}

// ── Step 3: Master flat ───────────────────────────────────────
// Debayers each raw flat then integrates into a master flat.
// Returns the output path on success, null if no frames available.
function buildMasterFlat(flatRawFiles, outputFile) {
    if (!flatRawFiles || flatRawFiles.length === 0) return null;

    // Debayer each flat to a temp XISF in memory (we'll collect window refs)
    var debayeredFlats = [];
    for (var i = 0; i < flatRawFiles.length; i++) {
        var wins = ImageWindow.open(flatRawFiles[i], "",
            "fits-keywords normalize raw cfa use-roworder-keywords signed-is-physical");
        if (!wins || wins.length === 0 || wins[0].isNull)
            throw new Error("Cannot open flat: " + flatRawFiles[i]);

        var db = new Debayer;
        db.bayerPattern  = BAYER_PATTERN;
        db.debayerMethod = 2;  // VNG
        db.evaluateNoise = true;
        db.executeOn(wins[0].mainView);

        // Find the RGB result window and save to a temp path
        var allWins = ImageWindow.windows;
        var saved = false;
        for (var j = allWins.length - 1; j >= 0; j--) {
            if (!allWins[j].isNull && allWins[j].mainView.image.numberOfChannels === 3) {
                var tmpPath = outputFile + "_tmp_" + i + ".xisf";
                allWins[j].saveAs(tmpPath, false, false, false, false);
                debayeredFlats.push(tmpPath);
                saved = true;
                break;
            }
        }
        // Close all before next flat
        var allWins2 = ImageWindow.windows;
        for (var k = allWins2.length - 1; k >= 0; k--)
            if (!allWins2[k].isNull) allWins2[k].close();

        if (!saved)
            throw new Error("Flat debayer produced no RGB window for: " + flatRawFiles[i]);
    }
    log("  Debayered " + debayeredFlats.length + " flat frames.");

    // Integrate debayered flats
    var images = [];
    for (var i = 0; i < debayeredFlats.length; i++)
        images.push([true, debayeredFlats[i], "", ""]);

    var II = new ImageIntegration;
    II.images                   = images;
    II.inputHints               = "";
    II.combination              = ImageIntegration.prototype.Average;
    II.weightMode               = ImageIntegration.prototype.NoiseEvaluation;
    II.normalization            = ImageIntegration.prototype.Multiplicative;
    II.rejection                = ImageIntegration.prototype.WinsorizedSigmaClip;
    II.rejectionNormalization   = ImageIntegration.prototype.Scale;
    II.sigmaLow                 = 4.000;
    II.sigmaHigh                = 3.000;
    II.winsorizationCutoff      = 5.000;
    II.clipLow                  = true;
    II.clipHigh                 = true;
    II.rangeClipLow             = false;
    II.rangeClipHigh            = false;
    II.generateRejectionMaps    = false;
    II.generateIntegratedImage  = true;
    II.generateDrizzleData      = false;
    II.closePreviousImages      = false;
    II.noGUIMessages            = true;
    II.showImages               = true;
    II.useFileThreads           = true;
    II.fileThreadOverload       = 1.00;
    II.autoMemorySize           = true;
    II.autoMemoryLimit          = 0.75;
    II.generateFITSKeywords     = true;
    II.evaluateSNR              = false;

    if (!II.executeGlobal())
        throw new Error("Master flat ImageIntegration failed.");

    var wins = ImageWindow.windows;
    var saved = false;
    for (var i = wins.length - 1; i >= 0; i--) {
        if (!wins[i].isNull) {
            var id = wins[i].currentView.id;
            if (id.indexOf("rejection") < 0 && id.indexOf("slope") < 0) {
                wins[i].saveAs(outputFile, false, false, false, false);
                saved = true;
                break;
            }
        }
    }
    var allWins = ImageWindow.windows;
    for (var i = allWins.length - 1; i >= 0; i--)
        if (!allWins[i].isNull) allWins[i].close();

    // Clean up temp debayered flat files
    for (var i = 0; i < debayeredFlats.length; i++)
        if (fileExists(debayeredFlats[i])) File.remove(debayeredFlats[i]);

    if (!saved) throw new Error("Master flat: integration window not found.");
    return outputFile;
}

// ── Step 4: ImageCalibration ──────────────────────────────────
// Applies master dark and/or master flat to each debayered light sub.
// masterDarkFile and masterFlatFile may be null — IC handles partial sets.
// Returns array of calibrated output file paths.
function runImageCalibration(debayeredFiles, outputDir, masterDarkFile, masterFlatFile) {
    var outputFiles = [];

    for (var i = 0; i < debayeredFiles.length; i++) {
        var inFile  = debayeredFiles[i];
        var base    = File.extractName(inFile).replace(/\.xisf$/i, "");
        var outFile = outputDir + "/" + base + "_c.xisf";

        var IC = new ImageCalibration;
        IC.inputFiles           = [inFile];
        IC.inputHints           = "";
        IC.outputDirectory      = outputDir;
        IC.outputExtension      = ".xisf";
        IC.outputPrefix         = "";
        IC.outputPostfix        = "_c";
        IC.outputSampleFormat   = ImageCalibration.prototype.f32;
        IC.overwriteExistingFiles = true;
        IC.onError              = ImageCalibration.prototype.Continue;

        // Master dark
        IC.masterDarkEnabled    = (masterDarkFile !== null);
        IC.masterDarkPath       = masterDarkFile || "";
        IC.optimizeDarks        = false;  // exact exposure match — no scaling needed

        // Master flat
        IC.masterFlatEnabled    = (masterFlatFile !== null);
        IC.masterFlatPath       = masterFlatFile || "";

        // No master bias (darks subsume bias)
        IC.masterBiasEnabled    = false;
        IC.masterBiasPath       = "";

        IC.calibrateBias        = false;
        IC.calibrateDark        = IC.masterDarkEnabled;
        IC.calibrateFlat        = IC.masterFlatEnabled;
        IC.noGUIMessages        = true;

        if (!IC.executeGlobal())
            throw new Error("ImageCalibration failed for: " + base);

        if (fileExists(outFile)) {
            outputFiles.push(outFile);
        } else {
            throw new Error("ImageCalibration output not found: " + outFile);
        }
    }
    log("  Calibrated " + outputFiles.length + " light frames.");
    return outputFiles;
}


// Opens each .fit with CFA format hints so PI reads BAYERPAT correctly.
// executeOn() modifies the view in-place; we then find the resulting RGB
// window by channel count and save it before closing all windows.
function runDebayer(inputFiles, outputDir) {
    var outputFiles = [];
    var toProcess = inputFiles;
    for (var i = 0; i < toProcess.length; i++) {
        var inFile  = toProcess[i];
        var base    = File.extractName(inFile);
        var outFile = outputDir + "/" + base + "_d.xisf";

        // Open with CFA hint so PI treats BAYERPAT keyword correctly
        var wins = ImageWindow.open(inFile, "", "fits-keywords normalize raw cfa use-roworder-keywords signed-is-physical");
        if (!wins || wins.length === 0 || wins[0].isNull)
            throw new Error("Cannot open: " + inFile);
        var win = wins[0];

        var db = new Debayer;
        db.bayerPattern  = BAYER_PATTERN;  // 0=RGGB
        db.debayerMethod = 2;              // 2=VNG
        db.evaluateNoise = true;
        db.executeOn(win.mainView);

        // Debayer may open a new window rather than modify in-place.
        // Find the RGB result (most recently opened window with 3 channels),
        // save it, then close all open windows before moving to the next sub.
        var allWins = ImageWindow.windows;
        var saved = false;
        for (var j = allWins.length - 1; j >= 0; j--) {
            if (!allWins[j].isNull && allWins[j].mainView.image.numberOfChannels === 3) {
                allWins[j].saveAs(outFile, false, false, false, false);
                saved = true;
                break;
            }
        }
        // Close all windows before next sub to avoid memory accumulation
        var allWins2 = ImageWindow.windows;
        for (var k = allWins2.length - 1; k >= 0; k--)
            if (!allWins2[k].isNull) allWins2[k].close();

        if (!saved)
            throw new Error("Debayer produced no RGB window for: " + base);

        outputFiles.push(outFile);
        log("  debayered (RGB): " + base + "_d.xisf");
    }
    return outputFiles;
}

// ── Step 2: StarAlignment ────────────────────────────────────
// SA.targets array format (from WBPP 2.9.1 log): [enabled, isFile, path]
function runStarAlignment(inputFiles, outputDir) {
    var targets = [];
    for (var i = 0; i < inputFiles.length; i++)
        targets.push([true, true, inputFiles[i]]);

    var SA = new StarAlignment;
    SA.structureLayers              = 5;
    SA.noiseLayers                  = 0;
    SA.hotPixelFilterRadius         = 1;
    SA.noiseReductionFilterRadius   = 0;
    SA.minStructureSize             = 0;
    SA.sensitivity                  = 0.50;
    SA.peakResponse                 = 0.50;
    SA.brightThreshold              = 3.00;
    SA.maxStarDistortion            = 0.60;
    SA.allowClusteredSources        = false;
    SA.localMaximaDetectionLimit    = 0.75;
    SA.upperLimit                   = 1.000;
    SA.invert                       = false;
    SA.distortionModel              = "";
    SA.undistortedReference         = false;
    SA.rigidTransformations         = false;
    SA.distortionCorrection         = false;
    SA.distortionMaxIterations      = 20;
    SA.distortionMatcherExpansion   = 1.00;
    SA.rbfType                      = StarAlignment.prototype.DDMThinPlateSpline;
    SA.maxSplinePoints              = 4000;
    SA.splineOrder                  = 2;
    SA.splineSmoothness             = 0.005;
    SA.splineOutlierDetectionRadius = 160;
    SA.splineOutlierDetectionMinThreshold = 4.0;
    SA.splineOutlierDetectionSigma  = 5.0;
    SA.matcherTolerance             = 0.0500;
    SA.ransacTolerance              = 1.9000;
    SA.ransacMaxIterations          = 2000;
    SA.ransacMaximizeInliers        = 1.00;
    SA.ransacMaximizeOverlapping    = 1.00;
    SA.ransacMaximizeRegularity     = 1.00;
    SA.ransacMinimizeError          = 1.00;
    SA.maxStars                     = 0;
    SA.fitPSF                       = StarAlignment.prototype.FitPSF_DistortionOnly;
    SA.psfTolerance                 = 0.50;
    SA.useTriangles                 = false;
    SA.polygonSides                 = 5;
    SA.descriptorsPerStar           = 20;
    SA.restrictToPreviews           = true;
    SA.intersection                 = StarAlignment.prototype.MosaicOnly;
    SA.useBrightnessRelations       = false;
    SA.useScaleDifferences          = false;
    SA.scaleTolerance               = 0.100;
    SA.referenceImage               = inputFiles[0];
    SA.referenceIsFile              = true;
    SA.targets                      = targets;
    SA.inputHints                   = "fits-keywords normalize only-first-image";
    SA.outputHints                  = "properties fits-keywords no-compress-data block-alignment 4096 max-inline-block-size 3072 no-embedded-data no-resolution no-icc-profile";
    SA.mode                         = StarAlignment.prototype.RegisterMatch;
    SA.writeKeywords                = true;
    SA.generateMasks                = false;
    SA.generateDrizzleData          = true;
    SA.generateDistortionMaps       = false;
    SA.generateHistoryProperties    = true;
    SA.inheritAstrometricSolution   = true;
    SA.frameAdaptation              = false;
    SA.randomizeMosaic              = false;
    SA.pixelInterpolation           = StarAlignment.prototype.Auto;
    SA.clampingThreshold            = 0.30;
    SA.outputDirectory              = outputDir;
    SA.outputExtension              = ".xisf";
    SA.outputPrefix                 = "";
    SA.outputPostfix                = "_r";
    SA.outputSampleFormat           = StarAlignment.prototype.f32;
    SA.overwriteExistingFiles       = true;
    SA.onError                      = StarAlignment.prototype.Continue;
    SA.useFileThreads               = true;
    SA.fileThreadOverload           = 1.00;
    SA.memoryLoadControl            = true;
    SA.memoryLoadLimit              = 0.85;

    if (!SA.executeGlobal())
        throw new Error("StarAlignment failed.");

    // Collect output — drizzle array is always parallel to registered array
    var registered = [], drizzleFiles = [];
    for (var i = 0; i < inputFiles.length; i++) {
        var base  = File.extractName(inputFiles[i]);
        var rFile = outputDir + "/" + base + "_r.xisf";
        var dFile = outputDir + "/" + base + "_r.xdrz";
        if (fileExists(rFile)) {
            registered.push(rFile);
            drizzleFiles.push(fileExists(dFile) ? dFile : "");
        }
    }
    var nDrizzle = drizzleFiles.filter(function(f){ return f !== ""; }).length;
    log("  StarAlignment: " + registered.length + " registered, " + nDrizzle + " drizzle files.");
    for (var i = 0; i < registered.length; i++) {
        var rOk = fileExists(registered[i]) ? "OK" : "MISSING";
        var dOk = drizzleFiles[i] ? (fileExists(drizzleFiles[i]) ? "OK" : "MISSING") : "none";
        log("    [" + (i+1) + "] xisf=" + rOk + " xdrz=" + dOk + "  " + File.extractName(registered[i]));
    }
    return { registered: registered, drizzle: drizzleFiles };
}

// ── Step 3: ImageIntegration ─────────────────────────────────
// II.images format (WBPP log): [enabled, path, drizzlePath, localNormPath]
// drizzlePath is passed so II can write LocationEstimates into the .xdrz files —
// these are required by DrizzleIntegration in step 4.
function runImageIntegration(registeredFiles, drizzleFiles, outputDir) {
    var images = [];
    for (var i = 0; i < registeredFiles.length; i++) {
        var xdrz = (drizzleFiles && drizzleFiles[i]) ? drizzleFiles[i] : "";
        images.push([true, registeredFiles[i], xdrz, ""]);
    }

    var II = new ImageIntegration;
    II.images                           = images;
    II.inputHints                       = "";
    II.overrideImageType                = false;
    II.imageType                        = 0;
    II.combination                      = ImageIntegration.prototype.Average;
    II.weightMode                       = ImageIntegration.prototype.PSFSignalWeight;
    II.weightKeyword                    = "WBPPWGHT";
    II.weightScale                      = ImageIntegration.prototype.WeightScale_BWMV;
    II.minWeight                        = 0.050000;
    II.adaptiveGridSize                 = 16;
    II.adaptiveNoScale                  = false;
    II.ignoreNoiseKeywords              = false;
    II.normalization                    = ImageIntegration.prototype.AdditiveWithScaling;
    II.rejection                        = ImageIntegration.prototype.WinsorizedSigmaClip;
    II.rejectionNormalization           = ImageIntegration.prototype.Scale;
    II.minMaxLow                        = 1;
    II.minMaxHigh                       = 1;
    II.pcClipLow                        = 0.200;
    II.pcClipHigh                       = 0.100;
    II.sigmaLow                         = 4.000;
    II.sigmaHigh                        = 3.000;
    II.winsorizationCutoff              = 5.000;
    II.linearFitLow                     = 5.000;
    II.linearFitHigh                    = 3.500;
    II.esdOutliersFraction              = 0.30;
    II.esdAlpha                         = 0.05;
    II.esdLowRelaxation                 = 1.00;
    II.rcrLimit                         = 0.10;
    II.ccdGain                          = 1.00;
    II.ccdReadNoise                     = 10.00;
    II.ccdScaleNoise                    = 0.00;
    II.clipLow                          = true;
    II.clipHigh                         = true;
    II.rangeClipLow                     = true;
    II.rangeLow                         = 0.000000;
    II.rangeClipHigh                    = false;
    II.rangeHigh                        = 0.980000;
    II.mapRangeRejection                = true;
    II.reportRangeRejection             = false;
    II.largeScaleClipLow                = false;
    II.largeScaleClipLowProtectedLayers = 2;
    II.largeScaleClipLowGrowth          = 2;
    II.largeScaleClipHigh               = false;
    II.largeScaleClipHighProtectedLayers = 2;
    II.largeScaleClipHighGrowth         = 2;
    II.generate64BitResult              = false;
    II.generateRejectionMaps            = true;
    II.generateSlopeMaps                = false;
    II.generateIntegratedImage          = true;
    II.generateDrizzleData              = true;
    II.closePreviousImages              = false;
    II.autoMemorySize                   = true;
    II.autoMemoryLimit                  = 0.75;
    II.useROI                           = false;
    II.useCache                         = true;
    II.evaluateSNR                      = true;
    II.noiseEvaluationAlgorithm         = ImageIntegration.prototype.NoiseEvaluation_MRS;
    II.mrsMinDataFraction               = 0.010;
    II.psfStructureLayers               = 5;
    II.psfType                          = ImageIntegration.prototype.PSFType_Moffat4;
    II.generateFITSKeywords             = true;
    II.subtractPedestals                = false;
    II.truncateOnOutOfRange             = false;
    II.noGUIMessages                    = true;
    II.showImages                       = true;
    II.useFileThreads                   = true;
    II.fileThreadOverload               = 1.00;
    II.useBufferThreads                 = true;
    II.maxBufferThreads                 = 0;

    if (!II.executeGlobal())
        throw new Error("ImageIntegration failed.");

    // Save the main integration image (skip rejection/slope maps)
    var wins = ImageWindow.windows;
    for (var i = wins.length - 1; i >= 0; i--) {
        if (!wins[i].isNull) {
            var id = wins[i].currentView.id;
            if (id.indexOf("rejection") < 0 && id.indexOf("slope") < 0) {
                var outFile = outputDir + "/integration.xisf";
                wins[i].saveAs(outFile, false, false, false, false);
                log("  Integration saved: " + outFile);
                break;
            }
        }
    }
}

// ── Step 4: DrizzleIntegration ───────────────────────────────
// DI.inputData format (WBPP log): [enabled, xdrzPath, localNormPath]
function runDrizzleIntegration(drizzleFiles, outputFile) {
    var inputData = [];
    for (var i = 0; i < drizzleFiles.length; i++)
        if (drizzleFiles[i] !== "") inputData.push([true, drizzleFiles[i], ""]);

    if (inputData.length === 0)
        throw new Error("No .xdrz files available for DrizzleIntegration.");

    var DI = new DrizzleIntegration;
    DI.inputData                    = inputData;
    DI.inputHints                   = "";
    DI.inputDirectory               = "";
    DI.scale                        = DRIZZLE_SCALE;
    DI.dropShrink                   = 1.00;
    DI.kernelFunction               = DrizzleIntegration.prototype.Kernel_Square;
    DI.kernelGridSize               = 16;
    DI.originX                      = 0.50;
    DI.originY                      = 0.50;
    DI.enableCFA                    = false;  // already debayered
    DI.cfaPattern                   = "";
    DI.enableRejection              = true;
    DI.enableImageWeighting         = true;
    DI.enableSurfaceSplines         = true;
    DI.enableLocalDistortion        = true;
    DI.enableLocalNormalization     = false;
    DI.enableAdaptiveNormalization  = false;
    DI.useROI                       = false;
    DI.roiX0                        = 0;
    DI.roiY0                        = 0;
    DI.roiX1                        = 0;
    DI.roiY1                        = 0;
    DI.closePreviousImages          = false;
    DI.useLUT                       = true;
    DI.truncateOnOutOfRange         = false;
    DI.noGUIMessages                = true;
    DI.showImages                   = true;
    DI.onError                      = DrizzleIntegration.prototype.Continue;

    if (!DI.executeGlobal())
        throw new Error("DrizzleIntegration failed.");

    // DI produces two windows: the integration and a weights map.
    // Save the main image (not the weights map) and close both.
    var wins = ImageWindow.windows;
    var saved = false;
    for (var i = wins.length - 1; i >= 0; i--) {
        if (!wins[i].isNull) {
            var id = wins[i].currentView.id;
            if (id.indexOf("weight") < 0) {
                wins[i].saveAs(outputFile, false, false, false, false);
                log("  Drizzle saved: " + outputFile);
                saved = true;
            }
            wins[i].close();
        }
    }
    if (!saved)
        throw new Error("DrizzleIntegration: main output window not found.");
}

// ── Session processor ────────────────────────────────────────
// processedBase: optional override for the processed output root path.
//   Non-mosaic: NAS_PROCESSED_ROOT/<objectName>/<dateStr>
//   Mosaic panel: NAS_PROCESSED_ROOT/<friendlyBase>/<dateStr>/<panelName>
function processSession(objectName, dateStr, sourceDir, processedBase) {
    // Skip sessions that completed on a previous run.
    // To force a re-run, delete _processed.txt from the RAW session folder.
    var sentinelFile = sourceDir + "/_processed.txt";
    if (fileExists(sentinelFile)) {
        Console.writeln("  Skipping [" + objectName + " / " + dateStr +
                        "] — already processed. Delete _processed.txt to re-run.");
        return null;
    }

    Console.writeln("\n" + "=".repeat(40));
    Console.writeln("Object : " + objectName);
    Console.writeln("Date   : " + dateStr);
    Console.writeln("Source : " + sourceDir);
    Console.writeln("=".repeat(40));

    // Collect only individual light frames (Light_*.fit / Light_*.fits).
    var fitFiles = [];
    var fitExts = ["*.fit", "*.fits"];
    for (var ei = 0; ei < fitExts.length; ei++) {
        var fitFf = new FileFind;
        if (fitFf.begin(sourceDir + "/" + fitExts[ei])) {
            do {
                if (!fitFf.isDirectory && /^Light_/i.test(fitFf.name))
                    fitFiles.push(sourceDir + "/" + fitFf.name);
            } while (fitFf.next());
            fitFf.end();
        }
    }
    if (fitFiles.length === 0) {
        log("  WARNING: No Light_*.fit/.fits files found in " + sourceDir);
        return null;
    }
    log("Found " + fitFiles.length + " light frames.");

    // Detect dominant light exposure for dark matching
    var lightExp = dominantExposure(fitFiles);  // e.g. "120.0"

    var base          = processedBase || (NAS_PROCESSED_ROOT + "/" + objectName + "/" + dateStr);
    var debayeredDir  = base + "/debayered";
    var calibratedDir = base + "/calibrated";
    var registeredDir = base + "/registered";
    var masterDir     = base + "/master";
    var logsDir       = base + "/logs";

    ensureDir(debayeredDir);
    ensureDir(calibratedDir);
    ensureDir(registeredDir);
    ensureDir(masterDir);
    ensureDir(logsDir);
    logOpen(logsDir);

    // ── Calibration frame discovery ───────────────────────────────────
    // Search within CALIB_DATE_TOLERANCE_DAYS of session date.
    // Darks: Z:/RAW/<date>/darks/<exp>s/
    // Flats: Z:/RAW/<date>/flats/
    var darkResult = lightExp ? findCalibDir(dateStr, "darks/" + lightExp + "s") : null;
    var flatResult = findCalibDir(dateStr, "flats");

    var darkRawFiles = darkResult ? fitFilesIn(darkResult.dir) : [];
    var flatRawFiles = flatResult ? fitFilesIn(flatResult.dir) : [];

    // Calibration status strings for the session summary
    var darkStatus, flatStatus;
    if (!lightExp) {
        darkStatus = "\u2717 NOT USED \u2014 could not determine light exposure length";
    } else if (!darkResult) {
        darkStatus = "\u2717 NOT USED \u2014 no darks found for " + lightExp +
                     "s within \u00b1" + CALIB_DATE_TOLERANCE_DAYS + " day(s) of " + dateStr;
    } else {
        var darkOffsetNote = darkResult.dayOffset === 0 ? "same date" :
            (darkResult.dayOffset > 0 ? "+" : "") + darkResult.dayOffset + " day(s) (" + darkResult.date + ")";
        darkStatus = "\u2713 AVAILABLE \u2014 " + darkRawFiles.length + " \u00d7 " + lightExp +
                     "s frames [" + darkOffsetNote + "] from " + darkResult.dir;
    }
    if (!flatResult) {
        flatStatus = "\u2717 NOT USED \u2014 no flats found within \u00b1" +
                     CALIB_DATE_TOLERANCE_DAYS + " day(s) of " + dateStr;
    } else {
        var flatOffsetNote = flatResult.dayOffset === 0 ? "same date" :
            (flatResult.dayOffset > 0 ? "+" : "") + flatResult.dayOffset + " day(s) (" + flatResult.date + ")";
        flatStatus = "\u2713 AVAILABLE \u2014 " + flatRawFiles.length +
                     " frames [" + flatOffsetNote + "] from " + flatResult.dir;
    }
    var finalOutput = null;
    try {
        // Purge any non-Light_ files left behind by earlier runs of the old script.
        var staleCount = removeNonLightFiles(debayeredDir) + removeNonLightFiles(registeredDir);
        if (staleCount > 0)
            log("  Removed " + staleCount + " stale non-Light_ file(s) from previous run.");

        log("\n[1/7] Debayer lights (RGGB/VNG)...");
        var dbFiles = runDebayer(fitFiles, debayeredDir);
        closeAllWindows();

        // ── Build masters and calibrate (steps 2–4) ───────────
        var masterDarkFile = null;
        var masterFlatFile = null;
        var calibFiles     = null;  // null = no calibration applied

        var darkBuilt = false, flatBuilt = false;

        if (darkRawFiles.length > 0) {
            log("\n[2/7] Building master dark (" + darkRawFiles.length + " \u00d7 " + lightExp + "s)...");
            var darkOut = darkResult.dir + "/master_dark_" + lightExp + "s.xisf";
            masterDarkFile = buildMasterDark(darkRawFiles, darkOut);
            closeAllWindows();
            darkBuilt = true;
            darkStatus = "\u2713 USED \u2014 master built from " + darkRawFiles.length +
                         " \u00d7 " + lightExp + "s frames";
            log("  Master dark: " + darkOut);
        } else {
            log("\n[2/7] Master dark SKIPPED \u2014 " + darkStatus);
        }

        if (flatRawFiles.length > 0) {
            log("\n[3/7] Building master flat (" + flatRawFiles.length + " frames, debayer first)...");
            var flatOut = flatResult.dir + "/master_flat_" + flatResult.date + ".xisf";
            masterFlatFile = buildMasterFlat(flatRawFiles, flatOut);
            closeAllWindows();
            flatBuilt = true;
            flatStatus = "\u2713 USED \u2014 master built from " + flatRawFiles.length + " frames (debayered)";
            log("  Master flat: " + flatOut);
        } else {
            log("\n[3/7] Master flat SKIPPED \u2014 " + flatStatus);
        }

        if (masterDarkFile !== null || masterFlatFile !== null) {
            log("\n[4/7] ImageCalibration...");
            calibFiles = runImageCalibration(dbFiles, calibratedDir, masterDarkFile, masterFlatFile);
            closeAllWindows();
        } else {
            log("\n[4/7] ImageCalibration SKIPPED \u2014 no calibration masters available.");
            log("  WARNING: Proceeding with uncalibrated light frames.");
        }

        // Use calibrated subs if available, otherwise debayered
        var alignInputFiles = (calibFiles !== null) ? calibFiles : dbFiles;

        log("\n[5/7] StarAlignment + drizzle data...");
        var saResult = runStarAlignment(alignInputFiles, registeredDir);
        closeAllWindows();

        if (saResult.registered.length === 0)
            throw new Error("No registered files produced by StarAlignment.");

        log("\n[6/7] ImageIntegration...");
        runImageIntegration(saResult.registered, saResult.drizzle, masterDir);
        closeAllWindows();

        var validDrizzle = saResult.drizzle.filter(function(f){ return f !== ""; });
        if (validDrizzle.length > 0) {
            log("\n[7/7] DrizzleIntegration (" + DRIZZLE_SCALE + "x, " +
                validDrizzle.length + " frames)...");
            var drizzleOut = masterDir + "/drizzle_" +
                objectName.replace(/ /g, "_") + "_" + dateStr + ".xisf";
            runDrizzleIntegration(saResult.drizzle, drizzleOut);
            closeAllWindows();
            finalOutput = drizzleOut;
        } else {
            log("\n[7/7] WARNING: DrizzleIntegration skipped \u2014 no .xdrz files.");
            finalOutput = masterDir + "/integration.xisf";
        }

        log("\n\u2713 Complete [" + objectName + " / " + dateStr + "]");

        // ── Calibration summary ───────────────────────────────
        log("\n" + "-".repeat(40));
        log("CALIBRATION SUMMARY");
        log("-".repeat(40));
        log("  Light frames : " + fitFiles.length + (lightExp ? " (" + lightExp + "s)" : ""));
        log("  Darks        : " + darkStatus);
        log("  Flats        : " + flatStatus);
        if (masterDarkFile === null && masterFlatFile === null) {
            log("  \u26a0 WARNING: No calibration applied \u2014 pipeline ran on uncalibrated lights.");
        } else {
            log("  Calibration  : APPLIED");
        }
        log("-".repeat(40));

        // Write sentinel so subsequent runs skip this session automatically.
        var sf = new File;
        sf.createForWriting(sentinelFile);
        sf.outTextLn("Processed: " + (new Date()).toISOString());
        sf.outTextLn("Darks: " + darkStatus);
        sf.outTextLn("Flats: " + flatStatus);
        sf.close();

    } catch (e) {
        log("\n\u2717 ERROR [" + objectName + " / " + dateStr + "]: " + e.message);
        closeAllWindows();
    }
    logClose();
    return finalOutput;  // null on error/skip, output path on success
}

// ── Folder scanner ───────────────────────────────────────────
// Detects mosaic panels (objectName matching _N-N suffix), groups them
// under a shared processed parent folder, and processes each panel
// independently through the full pipeline.
function processDateDir(dateDir, dateStr) {
    var outputs = [];

    // Collect all object subdirectories, skipping darks/flats
    var objectDirs = [];
    var ff = new FileFind;
    if (!ff.begin(dateDir + "/*")) return outputs;
    do {
        if (ff.isDirectory && ff.name !== "." && ff.name !== ".." &&
                ff.name !== "darks" && ff.name !== "flats") {
            objectDirs.push(ff.name);
        }
    } while (ff.next());
    ff.end();

    // Group by base object name (strip mosaic panel suffix if present)
    var groups = {};  // baseObjectName -> [ panelName, ... ]
    for (var i = 0; i < objectDirs.length; i++) {
        var name  = objectDirs[i];
        var match = MOSAIC_PANEL_RE.exec(name);
        var base  = match ? match[1] : name;
        if (!groups[base]) groups[base] = [];
        groups[base].push(name);
    }

    for (var base in groups) {
        var panels   = groups[base];
        var isMosaic = panels.length > 1 || MOSAIC_PANEL_RE.test(panels[0]);

        if (isMosaic) {
            Console.writeln("
Mosaic detected: " + base + " (" + panels.length + " panels)");
            // Shared processed parent: NAS_PROCESSED_ROOT/<base>/<dateStr>
            // Each panel gets its own subfolder within that parent.
            for (var p = 0; p < panels.length; p++) {
                var panelName    = panels[p];
                var processedBase = NAS_PROCESSED_ROOT + "/" + base + "/" + dateStr + "/" + panelName;
                var result = processSession(
                    panelName, dateStr, dateDir + "/" + panelName, processedBase);
                if (result !== null) outputs.push(result);
            }
        } else {
            var result = processSession(panels[0], dateStr, dateDir + "/" + panels[0]);
            if (result !== null) outputs.push(result);
        }
    }
    return outputs;
}

// ── Main ─────────────────────────────────────────────────────
Console.writeln("AstroPreprocess — OSC Pipeline");
Console.writeln("RAW root      : " + NAS_RAW_ROOT);
Console.writeln("Processed root: " + NAS_PROCESSED_ROOT);

var dlg = new GetDirectoryDialog;
dlg.caption     = "Select a date folder (e.g. Z:/RAW/2026-02-11) or Z:/RAW to process all dates";
dlg.initialPath = NAS_RAW_ROOT;

if (!dlg.execute()) {
    Console.writeln("Cancelled.");
} else {
    var sel = dlg.directory;
    Console.writeln("\nSelected: " + sel);

    var allOutputs = [];

    if (/\d{4}-\d{2}-\d{2}$/.test(sel)) {
        allOutputs = processDateDir(sel, sel.replace(/.*[\/\\]/, ""));
    } else {
        var ff = new FileFind;
        if (ff.begin(sel + "/*")) {
            do {
                if (ff.isDirectory && /^\d{4}-\d{2}-\d{2}$/.test(ff.name))
                    allOutputs = allOutputs.concat(
                        processDateDir(sel + "/" + ff.name, ff.name));
            } while (ff.next());
            ff.end();
        }
    }

    Console.writeln("\n" + "=".repeat(40));
    Console.writeln("All sessions complete.");
    Console.writeln("Results in: " + NAS_PROCESSED_ROOT);
    Console.writeln("=".repeat(40));

    // Open every final image so they are ready for post-processing.
    if (allOutputs.length > 0) {
        Console.writeln("\nOpening " + allOutputs.length + " final image(s)...");
        for (var oi = 0; oi < allOutputs.length; oi++) {
            Console.writeln("  " + allOutputs[oi]);
            var outWins = ImageWindow.open(allOutputs[oi]);
            if (outWins && outWins.length > 0 && !outWins[0].isNull)
                outWins[0].show();
        }
    }
}

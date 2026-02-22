// ============================================================
// astro_preprocess.js — OSC Preprocessing Pipeline
// ZWO ASI533 MC Pro (RGGB) · PixInsight PJSR
//
// Pipeline per object/date session:
//   1. Debayer          → _d.xisf  (RGGB/VNG, per-image)
//   2. StarAlignment    → _d_r.xisf + _d_r.xdrz
//   3. ImageIntegration → master/integration.xisf
//   4. DrizzleIntegration (2x) → master/drizzle_<Object>_<Date>.xisf
//
// Output structure:
//   Z:/processed/<Object>/<Date>/debayered/   <- debayered subs
//   Z:/processed/<Object>/<Date>/registered/  <- registered subs + .xdrz
//   Z:/processed/<Object>/<Date>/master/      <- integration + drizzle stack
//
// Prerequisites:
//   - Run copy_from_asiair.ps1 to copy RAW files and pre-create output folders
//   - PI cannot reliably create folders on network shares; PowerShell handles this
// ============================================================

// ── Configuration ────────────────────────────────────────────
// NAS paths: use forward slashes. Keep in sync with $NasRawRoot /
// $NasProcessedRoot in config.ps1 (the PowerShell scripts share those values).
var NAS_RAW_ROOT       = "Z:/RAW";       // Input: raw .fit/.fits files
var NAS_PROCESSED_ROOT = "Z:/processed"; // Output: debayered, registered, master

// Bayer pattern for your OSC camera:
//   0 = RGGB  (ZWO ASI533 MC Pro, most ZWO colour cameras)
//   1 = BGGR
//   2 = GBRG
//   3 = GRBG
var BAYER_PATTERN = 0;

// Drizzle output scale factor. 2.0 produces a 2× larger final stack.
// Requires generateDrizzleData = true in StarAlignment (already set).
var DRIZZLE_SCALE = 2.0;
// ─────────────────────────────────────────────────────────────

function fileExists(p) { return File.exists(p); }

function ensureDir(p) {
    // Folders are pre-created by copy_from_asiair.ps1.
    // cmd.exe fallback handles any edge cases PI cannot manage itself.
    if (!File.directoryExists(p)) {
        var winPath = p.split("/").join("\\");
        var mk = new ExternalProcess;
        mk.start("cmd.exe", ["/c", "mkdir \"" + winPath + "\" 2>nul"]);
        mk.waitForFinished();
        if (!File.directoryExists(p))
            throw new Error("Folder missing — run create_processed_folders.ps1 first:\n  " + p);
    }
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

// ── Step 1: Debayer ──────────────────────────────────────────
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
function processSession(objectName, dateStr, sourceDir) {
    // Skip sessions that completed on a previous run.
    // To force a re-run, delete _processed.txt from the RAW session folder.
    var sentinelFile = sourceDir + "/_processed.txt";
    if (fileExists(sentinelFile)) {
        Console.writeln("  Skipping [" + objectName + " / " + dateStr +
                        "] — already processed. Delete _processed.txt to re-run.");
        return;
    }

    Console.writeln("\n" + "=".repeat(40));
    Console.writeln("Object : " + objectName);
    Console.writeln("Date   : " + dateStr);
    Console.writeln("Source : " + sourceDir);
    Console.writeln("=".repeat(40));

    // Collect only individual light frames (Light_*.fit / Light_*.fits).
    // ASIAIR also writes running in-camera stacks (Stacked*_*.fit) to the same
    // folder; if those reach ImageIntegration their wildly unequal PSF weights
    // cause nearly every frame to be rejected and the process aborts.
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
        return;
    }
    log("Found " + fitFiles.length + " light frames.");

    var base          = NAS_PROCESSED_ROOT + "/" + objectName + "/" + dateStr;
    var debayeredDir  = base + "/debayered";
    var registeredDir = base + "/registered";
    var masterDir     = base + "/master";

    var logsDir = base + "/logs";
    ensureDir(debayeredDir);
    ensureDir(registeredDir);
    ensureDir(masterDir);
    ensureDir(logsDir);
    logOpen(logsDir);

    try {
        log("\n[1/4] Debayer (RGGB/VNG)...");
        var dbFiles = runDebayer(fitFiles, debayeredDir);
        closeAllWindows();

        log("\n[2/4] StarAlignment + drizzle data...");
        var saResult = runStarAlignment(dbFiles, registeredDir);
        closeAllWindows();

        if (saResult.registered.length === 0)
            throw new Error("No registered files produced by StarAlignment.");

        log("\n[3/4] ImageIntegration...");
        runImageIntegration(saResult.registered, saResult.drizzle, masterDir);
        closeAllWindows();

        var validDrizzle = saResult.drizzle.filter(function(f){ return f !== ""; });
        if (validDrizzle.length > 0) {
            log("\n[4/4] DrizzleIntegration (" + DRIZZLE_SCALE + "x, " +
                validDrizzle.length + " frames)...");
            var drizzleOut = masterDir + "/drizzle_" +
                objectName.replace(/ /g, "_") + "_" + dateStr + ".xisf";
            runDrizzleIntegration(saResult.drizzle, drizzleOut);
            closeAllWindows();
        } else {
            log("\n[4/4] WARNING: DrizzleIntegration skipped — no .xdrz files.");
        }

        log("\n\u2713 Complete [" + objectName + " / " + dateStr + "]");

        // Write sentinel so subsequent runs skip this session automatically.
        var sf = new File;
        sf.createForWriting(sentinelFile);
        sf.outTextLn("Processed: " + (new Date()).toISOString());
        sf.close();

    } catch (e) {
        log("\n\u2717 ERROR [" + objectName + " / " + dateStr + "]: " + e.message);
        closeAllWindows();
    }
    logClose();
}

// ── Folder scanner ───────────────────────────────────────────
function processDateDir(dateDir, dateStr) {
    var ff = new FileFind;
    if (!ff.begin(dateDir + "/*")) return;
    do {
        if (ff.isDirectory && ff.name !== "." && ff.name !== "..")
            processSession(ff.name, dateStr, dateDir + "/" + ff.name);
    } while (ff.next());
    ff.end();
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

    if (/\d{4}-\d{2}-\d{2}$/.test(sel)) {
        processDateDir(sel, sel.replace(/.*[\/\\]/, ""));
    } else {
        var ff = new FileFind;
        if (ff.begin(sel + "/*")) {
            do {
                if (ff.isDirectory && /^\d{4}-\d{2}-\d{2}$/.test(ff.name))
                    processDateDir(sel + "/" + ff.name, ff.name);
            } while (ff.next());
            ff.end();
        }
    }

    Console.writeln("\n" + "=".repeat(40));
    Console.writeln("All sessions complete.");
    Console.writeln("Results in: " + NAS_PROCESSED_ROOT);
    Console.writeln("=".repeat(40));
}

// ============================================================
// astro_preprocess.js — OSC Preprocessing Pipeline
// ZWO ASI533 MC Pro (RGGB) · PixInsight PJSR
//
// Pipeline per object/date session:
//   1. Master dark      → RAW/<date>/darks/<exp>s/master_dark_<exp>s.xisf
//   2. Master flat      → RAW/<date>/flats/master_flat_<date>.xisf
//                         (raw CFA flats integrated directly — no debayer)
//   3. ImageCalibration → calibrated/<sub>_c.xisf  (raw CFA in, CFA out)
//   4. Debayer          → debayered/<sub>_c_d.xisf (RGB, per-image)
//   5. StarAlignment    → registered/<sub>_c_d_r.xisf + .xdrz + .xnml
//   6. LocalNormalization → registered/<sub>_c_d_r_n.xisf + .xnml
//   7. ImageIntegration → master/integration.xisf (uses .xnml data)
//   8. DrizzleIntegration (2x) → master/drizzle_<Object>_<Date>.xisf
//
// Calibration rules:
//   - Darks:  matched by exact exposure length, within CALIB_DATE_TOLERANCE_DAYS.
//             If no match found, calibration is skipped with a warning.
//   - Flats:  within CALIB_DATE_TOLERANCE_DAYS of session date.
//             If absent, calibration is skipped with a warning.
//   - When both are absent, pipeline proceeds with uncalibrated lights.
//
// Output structure:
//   Z:/processed/<Object>/<Date>/calibrated/  <- CFA-calibrated subs _c.xisf
//   Z:/processed/<Object>/<Date>/debayered/   <- debayered RGB subs _c_d.xisf
//   Z:/processed/<Object>/<Date>/registered/  <- registered subs + .xdrz
//   Z:/processed/<Object>/<Date>/master/      <- integration + drizzle stack
//   Z:/RAW/<date>/darks/<exp>s/               <- dark raws
//   Z:/RAW/<date>/flats/                      <- flat raws
//
// Prerequisites:
//   - Run copy_from_asiair.ps1 to copy RAW+calibration files and pre-create folders
//   - PI cannot reliably create folders on network shares; PowerShell handles this
// ============================================================

// ── Configuration ────────────────────────────────────────────
// NAS paths — edit to match your setup.
// isWindows is kept for the ensureDir() shell command selection.
var isWindows = true;

var NAS_RAW_ROOT       = "Z:/Raw";
var NAS_PROCESSED_ROOT = "Z:/Processed";
//   Darks: NAS_RAW_ROOT/<YYYY-MM-DD>/darks/<exp>s/Dark_*.fit
//   Flats: NAS_RAW_ROOT/<YYYY-MM-DD>/flats/Flat_*.fit

// Bayer pattern for your OSC camera:
//   0 = RGGB  (ZWO ASI533 MC Pro, most ZWO colour cameras)
//   1 = BGGR
//   2 = GBRG
//   3 = GRBG
var BAYER_PATTERN = 0;

// Drizzle output scale factor. 2.0 produces a 2× larger final stack.
// Requires generateDrizzleData = true in StarAlignment (already set).
var DRIZZLE_SCALE = 2.0;

// Path to PixInsight's ImageSolver script (AdP = Astrometry & Photometry)
var IMAGE_SOLVER_PATH = CoreApplication.srcDirPath + "/scripts/AdP/ImageSolver.js";
var g_imageSolverLoaded = false;

// ── Image solving helper ──────────────────────────────────────
// Convert ISO date string (YYYY-MM-DDTHH:MM:SS.sss) to Julian Date
function isoToJulianDate(iso) {
    var s = iso.replace(/'/g, "").trim();
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?/);
    if (!m) return null;
    var Y = parseInt(m[1]), M = parseInt(m[2]), D = parseInt(m[3]);
    var h = parseInt(m[4]), mn = parseInt(m[5]), sc = parseFloat((m[6]||"0") + (m[7]||""));
    // Standard JD formula
    var A = Math.floor((14 - M) / 12);
    var y = Y + 4800 - A;
    var mo = M + 12 * A - 3;
    var JDN = D + Math.floor((153 * mo + 2) / 5) + 365 * y +
              Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
    return JDN + (h - 12) / 24 + mn / 1440 + sc / 86400;
}

// Run ImageSolver on an already-open ImageWindow.
// Skips solving if the image already has a valid astrometric solution.
// Returns true if solved (or already solved), false on failure.
function runImageSolver(win, drizzleScale) {
    if (!File.exists(IMAGE_SOLVER_PATH)) {
        log("  ImageSolver not found at: " + IMAGE_SOLVER_PATH);
        return false;
    }

    // Load ImageSolver script once per pipeline run
    if (!g_imageSolverLoaded) {
        eval(File.readTextFile(IMAGE_SOLVER_PATH))
        g_imageSolverLoaded = true;
    }

    // Check if already solved
    var checkMeta = new ImageMetadata();
    checkMeta.ExtractMetadata(win);
    if (checkMeta.projection !== null && checkMeta.resolution > 0) {
        log("  ImageSolver: solution already present (res=" +
            (checkMeta.resolution * 3600).toFixed(3) + " arcsec/px), skipping.");
        return true;
    }

    var solver = new ImageSolver();
    solver.solverCfg.useActive            = false;
    solver.solverCfg.showStars            = false;
    solver.solverCfg.showDistortion       = false;
    solver.solverCfg.generateErrorImg     = false;
    solver.solverCfg.catalog              = "GaiaDR3_XPSD";
    solver.solverCfg.autoMagnitude        = true;
    solver.solverCfg.distortionCorrection = true;
    solver.solverCfg.maxIterations        = 10;

    // Seed metadata from FITS keywords
    solver.metadata.width    = win.mainView.image.width;
    solver.metadata.height   = win.mainView.image.height;
    solver.metadata.xpixsz   = 3.76;  // ASI533 MC Pro pixel size in microns
    solver.metadata.useFocal = false;
    // Resolution: native arcsec/px divided by drizzle scale
    var nativeResolution = 0.733;  // arcsec/px for ASI533 at ~1058mm FL
    solver.metadata.resolution = (nativeResolution / (drizzleScale || 1)) / 3600;  // degrees/px

    var keys = win.keywords;
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.name === "RA")       solver.metadata.ra  = parseFloat(k.value);
        if (k.name === "DEC")      solver.metadata.dec = parseFloat(k.value);
        if (k.name === "DATE-OBS") {
            var jd = isoToJulianDate(k.value);
            if (jd) { solver.metadata.epoch = jd; solver.metadata.observationTime = jd; }
        }
        if (k.name === "DATE-END") {
            var jd2 = isoToJulianDate(k.value);
            if (jd2) solver.metadata.endTime = jd2;
        }
        if (k.name === "FOCALLEN" && parseFloat(k.value) > 0)
            solver.metadata.focal = parseFloat(k.value) / (drizzleScale || 1);
    }

    log("  ImageSolver: RA=" + solver.metadata.ra.toFixed(4) +
        " Dec=" + solver.metadata.dec.toFixed(4) +
        " res=" + (solver.metadata.resolution * 3600).toFixed(3) + " arcsec/px");

    var result = solver.SolveImage(win);
    if (result) {
        log("  ImageSolver: solved successfully.");
    } else {
        log("  WARNING: ImageSolver failed — image will not have astrometric solution.");
    }
    return result;
}


// Maximum number of days to search forward/backward from session date
// when looking for matching darks or flats. Covers the common case of
// capturing calibration frames the morning after an imaging session.
var CALIB_DATE_TOLERANCE_DAYS = 1;

// Per-run master caches — keyed by "<calibDate>/<exp>s" for darks,
// "<calibDate>" for flats. Avoids rebuilding masters when multiple
// sessions on the same night share the same calibration frames.
var g_masterDarkCache = {};  // key: "<date>/<exp>s"  -> path
var g_masterFlatCache = {};  // key: "<date>"          -> path
// ─────────────────────────────────────────────────────────────

// Mosaic panel suffix pattern: objectName ends with _<row>-<col>
// e.g. "NGC 4884_1-2" -> base "NGC 4884", panel "1-2"
var MOSAIC_PANEL_RE = /^(.+)_(\d+-\d+)$/;

// Friendly name mapping — must match config.ps1 $FriendlyNames exactly.
// Used to resolve the correct processed output folder name.
var FRIENDLY_NAMES = {
    // Messier
    "M 1":   "M 1 - Crab Nebula",
    "M 6":   "M 6 - Butterfly Cluster",
    "M 7":   "M 7 - Ptolemy Cluster",
    "M 8":   "M 8 - Lagoon Nebula",
    "M 11":  "M 11 - Wild Duck Cluster",
    "M 13":  "M 13 - Hercules Globular Cluster",
    "M 16":  "M 16 - Eagle Nebula",
    "M 17":  "M 17 - Omega Nebula",
    "M 20":  "M 20 - Trifid Nebula",
    "M 22":  "M 22 - Sagittarius Cluster",
    "M 24":  "M 24 - Sagittarius Star Cloud",
    "M 27":  "M 27 - Dumbbell Nebula",
    "M 31":  "M 31 - Andromeda Galaxy",
    "M 33":  "M 33 - Triangulum Galaxy",
    "M 35":  "M 35 - Shoe-Buckle Cluster",
    "M 36":  "M 36 - Pinwheel Cluster",
    "M 37":  "M 37 - Salt and Pepper Cluster",
    "M 38":  "M 38 - Starfish Cluster",
    "M 42":  "M 42 - Orion Nebula",
    "M 43":  "M 43 - De Mairans Nebula",
    "M 44":  "M 44 - Beehive Cluster",
    "M 45":  "M 45 - Pleiades",
    "M 51":  "M 51 - Whirlpool Galaxy",
    "M 57":  "M 57 - Ring Nebula",
    "M 63":  "M 63 - Sunflower Galaxy",
    "M 64":  "M 64 - Black Eye Galaxy",
    "M 74":  "M 74 - Phantom Galaxy",
    "M 76":  "M 76 - Little Dumbbell Nebula",
    "M 81":  "M 81 - Bodes Galaxy",
    "M 82":  "M 82 - Cigar Galaxy",
    "M 83":  "M 83 - Southern Pinwheel Galaxy",
    "M 87":  "M 87 - Virgo A",
    "M 92":  "M 92 - Great Hercules Cluster",
    "M 97":  "M 97 - Owl Nebula",
    "M 99":  "M 99 - Coma Pinwheel",
    "M 101": "M 101 - Pinwheel Galaxy",
    "M 104": "M 104 - Sombrero Galaxy",
    "M 106": "M 106 - Cosmic Muffin",
    "M 108": "M 108 - Surfboard Galaxy",
    // NGC
    "NGC 104":  "NGC 104 - 47 Tucanae",
    "NGC 253":  "NGC 253 - Sculptor Galaxy",
    "NGC 281":  "NGC 281 - Pacman Nebula",
    "NGC 869":  "NGC 869 - Double Cluster",
    "NGC 884":  "NGC 884 - Double Cluster",
    "NGC 1499": "NGC 1499 - California Nebula",
    "NGC 1579": "NGC 1579 - Trifid of the North",
    "NGC 1977": "NGC 1977 - Running Man Nebula",
    "NGC 2024": "NGC 2024 - Flame Nebula",
    "NGC 2174": "NGC 2174 - Monkey Head Nebula",
    "NGC 2237": "NGC 2237 - Rosette Nebula",
    "NGC 2244": "NGC 2244 - Rosette Cluster",
    "NGC 2264": "NGC 2264 - Cone Nebula",
    "NGC 2359": "NGC 2359 - Thors Helmet",
    "NGC 2392": "NGC 2392 - Eskimo Nebula",
    "NGC 2683": "NGC 2683 - UFO Galaxy",
    "NGC 3372": "NGC 3372 - Eta Carinae Nebula",
    "NGC 4565": "NGC 4565 - Needle Galaxy",
    "NGC 4631": "NGC 4631 - Whale Galaxy",
    "NGC 5139": "NGC 5139 - Omega Centauri",
    "NGC 5982": "NGC 5982 - Draco Triplet",
    "NGC 6188": "NGC 6188 - Fighting Dragons of Ara",
    "NGC 6302": "NGC 6302 - Bug Nebula",
    "NGC 6826": "NGC 6826 - Blinking Planetary",
    "NGC 6946": "NGC 6946 - Fireworks Galaxy",
    "NGC 6960": "NGC 6960 - Western Veil Nebula",
    "NGC 6992": "NGC 6992 - Eastern Veil Nebula",
    "NGC 7000": "NGC 7000 - North America Nebula",
    "NGC 7023": "NGC 7023 - Iris Nebula",
    "NGC 7293": "NGC 7293 - Helix Nebula",
    "NGC 7380": "NGC 7380 - Wizard Nebula",
    "NGC 7635": "NGC 7635 - Bubble Nebula",
    "NGC 7662": "NGC 7662 - Blue Snowball",
    "NGC 7789": "NGC 7789 - Carolines Rose",
    // IC
    "IC 405":  "IC 405 - Flaming Star Nebula",
    "IC 410":  "IC 410 - Tadpoles Nebula",
    "IC 417":  "IC 417 - Spider Nebula",
    "IC 434":  "IC 434 - Horsehead Nebula",
    "IC 443":  "IC 443 - Jellyfish Nebula",
    "IC 1318": "IC 1318 - Sadr Region",
    "IC 1396": "IC 1396 - Elephants Trunk Nebula",
    "IC 1795": "IC 1795 - Fish Head Nebula",
    "IC 1805": "IC 1805 - Heart Nebula",
    "IC 1848": "IC 1848 - Soul Nebula",
    "IC 2118": "IC 2118 - Witch Head Nebula",
    "IC 2175": "IC 2175 - Monkey Head Nebula",
    "IC 2177": "IC 2177 - Seagull Nebula",
    "IC 5070": "IC 5070 - Pelican Nebula",
    "IC 5146": "IC 5146 - Cocoon Nebula"
};

// Resolve friendly name for an object, stripping mosaic panel suffix first.
// Returns the friendly name if mapped, otherwise the original name.
// Sanitizes by removing apostrophes and unsafe chars to match PS behavior.
function friendlyName(rawName) {
    var m = MOSAIC_PANEL_RE.exec(rawName);
    var base   = m ? m[1] : rawName;
    var suffix = m ? "_" + m[2] : "";
    var mapped = FRIENDLY_NAMES.hasOwnProperty(base) ? FRIENDLY_NAMES[base] : base;
    // Strip unsafe chars (matches Sanitize-Name in config.ps1)
    mapped = mapped.replace(/['\/:\*\?"<>|]/g, "").replace(/\s{2,}/g, " ").replace(/^\s+|\s+$/g, "");
    return mapped + suffix;
}

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

    // Save to local temp first to avoid SMB rename failures on network shares
    var localTmp = File.systemTempDirectory + "/master_dark_tmp.xisf";
    var wins = ImageWindow.windows;
    var saved = false;
    for (var i = wins.length - 1; i >= 0; i--) {
        if (!wins[i].isNull) {
            var id = wins[i].currentView.id;
            if (id.indexOf("rejection") < 0 && id.indexOf("slope") < 0) {
                wins[i].saveAs(localTmp, false, false, false, false);
                saved = true;
                break;
            }
        }
    }
    var allWins = ImageWindow.windows;
    for (var i = allWins.length - 1; i >= 0; i--)
        if (!allWins[i].isNull) allWins[i].close();

    if (!saved) throw new Error("Master dark: integration window not found.");

    // Copy from local temp to NAS
    if (fileExists(outputFile)) File.remove(outputFile);
    File.copyFile(outputFile, localTmp);
    File.remove(localTmp);

    return outputFile;
}

// ── Step 2: Master flat ───────────────────────────────────────
// Integrates raw CFA flat frames directly (no debayer).
// This matches WBPP behaviour: flat is a CFA master, applied to raw
// CFA lights before debayering. masterDarkFile may be null.
// Returns the output path on success, null if no frames available.
function buildMasterFlat(flatRawFiles, masterDarkFile, outputFile) {
    if (!flatRawFiles || flatRawFiles.length === 0) return null;

    // Step A: calibrate raw flats with dark (if available) via ImageCalibration
    // This removes dark current from flats before integration.
    var flatsToIntegrate = flatRawFiles;  // use raw flats directly if no dark
    // Use local temp dir to avoid SMB folder creation issues
    var calibFlatDir = File.systemTempDirectory + "/flat_calib_tmp";

    if (masterDarkFile !== null) {
        // Create local temp dir directly via PI file API
        if (!File.directoryExists(calibFlatDir)) {
            if (!File.createDirectory(calibFlatDir, true))
                throw new Error("Cannot create temp dir: " + calibFlatDir);
        }
        var ICF = new ImageCalibration;
        var flatTargets = [];
        for (var i = 0; i < flatRawFiles.length; i++)
            flatTargets.push([true, flatRawFiles[i]]);
        ICF.targetFrames            = flatTargets;
        ICF.enableCFA               = true;
        ICF.cfaPattern              = ImageCalibration.prototype.Auto;
        ICF.inputHints              = "fits-keywords normalize only-first-image raw cfa use-roworder-keywords signed-is-physical";
        ICF.outputHints             = "properties fits-keywords no-compress-data block-alignment 4096 max-inline-block-size 3072 no-embedded-data no-resolution ";
        ICF.pedestal                = 0;
        ICF.pedestalMode            = ImageCalibration.prototype.Keyword;
        ICF.masterBiasEnabled       = false;
        ICF.masterDarkEnabled       = true;
        ICF.masterDarkPath          = masterDarkFile;
        ICF.masterFlatEnabled       = false;
        ICF.calibrateBias           = true;
        ICF.calibrateDark           = false;
        ICF.calibrateFlat           = false;
        ICF.optimizeDarks           = false;
        ICF.darkCFADetectionMode    = ImageCalibration.prototype.DetectCFA;
        ICF.separateCFAFlatScalingFactors = false;
        ICF.flatScaleClippingFactor = 0.05;
        ICF.evaluateNoise           = false;
        ICF.evaluateSignal          = false;
        ICF.outputDirectory         = calibFlatDir;
        ICF.outputExtension         = ".xisf";
        ICF.outputPrefix            = "";
        ICF.outputPostfix           = "_c";
        ICF.outputSampleFormat      = ImageCalibration.prototype.f32;
        ICF.overwriteExistingFiles  = true;
        ICF.onError                 = ImageCalibration.prototype.Continue;
        ICF.noGUIMessages           = true;
        ICF.useFileThreads          = true;
        ICF.fileThreadOverload      = 1.00;
        ICF.maxFileReadThreads      = 0;
        ICF.maxFileWriteThreads     = 0;

        if (!ICF.executeGlobal())
            throw new Error("Flat pre-calibration (dark subtraction) failed.");

        // Collect calibrated flat files
        var calibFlats = [];
        for (var i = 0; i < flatRawFiles.length; i++) {
            var base = File.extractName(flatRawFiles[i]).replace(/\.fit$/i, "");
            var cf = calibFlatDir + "/" + base + "_c.xisf";
            if (fileExists(cf)) calibFlats.push(cf);
        }
        if (calibFlats.length > 0) {
            flatsToIntegrate = calibFlats;
            log("  Pre-calibrated " + calibFlats.length + " flat frames with master dark.");
        }
    }

    // Step B: integrate CFA flats into a CFA master flat
    var images = [];
    for (var i = 0; i < flatsToIntegrate.length; i++)
        images.push([true, flatsToIntegrate[i], "", ""]);

    var II = new ImageIntegration;
    II.images                   = images;
    II.inputHints               = (masterDarkFile !== null) ? "" :
                                   "fits-keywords normalize raw cfa use-roworder-keywords signed-is-physical";
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

    // Save to local temp first to avoid SMB rename failures
    var localTmp = File.systemTempDirectory + "/master_flat_tmp.xisf";
    var wins = ImageWindow.windows;
    var saved = false;
    for (var i = wins.length - 1; i >= 0; i--) {
        if (!wins[i].isNull) {
            var id = wins[i].currentView.id;
            if (id.indexOf("rejection") < 0 && id.indexOf("slope") < 0) {
                wins[i].saveAs(localTmp, false, false, false, false);
                saved = true;
                break;
            }
        }
    }
    var allWins = ImageWindow.windows;
    for (var i = allWins.length - 1; i >= 0; i--)
        if (!allWins[i].isNull) allWins[i].close();

    if (!saved) throw new Error("Master flat: integration window not found.");

    if (fileExists(outputFile)) File.remove(outputFile);
    File.copyFile(outputFile, localTmp);
    File.remove(localTmp);

    // Clean up temp calibrated flat files
    if (masterDarkFile !== null) {
        for (var i = 0; i < flatsToIntegrate.length; i++)
            if (fileExists(flatsToIntegrate[i])) File.remove(flatsToIntegrate[i]);
    }

    return outputFile;
}

// ── Step 3: ImageCalibration (raw CFA lights) ────────────────
// Applies master dark and/or master flat to raw CFA light subs.
// Inputs are raw .fit files; outputs are calibrated CFA .xisf files.
// Uses WBPP-proven IC settings (enableCFA=true, CFA-aware processing).
// masterDarkFile and masterFlatFile may be null.
// Returns array of calibrated output file paths.
function runImageCalibration(rawFitFiles, outputDir, masterDarkFile, masterFlatFile) {
    var IC = new ImageCalibration;

    // targetFrames format: [[enabled, path], ...]
    var inputFilesArray = [];
    for (var i = 0; i < rawFitFiles.length; i++)
        inputFilesArray.push([true, rawFitFiles[i]]);
    IC.targetFrames            = inputFilesArray;

    // CFA-mode: calibrate raw Bayer pattern before debayering
    IC.enableCFA               = true;
    IC.cfaPattern              = ImageCalibration.prototype.Auto;
    IC.inputHints              = "fits-keywords normalize only-first-image raw cfa use-roworder-keywords signed-is-physical";
    IC.outputHints             = "properties fits-keywords no-compress-data block-alignment 4096 max-inline-block-size 3072 no-embedded-data no-resolution ";
    IC.pedestal                = 0;
    IC.pedestalMode            = ImageCalibration.prototype.Keyword;
    IC.pedestalKeyword         = "";

    IC.outputDirectory         = outputDir;
    IC.outputExtension         = ".xisf";
    IC.outputPrefix            = "";
    IC.outputPostfix           = "_c";
    IC.outputSampleFormat      = ImageCalibration.prototype.f32;
    IC.overwriteExistingFiles  = true;
    IC.onError                 = ImageCalibration.prototype.Continue;

    // Master dark
    IC.masterBiasEnabled       = false;
    IC.masterDarkEnabled       = (masterDarkFile !== null);
    IC.masterDarkPath          = masterDarkFile || "";
    IC.masterFlatEnabled       = (masterFlatFile !== null);
    IC.masterFlatPath          = masterFlatFile || "";

    IC.calibrateBias           = true;
    IC.calibrateDark           = false;
    IC.calibrateFlat           = false;
    IC.optimizeDarks           = false;  // exact exposure match
    IC.darkOptimizationThreshold = 0.00000;
    IC.darkOptimizationLow     = 3.0000;
    IC.darkOptimizationWindow  = 0;
    IC.darkCFADetectionMode    = ImageCalibration.prototype.DetectCFA;
    IC.separateCFAFlatScalingFactors = true;
    IC.flatScaleClippingFactor = 0.05;

    IC.evaluateNoise           = true;
    IC.noiseEvaluationAlgorithm = ImageCalibration.prototype.NoiseEvaluation_MRS;
    IC.evaluateSignal          = true;
    IC.structureLayers         = 5;
    IC.saturationThreshold     = 1.00;
    IC.saturationRelative      = false;
    IC.noiseLayers             = 1;
    IC.hotPixelFilterRadius    = 1;
    IC.noiseReductionFilterRadius = 0;
    IC.minStructureSize        = 0;
    IC.psfType                 = ImageCalibration.prototype.PSFType_Moffat4;
    IC.psfGrowth               = 1.00;
    IC.maxStars                = 24576;

    IC.generateHistoryProperties = true;
    IC.generateFITSKeywords    = true;
    IC.noGUIMessages           = true;
    IC.useFileThreads          = true;
    IC.fileThreadOverload      = 1.00;
    IC.maxFileReadThreads      = 0;
    IC.maxFileWriteThreads     = 0;

    log("  IC targetFrames: " + inputFilesArray.length + " raw CFA files");
    log("  IC outputDirectory: " + IC.outputDirectory);
    log("  IC masterDark: " + (IC.masterDarkEnabled ? IC.masterDarkPath : "none"));
    log("  IC masterFlat: " + (IC.masterFlatEnabled ? IC.masterFlatPath : "none"));

    if (inputFilesArray.length === 0)
        throw new Error("ImageCalibration: no input files.");

    if (!IC.executeGlobal())
        throw new Error("ImageCalibration failed.");

    // Collect output files — IC appends _c to the base filename
    var outputFiles = [];
    for (var i = 0; i < rawFitFiles.length; i++) {
        var base    = File.extractName(rawFitFiles[i]).replace(/\.fit$/i, "");
        var outFile = outputDir + "/" + base + "_c.xisf";
        if (fileExists(outFile)) {
            outputFiles.push(outFile);
        } else {
            log("  WARNING: expected calibrated output not found: " + outFile);
        }
    }
    log("  Calibrated " + outputFiles.length + " raw CFA light frames.");
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
        var outFile = outputDir + "/" + base + "_d.xisf";  // base already has _c suffix

        // Open with CFA hint so PI treats BAYERPAT keyword correctly
        var wins = ImageWindow.open(inFile, "", "fits-keywords normalize");
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

// ── Step 5: LocalNormalization ───────────────────────────────
// Normalizes all registered frames against a reference frame.
// referenceFile: path to the reference image (best registered frame).
// Returns array of normalized output file paths (_n.xisf).
function runLocalNormalization(registeredFiles, referenceFile, outputDir) {
    if (registeredFiles.length < 2) {
        log("  LocalNormalization skipped — fewer than 2 registered frames.");
        return registeredFiles;
    }

    // targetItems format: [[enabled, path], ...]
    var targetItems = [];
    for (var i = 0; i < registeredFiles.length; i++)
        targetItems.push([true, registeredFiles[i]]);

    var LN = new LocalNormalization;
    LN.referencePathOrViewId    = referenceFile;
    LN.referenceIsView          = false;
    LN.targetItems              = targetItems;
    LN.inputHints               = "";
    LN.outputHints              = "";
    LN.scale                    = 1024;
    LN.noScale                  = false;
    LN.globalLocationNormalization = false;
    LN.truncate                 = true;
    LN.backgroundSamplingDelta  = 32;
    LN.rejection                = true;
    LN.referenceRejection       = false;
    LN.lowClippingLevel         = 0.000045;
    LN.highClippingLevel        = 0.850000;
    LN.referenceRejectionThreshold = 3.00;
    LN.targetRejectionThreshold = 3.20;
    LN.hotPixelFilterRadius     = 2;
    LN.noiseReductionFilterRadius = 0;
    LN.modelScalingFactor       = 8;
    LN.scaleEvaluationMethod    = LocalNormalization.prototype.ScaleEvaluationMethod_PSFSignal;
    LN.localScaleCorrections    = false;
    LN.psfStructureLayers       = 5;
    LN.saturationThreshold      = 0.75;
    LN.saturationRelative       = true;
    LN.rejectionLimit           = 0.30;
    LN.psfRejectionLimit        = 0.30;
    LN.psfNoiseLayers           = 1;
    LN.psfHotPixelFilterRadius  = 1;
    LN.psfNoiseReductionFilterRadius = 0;
    LN.psfMinStructureSize      = 0;
    LN.psfMinSNR                = 40;
    LN.psfAllowClusteredSources = true;
    LN.psfType                  = LocalNormalization.prototype.PSFType_Auto;
    LN.psfGrowth                = 1.00;
    LN.psfMaxStars              = 24576;
    LN.generateNormalizedImages = LocalNormalization.prototype.GenerateNormalizedImages_GlobalExecutionOnly;
    LN.generateNormalizationData = true;
    LN.generateInvalidData      = false;
    LN.generateHistoryProperties = true;
    LN.noGUIMessages            = true;
    LN.autoMemoryLimit          = 0.85;
    LN.outputDirectory          = outputDir;
    LN.outputExtension          = ".xisf";
    LN.outputPrefix             = "";
    LN.outputPostfix            = "_n";
    LN.overwriteExistingFiles   = true;
    LN.onError                  = LocalNormalization.prototype.OnError_Continue;
    LN.useFileThreads           = true;
    LN.fileThreadOverload       = 1.00;
    LN.maxFileReadThreads       = 0;
    LN.maxFileWriteThreads      = 0;

    if (!LN.executeGlobal())
        throw new Error("LocalNormalization failed.");

    // Collect normalized output files
    var outputFiles = [];
    for (var i = 0; i < registeredFiles.length; i++) {
        var base    = File.extractName(registeredFiles[i]).replace(/\.xisf$/i, "");
        var outFile = outputDir + "/" + base + "_n.xisf";
        if (fileExists(outFile)) {
            outputFiles.push(outFile);
        } else {
            log("  WARNING: LN output not found: " + outFile + " — using registered file");
            outputFiles.push(registeredFiles[i]);
        }
    }
    log("  LocalNormalization: " + outputFiles.length + " frames normalized.");
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
    SA.sensitivity                  = 0.10;  // lowered from 0.50 to detect more stars
    SA.peakResponse                 = 0.80;  // raised to prefer sharper star peaks
    SA.brightThreshold              = 3.00;
    SA.maxStarDistortion            = 0.60;
    SA.allowClusteredSources        = true;  // allow stars near galaxy cores
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
    SA.restrictToPreviews           = false;  // false for global execution
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
// normDataFiles: optional array of .xnml paths from LocalNormalization (parallel to registeredFiles)
function runImageIntegration(registeredFiles, drizzleFiles, outputDir, normDataFiles) {
    var images = [];
    for (var i = 0; i < registeredFiles.length; i++) {
        var xdrz = (drizzleFiles && drizzleFiles[i]) ? drizzleFiles[i] : "";
        var xnml = (normDataFiles && normDataFiles[i]) ? normDataFiles[i] : "";
        images.push([true, registeredFiles[i], xdrz, xnml]);
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

    var base          = processedBase || (NAS_PROCESSED_ROOT + "/" + friendlyName(objectName) + "/" + dateStr);
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
        var staleCount = removeNonLightFiles(calibratedDir) + removeNonLightFiles(debayeredDir) + removeNonLightFiles(registeredDir);
        if (staleCount > 0)
            log("  Removed " + staleCount + " stale non-Light_ file(s) from previous run.");

        // ── Steps 1-2: Build calibration masters ─────────────
        var masterDarkFile = null;
        var masterFlatFile = null;
        var darkBuilt = false, flatBuilt = false;

        if (darkRawFiles.length > 0) {
            var darkCacheKey = darkResult.date + "/" + lightExp + "s";
            var darkOut = darkResult.dir + "/master_dark_" + lightExp + "s.xisf";
            if (g_masterDarkCache.hasOwnProperty(darkCacheKey)) {
                masterDarkFile = g_masterDarkCache[darkCacheKey];
                log("\n[1/7] Master dark reused from this run: " + masterDarkFile);
            } else if (fileExists(darkOut)) {
                masterDarkFile = darkOut;
                g_masterDarkCache[darkCacheKey] = masterDarkFile;
                log("\n[1/7] Master dark already exists, skipping rebuild: " + darkOut);
            } else {
                log("\n[1/7] Building master dark (" + darkRawFiles.length + " \u00d7 " + lightExp + "s)...");
                masterDarkFile = buildMasterDark(darkRawFiles, darkOut);
                closeAllWindows();
                g_masterDarkCache[darkCacheKey] = masterDarkFile;
                log("  Master dark: " + darkOut);
            }
            darkBuilt = true;
            darkStatus = "\u2713 USED \u2014 " + darkRawFiles.length + " \u00d7 " + lightExp + "s frames";
        } else {
            log("\n[1/7] Master dark SKIPPED \u2014 " + darkStatus);
        }

        if (flatRawFiles.length > 0) {
            var flatCacheKey = flatResult.date;
            var flatOut = flatResult.dir + "/master_flat_" + flatResult.date + ".xisf";
            if (g_masterFlatCache.hasOwnProperty(flatCacheKey)) {
                masterFlatFile = g_masterFlatCache[flatCacheKey];
                log("\n[2/7] Master flat reused from this run: " + masterFlatFile);
            } else if (fileExists(flatOut)) {
                // Validate it's a CFA (1-channel) master, not an old RGB one
                var flatWins = ImageWindow.open(flatOut);
                var flatChannels = (flatWins && flatWins.length > 0 && !flatWins[0].isNull)
                    ? flatWins[0].mainView.image.numberOfChannels : 0;
                if (flatWins && flatWins.length > 0 && !flatWins[0].isNull) flatWins[0].close();
                if (flatChannels === 3) {
                    log("\n[2/7] Existing master flat is RGB (old format) — deleting and rebuilding as CFA...");
                    File.remove(flatOut);
                    masterFlatFile = buildMasterFlat(flatRawFiles, masterDarkFile, flatOut);
                    closeAllWindows();
                    g_masterFlatCache[flatCacheKey] = masterFlatFile;
                    log("  Master flat (CFA): " + flatOut);
                } else {
                    masterFlatFile = flatOut;
                    g_masterFlatCache[flatCacheKey] = masterFlatFile;
                    log("\n[2/7] Master flat already exists, skipping rebuild: " + flatOut);
                }
            } else {
                log("\n[2/7] Building master flat (" + flatRawFiles.length + " raw CFA frames)...");
                masterFlatFile = buildMasterFlat(flatRawFiles, masterDarkFile, flatOut);
                closeAllWindows();
                g_masterFlatCache[flatCacheKey] = masterFlatFile;
                log("  Master flat (CFA): " + flatOut);
            }
            flatBuilt = true;
            flatStatus = "\u2713 USED \u2014 " + flatRawFiles.length + " frames (CFA master)";
        } else {
            log("\n[2/7] Master flat SKIPPED \u2014 " + flatStatus);
        }

        // ── Step 3: ImageCalibration on raw CFA lights ────────
        var calibFiles = null;
        if (masterDarkFile !== null || masterFlatFile !== null) {
            log("\n[3/7] ImageCalibration (raw CFA lights)...");
            calibFiles = runImageCalibration(fitFiles, calibratedDir, masterDarkFile, masterFlatFile);
            closeAllWindows();
        } else {
            log("\n[3/7] ImageCalibration SKIPPED \u2014 no calibration masters available.");
            log("  WARNING: Proceeding with uncalibrated light frames.");
        }

        // ── Step 4: Debayer (calibrated CFA or raw if no calibration) ─
        var filesToDebayer = (calibFiles !== null) ? calibFiles : fitFiles;
        log("\n[4/7] Debayer " + (calibFiles !== null ? "calibrated CFA" : "raw") + " lights (RGGB/VNG)...");
        var dbFiles = runDebayer(filesToDebayer, debayeredDir);
        closeAllWindows();

        log("\n[5/8] StarAlignment + drizzle data...");
        var saResult = runStarAlignment(dbFiles, registeredDir);
        closeAllWindows();

        if (saResult.registered.length === 0)
            throw new Error("No registered files produced by StarAlignment.");

        log("\n[6/8] LocalNormalization...");
        var lnFiles = runLocalNormalization(saResult.registered, saResult.registered[0], registeredDir);
        closeAllWindows();

        // Pass normalization data files (.xnml) to ImageIntegration
        // They are written alongside the _n.xisf files with the same base name
        var lnDataFiles = [];
        for (var i = 0; i < lnFiles.length; i++) {
            var xnml = lnFiles[i].replace(/_n\.xisf$/i, "_n.xnml");
            lnDataFiles.push(fileExists(xnml) ? xnml : "");
        }
        var nLN = lnDataFiles.filter(function(f){ return f !== ""; }).length;
        log("  " + nLN + " normalization data files (.xnml) found.");

        log("\n[7/8] ImageIntegration...");
        runImageIntegration(lnFiles, saResult.drizzle, masterDir, lnDataFiles);
        closeAllWindows();

        var validDrizzle = saResult.drizzle.filter(function(f){ return f !== ""; });
        if (validDrizzle.length > 0) {
            log("\n[8/8] DrizzleIntegration (" + DRIZZLE_SCALE + "x, " +
                validDrizzle.length + " frames)...");
            var drizzleOut = masterDir + "/drizzle_" +
                objectName.replace(/ /g, "_") + "_" + dateStr + ".xisf";
            runDrizzleIntegration(saResult.drizzle, drizzleOut);
            closeAllWindows();
            finalOutput = drizzleOut;

            // Plate solve the drizzle output
            log("\n[8+] ImageSolver...");
            var solveWins = ImageWindow.open(drizzleOut);
            if (solveWins && solveWins.length > 0 && !solveWins[0].isNull) {
                var solved = runImageSolver(solveWins[0], DRIZZLE_SCALE);
                if (solved) {
                    solveWins[0].saveAs(drizzleOut, false, false, false, false);
                    log("  Plate solution saved to: " + drizzleOut);
                }
                solveWins[0].forceClose();
            }
        } else {
            log("\n[8/8] WARNING: DrizzleIntegration skipped \u2014 no .xdrz files.");
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
            Console.writeln("\nMosaic detected: " + base + " (" + panels.length + " panels)");
            // Shared processed parent: NAS_PROCESSED_ROOT/<base>/<dateStr>
            // Each panel gets its own subfolder within that parent.
            for (var p = 0; p < panels.length; p++) {
                var panelName    = panels[p];
                var processedBase = NAS_PROCESSED_ROOT + "/" + friendlyName(base) + "/" + dateStr + "/" + panelName;
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

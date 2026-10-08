#engine v8

// ============================================================
// test_solver.js — standalone ImageSolver embedding diagnostic
// Target: PixInsight 1.9.5 (V8), ImageSolver 6.5.0
//
// Purpose: find out whether ImageSolver can be #included as a library and
// called from our own script, WITHOUT the old AdP/SpiderMonkey scaffolding
// (no Ext_DataType_* variables, no eval of the settings-module name).
//
// Usage:
//   run -x=auto "F:/repos/AstroScripts/test_solver.js"
//   A file dialog opens: pick a drizzle or integration master, e.g.
//   Z:/Processed/<Object>/2026-10-05/master/drizzle_<Object>_2026-10-05.xisf
//
// The source file is never modified. If the solve succeeds, a copy is
// written next to it as <name>_solvetest.xisf to check whether the
// solution survives a save and reload.
// ============================================================

// Library-mode contract: both defines must come BEFORE the include.
#define SETTINGS_MODULE "AstroPreprocessSolver"
#define USE_SOLVER_LIBRARY

// The include path is fixed at compile time, so it cannot use a variable.
// Windows default install shown. On the Mac, swap to the second line.
#include "C:/Program Files/PixInsight/src/scripts/ImageSolver/ImageSolver.js"
// #include "/Applications/PixInsight/src/scripts/ImageSolver/ImageSolver.js"

// ── Settings ─────────────────────────────────────────────────
var START_DIR      = "Z:/Processed";
var PIXEL_SIZE_UM  = 3.76;    // ASI533 MC Pro
var FALLBACK_SCALE = 0.733;   // arcsec/px at native sampling, used only if
                              // the image has no FOCALLEN keyword
// Scale seeds tried in order, as multiples of the computed scale. Covers a
// wrong drizzle guess (2x drizzle halves the arcsec/px) without hand edits.
var SCALE_FACTORS  = [1, 0.5, 2];

function say(s) { Console.writeln(s); Console.flush(); }

function isoToJulianDate(iso) {
    var ms = Date.parse(String(iso).replace(/'/g, "").trim());
    if (isNaN(ms)) {
        // Keyword has no timezone suffix: treat it as UTC.
        ms = Date.parse(String(iso).replace(/'/g, "").trim() + "Z");
    }
    return isNaN(ms) ? null : ms / 86400000 + 2440587.5;
}

function keywordValue(win, name) {
    var k = win.keywords;
    for (var i = 0; i < k.length; i++)
        if (k[i].name === name)
            return String(k[i].value).replace(/'/g, "").trim();
    return null;
}

function hasSolution(win) {
    // Property on 1.9.x windows; guarded in case the name differs.
    try { return !!win.hasAstrometricSolution; } catch (e) { return false; }
}

function runTest() {
    say("\n===== test_solver: ImageSolver library embedding =====");
    say("PixInsight : " + CoreApplication.versionMajor + "." +
        CoreApplication.versionMinor + "." + CoreApplication.versionRelease);
    say("ImageSolver type : " + (typeof ImageSolver));
    if (typeof ImageSolver !== "function") {
        say("FAIL [include]: ImageSolver is not defined after the #include.");
        return;
    }
    say("PASS [include]: library loaded with no scaffolding.");

    var ofd = new OpenFileDialog;
    ofd.caption     = "Pick a master image to plate solve (e.g. a 2026-10-05 drizzle)";
    ofd.initialPath = START_DIR;
    ofd.filters     = [["XISF / FITS", "*.xisf", "*.fit", "*.fits"]];
    if (!ofd.execute()) { say("Cancelled."); return; }
    var path = ofd.filePath;
    say("File : " + path);

    var wins = ImageWindow.open(path);
    if (!wins || wins.length === 0 || wins[0].isNull) {
        say("FAIL [open]: could not open the file.");
        return;
    }
    var win = wins[0];
    var W = win.mainView.image.width, H = win.mainView.image.height;
    say("Image : " + W + " x " + H + ", existing solution: " + hasSolution(win));

    try {
        var solver = new ImageSolver();
        say("PASS [construct]: new ImageSolver()");

        // Report which entry points this version exposes.
        var names = ["initialize", "Init", "solveImage", "SolveImage"];
        var have = [];
        for (var n = 0; n < names.length; n++)
            if (typeof solver[names[n]] === "function") have.push(names[n]);
        say("Methods present : " + (have.length ? have.join(", ") : "(none of the expected ones)"));

        // initialize() loads the settings last saved from the ImageSolver
        // dialog (catalog, magnitude limits) and reads the image metadata.
        if (typeof solver.initialize === "function")      solver.initialize(win, false);
        else if (typeof solver.Init === "function")       solver.Init(win, false);
        say("PASS [initialize]");

        var c = solver.solverCfg;
        c.showStars            = false;
        c.showStarMatches      = false;
        c.showDistortion       = false;
        c.showSimplifiedSurfaces = false;
        c.generateErrorImg     = false;
        c.generateDistortModel = false;
        say("Catalog (from saved ImageSolver settings) : " + c.catalog +
            "  mode=" + c.catalogMode);

        // Seed position, scale and time from the image keywords where the
        // library has not already picked them up.
        var m = solver.metadata;
        var ra = keywordValue(win, "RA"), dec = keywordValue(win, "DEC");
        if (ra !== null  && !isNaN(parseFloat(ra)))  m.ra  = parseFloat(ra);
        if (dec !== null && !isNaN(parseFloat(dec))) m.dec = parseFloat(dec);

        var focal = parseFloat(keywordValue(win, "FOCALLEN"));
        var nativeScale = (focal > 0) ? 206.265 * PIXEL_SIZE_UM / focal : FALLBACK_SCALE;
        // Guess the drizzle factor from the frame size (sensor is 3008 px).
        var drizzle = Math.max(1, Math.round(W / 3008));
        var baseScale = nativeScale / drizzle;   // arcsec/px
        m.xpixsz   = PIXEL_SIZE_UM / drizzle;
        m.useFocal = false;

        var jd = isoToJulianDate(keywordValue(win, "DATE-OBS") || "");
        if (jd === null) jd = Date.now() / 86400000 + 2440587.5;

        say("Seed : RA=" + m.ra + "  Dec=" + m.dec +
            "  FOCALLEN=" + (focal > 0 ? focal : "(none)") +
            "  drizzle guess=" + drizzle + "x  scale=" + baseScale.toFixed(3) + "\"/px");
        if (m.ra === undefined || m.ra === null || isNaN(m.ra) ||
            m.dec === undefined || m.dec === null || isNaN(m.dec)) {
            say("FAIL [seed]: no RA/DEC in the image keywords, cannot seed the solve.");
            return;
        }

        var solved = false;
        for (var a = 0; a < SCALE_FACTORS.length && !solved; a++) {
            m.resolution      = (baseScale * SCALE_FACTORS[a]) / 3600;   // degrees/px
            m.observationTime = jd;   // set last: other assignments can clear it
            say("\n--- Attempt " + (a + 1) + ": seed scale " +
                (m.resolution * 3600).toFixed(3) + "\"/px ---");
            var ret, err = null;
            try {
                if (typeof solver.solveImage === "function")      ret = solver.solveImage(win);
                else if (typeof solver.SolveImage === "function") ret = solver.SolveImage(win);
                else throw new Error("no solveImage/SolveImage method on this ImageSolver");
            } catch (e) {
                err = (e && e.message) ? e.message : String(e);
                ret = false;
            }
            solved = (ret === true) || (ret === undefined && hasSolution(win));
            say("Result : return=" + ret + "  hasAstrometricSolution=" + hasSolution(win) +
                (err ? "  error=" + err : ""));
        }

        if (!solved) {
            say("\nFAIL [solve]: library loaded and ran, but no solution was found.");
            say("  If the errors above mention the catalog or XPSD server, open the");
            say("  ImageSolver script once by hand, solve any image with a catalog that");
            say("  works for you, then re-run this test (it reuses those saved settings).");
            return;
        }
        say("\nPASS [solve]: plate solution computed from an embedded library call.");

        // Persistence check, on a copy so the source master is untouched.
        var out = path.replace(/\.(xisf|fits?)$/i, "") + "_solvetest.xisf";
        win.saveAs(out, false, false, false, false);
        var back = ImageWindow.open(out);
        if (back && back.length > 0 && !back[0].isNull) {
            var kept = hasSolution(back[0]);
            say((kept ? "PASS" : "FAIL") + " [persist]: solution " +
                (kept ? "survived" : "was LOST on") + " saveAs + reload.");
            say("  Test copy : " + out + "  (safe to delete)");
            back[0].forceClose();
        } else {
            say("FAIL [persist]: could not reopen " + out);
        }
    } catch (e) {
        say("\nFAIL [exception]: " + ((e && e.message) ? e.message : String(e)));
        if (e && e.stack) say(String(e.stack));
    } finally {
        win.forceClose();
    }
}

runTest();
say("\n===== test_solver done =====");

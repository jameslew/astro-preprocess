// test_solver.js — standalone ImageSolver diagnostic
// Run from PI Script Editor to test plate solving without full pipeline reprocess
//
// Usage: run --execute-mode=auto "F:/repos/AstroScripts/test_solver.js"

#define USE_SOLVER_LIBRARY
#include "C:/Program Files/PixInsight/src/scripts/AdP/ImageSolver.js"

if (typeof Ext_DataType_Complex     === "undefined") var Ext_DataType_Complex     = 1000;
if (typeof Ext_DataType_StringArray === "undefined") var Ext_DataType_StringArray = 1001;
if (typeof Ext_DataType_JSON        === "undefined") var Ext_DataType_JSON        = 1002;

var TEST_FILE = "Z:/Processed/M 82 - Cigar Galaxy/2026-04-07/master/drizzle_M_82_2026-04-07.xisf";
var DRIZZLE_SCALE = 2.0;

function isoToJulianDate(iso) {
    var s = iso.replace(/'/g, "").trim();
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?/);
    if (!m) return null;
    var Y = parseInt(m[1]), M = parseInt(m[2]), D = parseInt(m[3]);
    var h = parseInt(m[4]), mn = parseInt(m[5]), sc = parseFloat((m[6]||"0") + (m[7]||""));
    var A = Math.floor((14 - M) / 12);
    var y = Y + 4800 - A;
    var mo = M + 12 * A - 3;
    var JDN = D + Math.floor((153 * mo + 2) / 5) + 365 * y +
              Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
    return JDN + (h - 12) / 24 + mn / 1440 + sc / 86400;
}

Console.writeln("Opening: " + TEST_FILE);
var wins = ImageWindow.open(TEST_FILE);
if (!wins || wins.length === 0 || wins[0].isNull) {
    Console.writeln("ERROR: Could not open file");
} else {
    var win = wins[0];
    Console.writeln("Opened OK. Checking for existing solution...");

    var checkMeta = new ImageMetadata();
    checkMeta.ExtractMetadata(win);
    Console.writeln("ref_I_G: " + checkMeta.ref_I_G);
    Console.writeln("resolution: " + (checkMeta.resolution * 3600) + " arcsec/px");

    if (checkMeta.ref_I_G !== null) {
        Console.writeln("Already fully solved — skipping.");
    } else {
        Console.writeln("No plate solution — running ImageSolver...");

        var solver = new ImageSolver();
        solver.solverCfg.useActive            = false;
        solver.solverCfg.showStars            = false;
        solver.solverCfg.showDistortion       = false;
        solver.solverCfg.generateErrorImg     = false;
        solver.solverCfg.catalog              = "GaiaDR3_XPSD";
        solver.solverCfg.autoMagnitude        = true;
        solver.solverCfg.distortionCorrection = true;
        solver.solverCfg.maxIterations        = 10;

        solver.metadata.width    = win.mainView.image.width;
        solver.metadata.height   = win.mainView.image.height;
        solver.metadata.xpixsz   = 3.76;
        solver.metadata.useFocal = false;
        solver.metadata.resolution = (0.733 / DRIZZLE_SCALE) / 3600;

        var keys = win.keywords;
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].name === "RA")       solver.metadata.ra  = parseFloat(keys[i].value);
            if (keys[i].name === "DEC")      solver.metadata.dec = parseFloat(keys[i].value);
            if (keys[i].name === "DATE-OBS") {
                var jd = isoToJulianDate(keys[i].value);
                if (jd) { solver.metadata.epoch = jd; solver.metadata.observationTime = jd; }
            }
        }
        Console.writeln("Seeded: RA=" + solver.metadata.ra + " Dec=" + solver.metadata.dec +
            " res=" + (solver.metadata.resolution * 3600).toFixed(3) + " epoch=" + solver.metadata.epoch);

        var result = solver.SolveImage(win);
        Console.writeln("SolveImage result: " + result);

        if (result) {
            Console.writeln("Solved! Saving with preserve=true...");
            win.saveAs(TEST_FILE, false, false, false, true);
            Console.writeln("Saved. Reopening to verify...");
            var verWins = ImageWindow.open(TEST_FILE);
            if (verWins && !verWins[0].isNull) {
                Console.writeln("Reopened: image properties count would show in PI load log");
                var vMeta = new ImageMetadata();
                vMeta.ExtractMetadata(verWins[0]);
                Console.writeln("Verify ref_I_G: " + (vMeta.ref_I_G !== null ? "PRESENT" : "MISSING"));
                verWins[0].forceClose();
            }
        }
    }
    win.forceClose();
}
Console.writeln("Done.");

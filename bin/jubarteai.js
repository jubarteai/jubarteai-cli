#!/usr/bin/env node
// The only file Node loads before the floor check, so it must parse on every
// Node >= 12: no optional chaining, no nullish coalescing, no top-level await.
//
// FLOORS must match src/node-floor.ts and package.json "engines.node"
// ("^22.23.5 || ^24.22.3 || >=26.13.1"). Odd majors are refused.

var FLOORS = { 22: "22.23.5", 24: "24.22.3", 26: "26.13.1" };
var LAST_LINE = 26;
var DOWNLOAD = "https://nodejs.org/en/download";

function parse(version) {
  var parts = String(version).split(".");
  return [Number(parts[0]), Number(parts[1]) || 0, Number(parts[2]) || 0];
}

function atLeast(have, floor) {
  var want = parse(floor);
  for (var i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return true;
}

// The floor to name for a Node major that is not supported as it stands.
function floorFor(major) {
  if (FLOORS[major]) return FLOORS[major];
  if (major < 22) return FLOORS[22];
  if (major > LAST_LINE) return String(major + 1) + ".0.0";
  return FLOORS[major + 1];
}

function supported(version) {
  var have = parse(version);
  var major = have[0];
  if (major % 2 !== 0) return false;
  if (major < 22) return false;
  if (major > LAST_LINE) return true;
  return atLeast(have, FLOORS[major]);
}

var current = process.versions.node;
// A hook never fails the harness (spec section 8, I7): under an unsupported Node it exits 0 and says nothing.
var isHook = process.argv[2] === "hook";

if (!supported(current)) {
  if (isHook) process.exit(0);
  var major = parse(current)[0];
  process.stderr.write(
    "jubarteai needs Node " +
      floorFor(major) +
      " or newer (you have " +
      current +
      "). Upgrade: " +
      DOWNLOAD +
      "\n",
  );
  process.exit(1);
}

import("../dist/main.js").then(
  function (entry) {
    return entry.main(process.argv.slice(2)).then(
      function (code) {
        process.exitCode = code;
      },
      function (error) {
        if (!isHook) throw error;
        process.exitCode = 0;
      },
    );
  },
  function (error) {
    if (isHook) process.exit(0);
    process.stderr.write("jubarteai failed to start: " + (error && error.message ? error.message : String(error)) + "\n");
    process.exit(1);
  },
);

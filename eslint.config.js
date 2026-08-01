// Lint for the proxy. Added Aug 1 2026 after a DUPLICATE OBJECT KEY shipped a broken feature:
// server.js declared maxByRadius twice in one literal, JavaScript kept the last, and the "at the
// field" heat view scaled colour by a number ~65x too large for as long as that radius existed
// (commit 2c7cb51). `no-dupe-keys` catches it in one second and had never been run here.
// The frontend had eslint from the start — this repo never did, and it is the one that shipped
// the bug.
//
// DELIBERATELY MINIMAL. The frontend carries 59 problems, 54 of them one rule family, and that
// backlog is why lint has never entered CI there. Starting narrow here means the rules that run
// are ones we will actually keep green.
const globals = require("globals");

module.exports = [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      // THE ONE THAT MATTERS. Silent, legal, and it broke a feature for weeks.
      "no-dupe-keys": "error",
      // Same family: a duplicate case or a self-comparison is never intentional.
      "no-duplicate-case": "error",
      "no-self-compare": "error",
      // Caught real classes of bug in this codebase before: a guarded call that silently did
      // nothing, and unreachable code after an early return.
      "no-unreachable": "error",
      "no-constant-condition": "error",
      "no-unsafe-negation": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      // Unused variables are how DEF-042 was found, and how orphaned code survives a refactor.
      // WARN not error: the archive and sweep code has legitimately unused catch bindings.
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      // An empty block is usually a swallowed error. Allow it in catch, where this codebase
      // deliberately ignores failures with a comment saying why.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // airports.csv-derived output and anything generated
    ignores: ["node_modules/**", "airfields.json.gz", "*.txt"],
  },
];

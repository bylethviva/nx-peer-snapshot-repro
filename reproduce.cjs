'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Use the installed, unmodified public Nx serializer. An alternate compiled
// parser can be supplied to validate a later upstream fix with this same test.
const parserPath = process.env.NX_PNPM_PARSER
  ? path.resolve(process.env.NX_PNPM_PARSER)
  : path.join(path.dirname(require.resolve('nx/package.json')), 'dist/src/plugins/js/lock-file/pnpm-parser.js');
const { stringifyPnpmLockfile } = require(parserPath);
const nxRequire = createRequire(require.resolve('nx/package.json'));
const { load } = nxRequire('@zkochan/js-yaml');
const fixtureRoot = path.join(__dirname, 'fixtures/source');
const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'package.json'), 'utf8'));
const source = load(fs.readFileSync(path.join(fixtureRoot, 'pnpm-lock.yaml'), 'utf8'));
const name = '@nestjs/core';
const expected = source.importers['.'].dependencies[name].version;

// Deliberately minimal graph: one external node per public package base version.
// Nx graphs cannot encode multiple peer contexts for the same package version.
// Include the entire public closure, so unrelated graph pruning cannot explain
// a changed root reference. No graph discovery or application startup is claimed.
const graph = { nodes: {}, externalNodes: {}, dependencies: {} };
for (const key of Object.keys(source.packages)) {
  const separator = key.lastIndexOf('@');
  const packageName = key.slice(0, separator);
  const version = key.slice(separator + 1);
  const nodeName = `npm:${packageName}@${version}`;
  graph.externalNodes[nodeName] = {
    type: 'npm', name: nodeName, data: { packageName, version },
  };
}

const results = [];
for (const order of ['original', 'reversed']) {
  const input = structuredClone(source);
  if (order === 'reversed') {
    input.snapshots = Object.fromEntries(Object.entries(input.snapshots).reverse());
  }
  assert.equal(input.importers['.'].dependencies[name].version, expected);
  assert.ok(input.snapshots[`${name}@${expected}`], 'authoritative snapshot must exist');
  const serialized = stringifyPnpmLockfile(graph, JSON.stringify(input), manifest, fixtureRoot);
  const output = load(serialized);
  const selected = output.importers['.'].dependencies[name].version;
  assert.ok(output.snapshots[`${name}@${selected}`], 'selected snapshot must exist');
  assert.equal(selected.split('(')[0], expected.split('(')[0], 'base version must remain equal');
  results.push({ order, authoritative: expected, selected, matches: selected === expected });
}

console.log(JSON.stringify({
  nx: nxRequire('./package.json').version,
  node: process.version,
  parser: parserPath,
  results,
}, null, 2));

if (process.argv.includes('--diagnose')) {
  assert.notEqual(results[0].selected, results[1].selected,
    'Unpatched control should depend on snapshot insertion order');
  assert.ok(results.some(result => !result.matches),
    'Unpatched control should lose the authoritative root reference');
  console.log('Confirmed: snapshot insertion order changes the selected peer context.');
} else {
  for (const result of results) {
    assert.equal(result.selected, expected,
      `${result.order}: Nx must preserve the exact authoritative root importer peer reference`);
  }
  console.log('PASS: authoritative importer preserved in both snapshot orders.');
}

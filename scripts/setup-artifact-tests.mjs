#!/usr/bin/env node
// Bootstrap a standalone skills worktree from the existing local package tree.
// No internal package is published, no source checkout is built in place.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [packagesArg, workflowArg, scratchArg] = process.argv.slice(2);
if (!packagesArg || !workflowArg || !scratchArg) throw new Error('Usage: node scripts/setup-artifact-tests.mjs <packages-tree> <agent-workflow> <scratch-dir>');
const packages = path.resolve(packagesArg);
const scratch = path.resolve(scratchArg);
const sources = { 'artifact-contracts': path.join(packages, 'artifact-contracts'), 'skill-ids': path.join(packages, 'skill-ids'), core: path.join(packages, 'core'), 'ui-memory': path.join(packages, 'ui-memory'), 'agent-workflow': path.resolve(workflowArg) };
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const wanted = read(repo);
const dependencies = { ...wanted.dependencies, ...wanted.devDependencies };
for (const [name, version] of Object.entries(wanted.optionalDependencies || {})) {
  if (!name.startsWith('@zibby/')) dependencies[name] = version;
}
for (const source of Object.values(sources)) Object.assign(dependencies, read(source).dependencies);
for (const name of Object.keys(sources)) delete dependencies[`@zibby/${name}`];
fs.mkdirSync(scratch, { recursive: true });
fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }, null, 2));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
// Keep npm's pruning away from source links while reconciling registry deps.
for (const name of Object.keys(sources)) {
  for (const link of [path.join(scratch, 'node_modules', '@zibby', name), path.join(scratch, name, 'node_modules')]) {
    if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link);
  }
}
run('npm', ['install', '--no-package-lock', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], scratch);
const modules = path.join(scratch, 'node_modules');
fs.mkdirSync(path.join(modules, '@zibby'), { recursive: true });
for (const [name, source] of Object.entries(sources)) {
  const target = path.join(scratch, name);
  fs.cpSync(source, target, { recursive: true, filter: p => !path.relative(source, p).split(path.sep).some(x => ['node_modules', '.git', 'dist'].includes(x)) });
  const link = path.join(modules, '@zibby', name);
  if (!fs.existsSync(link)) fs.symlinkSync(target, link, 'dir');
  const actual = read(target);
  if (wanted.dependencies[actual.name] && wanted.dependencies[actual.name] !== actual.version) throw new Error(`Tree version mismatch for ${actual.name}: wanted ${wanted.dependencies[actual.name]}, found ${actual.version}`);
}
for (const name of ['artifact-contracts', 'core', 'ui-memory']) run('node', [path.join(packages, 'scripts/build.mjs'), ...(name === 'artifact-contracts' ? ['--universal'] : [])], path.join(scratch, name));
run('npm', ['run', 'build:js'], path.join(scratch, 'agent-workflow'));
const repoModules = path.join(repo, 'node_modules');
if (fs.lstatSync(repoModules, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(repoModules);
fs.mkdirSync(repoModules, { recursive: true });
for (const name of fs.readdirSync(modules)) {
  if (!fs.existsSync(path.join(repoModules, name))) fs.symlinkSync(path.join(modules, name), path.join(repoModules, name));
}
console.log(`Standalone test dependencies ready in ${scratch}. Build skills with: node ${path.join(packages, 'scripts/build.mjs')} && npm run build:types`);

#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);
const buildIndex = join(rootDir, 'build', 'index.js');
const srcIndex = join(rootDir, 'src', 'index.ts');

let command;
let args;

if (existsSync(buildIndex)) {
  // Use built version if available
  command = 'node';
  args = [buildIndex, ...process.argv.slice(2)];
} else if (existsSync(srcIndex)) {
  // Fallback to tsx for GitHub clones/npx without build
  command = 'npx';
  args = ['tsx', srcIndex, ...process.argv.slice(2)];
  console.error('ℹ️ Build folder missing, running from source using tsx...');
} else {
  console.error('❌ Error: Could not find build/index.js or src/index.ts');
  process.exit(1);
}

const child = spawn(command, args, {
  stdio: 'inherit',
  shell: true
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

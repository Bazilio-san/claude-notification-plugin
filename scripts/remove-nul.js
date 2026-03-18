#!/usr/bin/env node

/**
 * Script to remove 'nul' file that accidentally gets created on Windows
 * This file is created when using 2>nul redirection in Windows commands
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get project root (parent of scripts directory)
const projectRoot = path.resolve(__dirname, '..');

// File to remove
const nulFile = path.join(projectRoot, 'nul');

// Check if file exists and remove it
if (fs.existsSync(nulFile)) {
  try {
    fs.unlinkSync(nulFile);
    console.log('✅  Removed "nul" file from project root');
  } catch (error) {
    console.error('❌  Error removing "nul" file:', error.message);
    process.exit(1);
  }
} else {
  console.log('ℹ️  No "nul" file found in project root');
}

// Also check for other common accidental files on Windows
const accidentalFiles = ['nul', 'NUL', 'con', 'CON', 'aux', 'AUX', 'prn', 'PRN'];

accidentalFiles.forEach(fileName => {
  const filePath = path.join(projectRoot, fileName);
  if (fs.existsSync(filePath)) {
    try {
      const stats = fs.statSync(filePath);
      if (stats.isFile()) {
        fs.unlinkSync(filePath);
        console.log(`✅  Removed "${fileName}" file from project root`);
      }
    } catch (error) {
      console.error(`⚠️  Could not remove "${fileName}":`, error.message);
    }
  }
});

console.log('🎯 Cleanup completed');

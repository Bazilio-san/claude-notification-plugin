#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function toImportUrl (relativePath) {
  return pathToFileURL(path.join(__dirname, relativePath)).href;
}

const command = process.argv[2];

switch (command) {
  case 'install':
    await import(toImportUrl('install.js'));
    break;
  case 'uninstall':
    await import(toImportUrl('uninstall.js'));
    break;
  case 'listener': {
    // Shift argv so listener-cli.js sees subcommand as argv[2]
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    await import(toImportUrl('listener-cli.js'));
    break;
  }
  default:
    // Hook mode: Claude Code pipes JSON to stdin with no args
    if (!process.stdin.isTTY) {
      await import(toImportUrl(path.join('..', 'notifier', 'notifier.js')));
    } else {
      console.log(`Usage: claude-notify <command> [options]

Commands:
  install              Setup plugin registration, Telegram config, hooks
  uninstall            Remove plugin, hooks, config, CLI wrappers
  listener <action>    Manage the Telegram Listener daemon
                       Actions: start, stop, status, logs, restart`);
      process.exit(command ? 1 : 0);
    }
}

#!/usr/bin/env node

import { Command } from 'commander';
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { homedir } from 'os';
import fs from 'fs';
import { USERS_FILE, loadUsers, addUser, rotateUser, removeUser, userForToken } from '../lib/users.js';
import { writeOnboardingDoc } from '../lib/onboarding.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json automatically
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));

const program = new Command();

// Configuration paths
const CONFIG_DIR = join(homedir(), '.vibe-annotations');
const PID_FILE = join(CONFIG_DIR, 'server.pid');
const LOG_FILE = join(CONFIG_DIR, 'server.log');
const PORT = Number(process.env.VIBE_PORT) || 3846;
// Health checks go to loopback unless the server is bound to one specific address.
const HEALTH_HOST = process.env.VIBE_HOST && process.env.VIBE_HOST !== '0.0.0.0' ? process.env.VIBE_HOST : '127.0.0.1';

// Ensure config directory exists
if (!existsSync(CONFIG_DIR)) {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

// Helper functions
function isServerRunning() {
  if (!existsSync(PID_FILE)) {
    return false;
  }
  
  try {
    const pid = readFileSync(PID_FILE, 'utf8').trim();
    process.kill(parseInt(pid), 0); // Check if process exists
    return true;
  } catch (e) {
    // Process doesn't exist
    if (existsSync(PID_FILE)) {
      // Clean up stale PID file
      unlinkSync(PID_FILE);
    }
    return false;
  }
}

async function checkPort() {
  try {
    const response = await fetch(`http://${HEALTH_HOST}:${PORT}/health`);
    return response.ok;
  } catch (error) {
    return false;
  }
}

// Commands
program
  .name('vibe-annotations-server')
  .description('Global MCP server for Vibe Annotations browser extension')
  .version(packageJson.version);

program
  .command('init')
  .description('Interactive setup wizard: install server, configure MCP, link the extension')
  .option('--agent <name>', 'Configure specific agent (repeatable). One of: claude-code, cursor, windsurf, codex, openclaw, vscode', collectAgent, [])
  .option('--non-interactive', 'No prompts; use defaults. Auto-applied on CI or no TTY.')
  .option('--skip-extension', 'Skip the Chrome extension prompt')
  .option('--skip-server', 'Skip installing/starting the server')
  .option('--project', 'Configure MCP at project scope instead of user scope')
  .option('--reset', 'Remove existing vibe-annotations entries from known agent configs before configuring')
  .action(async (options) => {
    const { runInit } = await import('../lib/init/index.js');
    await runInit({
      agent: options.agent.length ? options.agent : null,
      nonInteractive: !!options.nonInteractive,
      skipExtension: !!options.skipExtension,
      skipServer: !!options.skipServer,
      project: !!options.project,
      reset: !!options.reset,
    });
  });

function collectAgent(value, previous) {
  return previous.concat(value);
}

program
  .command('start')
  .description('Start the Vibe Annotations server')
  .option('-d, --daemon', 'Run as daemon (background process)')
  .action(async (options) => {
    if (isServerRunning()) {
      console.log(chalk.yellow('✓ Server is already running'));
      console.log(chalk.gray(`  Port: ${PORT}`));
      console.log(chalk.gray(`  PID: ${readFileSync(PID_FILE, 'utf8').trim()}`));
      return;
    }

    console.log(chalk.blue('Starting Vibe Annotations server...'));

    const serverPath = join(dirname(__dirname), 'lib', 'server.js');
    
    if (options.daemon) {
      // Run as daemon
      const out = fs.openSync(LOG_FILE, 'a');
      const err = fs.openSync(LOG_FILE, 'a');
      
      const child = spawn('node', [serverPath], {
        detached: true,
        stdio: ['ignore', out, err],
        env: { ...process.env, NODE_ENV: 'production' }
      });
      
      child.unref();
      writeFileSync(PID_FILE, child.pid.toString());
      
      // Wait for server to start
      let attempts = 0;
      while (attempts < 10) {
        if (await checkPort()) {
          console.log(chalk.green(`✅ Vibe Annotations server running on http://${HEALTH_HOST}:${PORT}/sse`));
          console.log(chalk.gray(`   PID: ${child.pid}`));
          console.log(chalk.gray(`   Logs: ${LOG_FILE}`));
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        attempts++;
      }
      
      if (attempts >= 10) {
        console.log(chalk.red('❌ Failed to start server. Check logs at:'));
        console.log(chalk.gray(`   ${LOG_FILE}`));
      }
    } else {
      // Run in foreground
      const child = spawn('node', [serverPath], {
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'production' }
      });
      
      writeFileSync(PID_FILE, child.pid.toString());
      
      child.on('exit', () => {
        if (existsSync(PID_FILE)) {
          unlinkSync(PID_FILE);
        }
      });
    }
  });

program
  .command('stop')
  .description('Stop the Vibe Annotations server')
  .action(() => {
    if (!isServerRunning()) {
      console.log(chalk.yellow('Server is not running'));
      return;
    }
    
    try {
      const pid = readFileSync(PID_FILE, 'utf8').trim();
      process.kill(parseInt(pid), 'SIGTERM');
      
      if (existsSync(PID_FILE)) {
        unlinkSync(PID_FILE);
      }
      
      console.log(chalk.green('✅ Server stopped'));
    } catch (error) {
      console.log(chalk.red('❌ Failed to stop server:'), error.message);
    }
  });

program
  .command('restart')
  .description('Restart the Vibe Annotations server')
  .action(async () => {
    console.log(chalk.blue('Restarting server...'));
    
    // Stop if running
    if (isServerRunning()) {
      try {
        const pid = readFileSync(PID_FILE, 'utf8').trim();
        process.kill(parseInt(pid), 'SIGTERM');
        
        if (existsSync(PID_FILE)) {
          unlinkSync(PID_FILE);
        }
        
        // Wait for process to stop
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.log(chalk.yellow('Warning:'), error.message);
      }
    }
    
    // Start with daemon flag
    program.parse(['node', 'cli.js', 'start', '--daemon'], { from: 'user' });
  });

program
  .command('status')
  .description('Check server status')
  .action(async () => {
    const running = isServerRunning();
    const portAvailable = await checkPort();
    
    if (running && portAvailable) {
      console.log(chalk.green('✅ Server is running'));
      console.log(chalk.gray(`   PID: ${readFileSync(PID_FILE, 'utf8').trim()}`));
      console.log(chalk.gray(`   Port: ${PORT}`));
      console.log(chalk.gray(`   URL: http://127.0.0.1:${PORT}/sse`));
    } else if (running && !portAvailable) {
      console.log(chalk.yellow('⚠️  Server process exists but is not responding'));
      console.log(chalk.gray('   Try running: vibe-annotations-server restart'));
    } else {
      console.log(chalk.gray('○ Server is not running'));
    }
  });

program
  .command('logs')
  .description('View server logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .action((options) => {
    if (!existsSync(LOG_FILE)) {
      console.log(chalk.gray('No logs available yet'));
      return;
    }
    
    if (options.follow) {
      // Use tail -f
      const tail = spawn('tail', ['-f', LOG_FILE], { stdio: 'inherit' });
      
      process.on('SIGINT', () => {
        tail.kill();
        process.exit();
      });
    } else {
      // Show last N lines
      const tail = spawn('tail', ['-n', options.lines, LOG_FILE], { stdio: 'inherit' });
    }
  });

// Team mode — per-user tokens. Adding the first user switches the server to
// team mode (picked up live, no restart).
const users = program
  .command('users')
  .description('Manage team members (per-user tokens for a shared server)');

function printToken(id, token) {
  console.log(chalk.green(`Token for ${id} (shown once — store it now):`));
  console.log(`\n  ${token}\n`);
  console.log(chalk.gray('Extension: Settings → Server → Token'));
  console.log(chalk.gray(`Claude Code: claude mcp add --scope user --transport http vibe-annotations <server-url>/mcp --header "Authorization: Bearer ${token}"`));
}

// URL teammates use to reach this server (goes into their setup guide).
const PUBLIC_URL_HELP = 'Server URL teammates use (default: $VIBE_PUBLIC_URL)';
function publicUrl(options) {
  const url = (options.serverUrl || process.env.VIBE_PUBLIC_URL || '').replace(/\/+$/, '');
  if (!url) throw new Error('Pass --server-url <url> or set VIBE_PUBLIC_URL (e.g. http://my-vps.tailnet.ts.net:3846).');
  return url;
}

function issue(id, token, options) {
  if (!options.doc) return printToken(id, token);
  const user = loadUsers().find(u => u.id === id);
  const file = writeOnboardingDoc(
    { id, name: user?.name || id, token, serverUrl: publicUrl(options) },
    typeof options.doc === 'string' ? options.doc : undefined
  );
  console.log(chalk.green(`Setup guide for ${id} written to ${file}`));
  console.log(chalk.gray('It contains their token — send it privately, then delete it.'));
}

function runUsersCommand(fn) {
  return (...args) => {
    try { fn(...args); } catch (err) { console.error(chalk.red(err.message)); process.exitCode = 1; }
  };
}

users
  .command('add <id>')
  .description('Add a team member and print their token')
  .option('-n, --name <name>', 'Display name')
  .option('-d, --doc [file]', 'Write a personal setup guide (.md) with the token instead of printing it')
  .option('-s, --server-url <url>', PUBLIC_URL_HELP)
  .action(runUsersCommand((id, options) => {
    if (options.doc) publicUrl(options); // fail before creating the user
    // Store build + Google sign-in: teammates create their own user by signing
    // in, so the guide carries no token and no user is created here.
    if (options.doc && process.env.VIBE_EXTENSION_ID) {
      const file = writeOnboardingDoc(
        { id, name: options.name || id, serverUrl: publicUrl(options), extensionId: process.env.VIBE_EXTENSION_ID },
        typeof options.doc === 'string' ? options.doc : undefined
      );
      console.log(chalk.green(`Setup guide for ${id} written to ${file}`));
      console.log(chalk.gray('No user was created — teammates self-provision by signing in with Google. The guide has no token; send it any way you like.'));
      return;
    }
    issue(id, addUser(id, options.name), options);
  }));

users
  .command('list')
  .description('List team members')
  .action(runUsersCommand(() => {
    const all = loadUsers();
    if (!all.length) { console.log(chalk.gray(`No users — server runs in single-user mode. (${USERS_FILE})`)); return; }
    for (const u of all) {
      const how = u.auth === 'google' ? chalk.gray(`google · ${(u.tokens || []).length} token(s)`) : chalk.gray('token');
      console.log(`${u.id.padEnd(34)} ${(u.name || '').padEnd(24)} ${how}`);
    }
  }));

users
  .command('rotate <id>')
  .description('Issue a new token for a member (the old one stops working)')
  .option('-d, --doc [file]', 'Write a personal setup guide (.md) with the new token')
  .option('-s, --server-url <url>', PUBLIC_URL_HELP)
  .action(runUsersCommand((id, options) => {
    if (options.doc) publicUrl(options);
    issue(id, rotateUser(id), options);
  }));

users
  .command('doc <id>')
  .description('Write the setup guide for an existing member whose token you still have')
  .requiredOption('-t, --token <token>', 'Their current token (checked against the users file)')
  .option('-o, --out <file>', 'Output file (default: ~/.vibe-annotations/onboarding/<id>.md)')
  .option('-s, --server-url <url>', PUBLIC_URL_HELP)
  .action(runUsersCommand((id, options) => {
    const owner = userForToken(options.token);
    if (!owner || owner.id !== id) throw new Error(`That token doesn't belong to "${id}".`);
    issue(id, options.token, { ...options, doc: options.out || true });
  }));

users
  .command('remove <id>')
  .description('Remove a member (their token stops working; their annotations stay)')
  .action(runUsersCommand((id) => { removeUser(id); console.log(chalk.green(`Removed ${id}`)); }));

program.parse(process.argv);

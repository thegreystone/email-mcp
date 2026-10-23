#!/usr/bin/env node
// Copyright (C) 2026 Marcus Hirt. SPDX-License-Identifier: BSD-3-Clause
// Keep stdout exclusively for MCP, except for the explicit --help/--show-config commands.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, createWriteStream, constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const RELEASE_VERSION = '1.0.14';
export const RELEASE_ARTIFACT_PREFIX = 'mcp-email-server';
const REPOSITORY = 'thegreystone/email-mcp';
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const ACCOUNT_SETTING = /^EMAIL_ACCOUNTS_([A-Z0-9]+(?:_[A-Z0-9]+)*)_(IMAP_(?:HOST|PORT|USERNAME|PASSWORD|SSL)|SMTP_(?:HOST|PORT|USERNAME|PASSWORD|STARTTLS|SSL)|FROM|DRAFTS_FOLDER|SPAM_FOLDER|TRASH_FOLDER)$/;
const GLOBAL_SETTINGS = new Set(['EMAIL_ALLOW_SENDING', 'EMAIL_ALLOW_DELETION', 'EMAIL_NETWORK_TIMEOUT']);
const REQUIRED_ACCOUNT_FIELDS = [
  'IMAP_HOST', 'IMAP_USERNAME', 'IMAP_PASSWORD', 'SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD',
];
const CLI_FIELDS = { '--binary': 'binaryPath' };
const ALLOWED_HOSTS = new Set([
  'api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com',
]);

export function detectHostArchitecture({
  platform = process.platform, machine = os.machine, processArch = process.arch,
  env = process.env, execFileSyncImpl = execFileSync,
} = {}) {
  let architecture;
  try { architecture = typeof machine === 'function' ? machine() : machine; }
  catch { /* Older Node/OS combinations may not expose the native machine. */ }
  const normalize = value => ({
    x86_64: 'x64', amd64: 'x64', x64: 'x64', aarch64: 'arm64', arm64: 'arm64',
    i386: 'ia32', i686: 'ia32', x86: 'ia32', ia32: 'ia32',
  }[String(value).toLowerCase()] || String(value).toLowerCase());
  architecture = normalize(architecture || processArch);
  // Windows exposes the native architecture to a process running under emulation.
  if (platform === 'win32') {
    const native = normalize(env.PROCESSOR_ARCHITEW6432 || env.PROCESSOR_ARCHITECTURE || '');
    if (native === 'arm64' || (native === 'x64' && architecture !== 'arm64')) architecture = native;
  }
  // uname may report x86_64 under Rosetta. Ask the OS before selecting a binary.
  if (platform === 'darwin' && architecture === 'x64') {
    for (const key of ['sysctl.proc_translated', 'hw.optional.arm64']) {
      try {
        const value = execFileSyncImpl('/usr/sbin/sysctl', ['-in', key], {
          encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
        });
        if (String(value).trim() === '1') { architecture = 'arm64'; break; }
      } catch { /* An Intel Mac need not expose these keys. */ }
    }
  }
  return architecture;
}

export function platformAsset(platform = process.platform, arch = detectHostArchitecture({ platform })) {
  const suffix = {
    'linux-x64': 'linux-x86_64', 'linux-arm64': 'linux-aarch64',
    'darwin-arm64': 'macos-aarch64', 'win32-x64': 'windows-x86_64.exe',
  }[`${platform}-${arch}`];
  if (!suffix) {
    throw new Error(`No Email MCP native release for ${platform}/${arch}. Supported: Linux x64/arm64, macOS arm64, Windows x64. Set EMAIL_MCP_BINARY to a compatible executable you built or installed yourself.`);
  }
  return `${RELEASE_ARTIFACT_PREFIX}-${RELEASE_VERSION}-${suffix}`;
}

function absolutePath(value, homeDir) {
  if (value === '~') return path.resolve(homeDir);
  if (/^~[/\\]/.test(value)) return path.resolve(homeDir, value.slice(2));
  if (value.startsWith('~')) throw new Error('Unsupported home abbreviation. Use ~/, or an absolute path.');
  return path.resolve(value);
}

export function resolvePaths({ env = process.env, platform = process.platform, homeDir = os.homedir() } = {}) {
  let configBase;
  let cacheBase;
  if (platform === 'win32') {
    configBase = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    cacheBase = path.join(configBase, 'email-mcp', 'cache');
    configBase = path.join(configBase, 'email-mcp', 'codex');
  } else if (platform === 'darwin') {
    configBase = path.join(homeDir, 'Library', 'Application Support', 'email-mcp', 'codex');
    cacheBase = path.join(homeDir, 'Library', 'Caches', 'email-mcp');
  } else {
    configBase = path.join(env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'email-mcp', 'codex');
    cacheBase = path.join(env.XDG_CACHE_HOME || path.join(homeDir, '.cache'), 'email-mcp');
  }
  return {
    configPath: absolutePath(env.EMAIL_MCP_CODEX_CONFIG || path.join(configBase, 'config.json'), homeDir),
    cacheDir: absolutePath(env.EMAIL_MCP_CODEX_CACHE || cacheBase, homeDir),
  };
}

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Email MCP configuration must be a JSON object.');
  }
  if (Object.keys(value).some(key => !['env', 'binaryPath'].includes(key))) {
    throw new Error('Unknown Email MCP configuration field. Only env and binaryPath are supported.');
  }
  const config = { env: {} };
  if (value.binaryPath !== undefined) {
    if (typeof value.binaryPath !== 'string' || !value.binaryPath.trim() || value.binaryPath.includes('\0')) {
      throw new Error('Email MCP binaryPath must be a nonempty string without NUL characters.');
    }
    config.binaryPath = value.binaryPath;
  }
  if (value.env !== undefined && (!value.env || typeof value.env !== 'object' || Array.isArray(value.env))) {
    throw new Error('Email MCP env must be an object of supported EMAIL_* string settings.');
  }
  for (const [key, item] of Object.entries(value.env || {})) {
    if (!GLOBAL_SETTINGS.has(key) && !ACCOUNT_SETTING.test(key)) {
      throw new Error('Unsupported Email MCP environment setting. Use documented EMAIL_ACCOUNTS_* fields or EMAIL_ALLOW_SENDING, EMAIL_ALLOW_DELETION, EMAIL_NETWORK_TIMEOUT.');
    }
    if (typeof item !== 'string' || item.includes('\0')) {
      throw new Error('Email MCP environment values must be strings without NUL characters.');
    }
    if ((key === 'EMAIL_ALLOW_SENDING' || key === 'EMAIL_ALLOW_DELETION' || /_(?:SSL|STARTTLS)$/.test(key)) &&
        !['true', 'false'].includes(item)) {
      throw new Error('Email MCP boolean settings must be the strings true or false.');
    }
    if (key.endsWith('_PORT') && (!/^\d+$/.test(item) || Number(item) < 1 || Number(item) > 65535)) {
      throw new Error('Email MCP ports must be strings containing an integer from 1 to 65535.');
    }
    if (key === 'EMAIL_NETWORK_TIMEOUT' && (!/^\d+$/.test(item) || Number(item) > 2147483647)) {
      throw new Error('Email MCP network timeout must be a string containing a nonnegative integer number of seconds.');
    }
    config.env[key] = item;
  }
  return config;
}

export async function readConfig(configPath) {
  try {
    return validateConfig(JSON.parse(await fs.readFile(configPath, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    // JSON parser messages can contain excerpts of the file, including passwords.
    throw new Error('Cannot read Email MCP configuration. Check its JSON syntax, supported settings and file permissions in your private editor.');
  }
}

export async function resolveConfiguration({ env = process.env, platform = process.platform, homeDir = os.homedir(), configPath } = {}) {
  const locations = resolvePaths({ env, platform, homeDir });
  if (configPath) locations.configPath = absolutePath(configPath, homeDir);
  const saved = await readConfig(locations.configPath);
  const combined = { env: { EMAIL_ALLOW_SENDING: 'false', EMAIL_ALLOW_DELETION: 'false', ...saved.env } };
  if (saved.binaryPath !== undefined) combined.binaryPath = saved.binaryPath;
  for (const [key, value] of Object.entries(env)) {
    if (GLOBAL_SETTINGS.has(key) || ACCOUNT_SETTING.test(key)) combined.env[key] = value;
  }
  if (Object.hasOwn(env, 'EMAIL_MCP_BINARY')) combined.binaryPath = env.EMAIL_MCP_BINARY;
  const result = { ...locations, ...validateConfig(combined), dataDir: path.join(path.dirname(locations.configPath), 'runtime') };
  if (result.binaryPath) result.binaryPath = absolutePath(result.binaryPath, homeDir);
  return result;
}

export function requireConfiguredAccounts(settings) {
  const accounts = new Map();
  for (const [key, value] of Object.entries(settings)) {
    const match = key.match(ACCOUNT_SETTING);
    if (!match) continue;
    if (!accounts.has(match[1])) accounts.set(match[1], {});
    accounts.get(match[1])[match[2]] = value;
  }
  const complete = fields => REQUIRED_ACCOUNT_FIELDS.every(key => fields[key]?.trim());
  if (![...accounts.values()].some(complete)) {
    throw new Error('No fully configured email account. Run --configure, then privately edit the configuration file: each account needs IMAP and SMTP HOST, USERNAME and PASSWORD. Run --install before restarting the plugin.');
  }
  if ([...accounts.values()].some(fields => !complete(fields))) {
    throw new Error('An email account is incomplete. Each account needs IMAP and SMTP HOST, USERNAME and PASSWORD; remove unused empty account template entries from your private configuration.');
  }
}

export function redactConfiguration(config) {
  return { ...config, env: Object.fromEntries(Object.entries(config.env).map(([key, value]) =>
    [key, key.endsWith('_PASSWORD') ? '[REDACTED]' : value])) };
}

async function atomicJson(destination, value, mode = 0o600) {
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode });
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function saveConfig(configPath, values) {
  const config = validateConfig(values);
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await atomicJson(configPath, config);
  await fs.chmod(configPath, 0o600);
}

export function parseArgs(args) {
  let mode = 'start';
  let explicitMode = false;
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    const modes = { '--configure': 'configure', '--install': 'install', '--show-config': 'show-config', '--help': 'help', '-h': 'help' };
    if (Object.hasOwn(modes, option)) {
      if (explicitMode) throw new Error('Choose only one of --configure, --install, --show-config, or --help.');
      mode = modes[option];
      explicitMode = true;
    } else if (Object.hasOwn(CLI_FIELDS, option)) {
      const key = CLI_FIELDS[option];
      if (Object.hasOwn(values, key)) throw new Error(`Duplicate option: ${option}.`);
      if (index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error(`A value is required after ${option}.`);
      values[key] = args[++index];
    } else {
      throw new Error('Unknown option. Run --help for usage; credentials belong in the private configuration file, not command-line arguments.');
    }
  }
  if (mode !== 'configure' && Object.keys(values).length) throw new Error('Configuration values require --configure.');
  return { mode, values };
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Email MCP startup cancelled.');
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function delay(milliseconds, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function responseFor(url, { signal, requestImpl = https.request }, redirects = 0) {
  checkAbort(signal);
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || !ALLOWED_HOSTS.has(target.hostname)) {
    throw new Error(`Refusing a download outside official GitHub HTTPS hosts: ${target.origin}.`);
  }
  return new Promise((resolve, reject) => {
    const request = requestImpl(target, {
      method: 'GET', signal,
      headers: { 'User-Agent': `email-mcp-codex/${RELEASE_VERSION}`, Accept: 'application/vnd.github+json' },
    }, response => {
      response.on('error', reject);
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        if (!response.headers.location || redirects >= 5) {
          reject(new Error('GitHub returned too many redirects or a redirect without a location.'));
        } else {
          try { resolve(responseFor(new URL(response.headers.location, target), { signal, requestImpl }, redirects + 1)); }
          catch (error) { reject(error); }
        }
      } else if (status !== 200) {
        response.resume();
        const hint = status === 404 ? ` Release v${RELEASE_VERSION} may still be building; retry after its native assets are published.` : '';
        reject(new Error(`GitHub download failed with HTTP ${status}.${hint}`));
      } else {
        resolve(response);
      }
    });
    request.on('error', reject);
    request.setTimeout(30_000, () => request.destroy(new Error('GitHub download timed out after 30 seconds without activity.')));
    request.end();
  });
}

async function releaseAssetMetadata(asset, options) {
  const response = await responseFor(`https://api.github.com/repos/${REPOSITORY}/releases/tags/v${RELEASE_VERSION}`, options);
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) {
      response.destroy();
      throw new Error('GitHub release metadata exceeded 4 MB.');
    }
    chunks.push(chunk);
  }
  const release = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const metadata = release.assets?.find(item => item.name === asset);
  if (!metadata) throw new Error(`Release v${RELEASE_VERSION} does not yet contain ${asset}. Retry after the release finishes building.`);
  if (!Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size > MAX_DOWNLOAD_BYTES) {
    throw new Error(`GitHub reported an invalid size for ${asset}.`);
  }
  let digest;
  if (metadata.digest != null) {
    if (!/^sha256:[a-f\d]{64}$/i.test(metadata.digest)) throw new Error(`GitHub reported an unsupported digest for ${asset}.`);
    digest = metadata.digest.slice(7).toLowerCase();
  }
  return { size: metadata.size, digest };
}

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function cachedBinary(binary, manifest, asset) {
  try {
    const metadata = JSON.parse(await fs.readFile(manifest, 'utf8'));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
    const stat = await fs.lstat(binary);
    if (!stat.isFile() || metadata.version !== RELEASE_VERSION || metadata.asset !== asset || metadata.size !== stat.size ||
        !/^[a-f\d]{64}$/.test(metadata.sha256) ||
        (metadata.releaseDigest && metadata.releaseDigest !== metadata.sha256) ||
        await hashFile(binary) !== metadata.sha256) return undefined;
    if (process.platform !== 'win32') await fs.access(binary, fsConstants.X_OK);
    return binary;
  } catch (error) {
    if (['ENOENT', 'EACCES'].includes(error.code) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function removeFile(filename) {
  await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

async function acquireLock(filename, signal) {
  const deadline = Date.now() + INSTALL_TIMEOUT_MS + 30_000;
  while (true) {
    checkAbort(signal);
    try {
      const file = await fs.open(filename, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() })); }
      finally { await file.close(); }
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    try {
      const stat = await fs.stat(filename);
      if (Date.now() - stat.mtimeMs > INSTALL_TIMEOUT_MS + 30_000) {
        let alive = false;
        try {
          const owner = JSON.parse(await fs.readFile(filename, 'utf8'));
          if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') alive = true; }
          }
        } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        if (!alive) { await removeFile(filename); continue; }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for another Email MCP installation (${filename}). Retry when it finishes.`);
    await delay(200, signal);
  }
}

/** requestImpl is an https.request-compatible transport for tests, never a user URL override. */
export async function ensureBinary({ cacheDir, platform = process.platform, arch = detectHostArchitecture({ platform }), signal, requestImpl = https.request } = {}) {
  if (!cacheDir) throw new Error('A Email MCP cache directory is required.');
  const asset = platformAsset(platform, arch);
  const directory = path.resolve(cacheDir, RELEASE_VERSION);
  const binary = path.join(directory, asset);
  const manifest = `${binary}.json`;
  checkAbort(signal);
  const cached = await cachedBinary(binary, manifest, asset);
  if (cached) return cached;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = `${binary}.lock`;
  await acquireLock(lock, signal);
  const temporary = `${binary}.${process.pid}.${randomBytes(8).toString('hex')}.partial`;
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortError(signal));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Email MCP download exceeded five minutes. Retry on a working connection.')), INSTALL_TIMEOUT_MS);
  try {
    checkAbort(signal);
    const nowCached = await cachedBinary(binary, manifest, asset);
    if (nowCached) return nowCached;
    await removeFile(binary);
    await removeFile(manifest);
    const metadata = await releaseAssetMetadata(asset, { signal: controller.signal, requestImpl });
    const response = await responseFor(`https://github.com/${REPOSITORY}/releases/download/v${RELEASE_VERSION}/${asset}`, { signal: controller.signal, requestImpl });
    let bytes = 0;
    const hash = createHash('sha256');
    const digestStream = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > metadata.size || bytes > MAX_DOWNLOAD_BYTES) return callback(new Error(`Downloaded ${asset} exceeds its published size.`));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(response, digestStream, createWriteStream(temporary, { flags: 'wx', mode: 0o700 }), { signal: controller.signal });
    const sha256 = hash.digest('hex');
    if (bytes !== metadata.size) throw new Error(`Downloaded ${asset} is incomplete (${bytes}/${metadata.size} bytes).`);
    if (metadata.digest && sha256 !== metadata.digest) throw new Error(`SHA-256 verification failed for ${asset}; the downloaded executable was discarded.`);
    checkAbort(controller.signal);
    await fs.rename(temporary, binary);
    await atomicJson(manifest, { version: RELEASE_VERSION, asset, size: bytes, sha256, releaseDigest: metadata.digest || null });
    return binary;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await removeFile(temporary);
    await removeFile(lock);
  }
}

async function manualBinary(filename) {
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile()) throw new Error('not a regular file');
    await fs.access(filename, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
  } catch (error) {
    throw new Error(`Cannot execute EMAIL_MCP_BINARY at ${filename}: ${error.message}. Select a native executable for this platform (and chmod +x on macOS/Linux).`, { cause: error });
  }
  return filename;
}

const HELP = `Email MCP Codex plugin (native release ${RELEASE_VERSION}; Node.js 18 or later)

Usage: node email-mcp.mjs [command]
  (no command)  Start the native MCP server over stdio.
  --configure [--binary /absolute/path]
                Create a private default-account template, preserving existing settings.
                Edit mailbox credentials privately in the reported configuration file.
  --install     Download and verify the pinned executable without accessing a mailbox.
  --show-config Print effective paths/settings with every password redacted.
  --help        Show this help.

Config: {"env":{"EMAIL_ACCOUNTS_DEFAULT_IMAP_HOST":"", ...},"binaryPath":"optional"}
Each account needs IMAP and SMTP HOST, USERNAME and PASSWORD string settings.
EMAIL_* environment settings override saved settings; sending and deletion default to false.
EMAIL_MCP_BINARY selects a native executable you installed. EMAIL_MCP_CODEX_CONFIG
and EMAIL_MCP_CODEX_CACHE override private config and binary-cache paths.
Do not pass passwords on the command line or paste them into a chat.
`;

export async function main(args = process.argv.slice(2), {
  env = process.env, platform = process.platform, arch, homeDir = os.homedir(),
  stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, spawnImpl = spawn,
} = {}) {
  let controller;
  let input;
  let child;
  let signalExit;
  let inputClosed = false;
  let inputError;
  let killTimer;
  const signalHandlers = new Map();
  const stopChild = (signal = 'SIGTERM') => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    if (!killTimer) {
      killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 3000);
      killTimer.unref();
    }
  };
  const onInputEnd = () => {
    inputClosed = true;
    controller?.abort(new Error('Email MCP client closed stdin.'));
    stopChild();
  };
  const onInputError = error => {
    inputError = error;
    controller?.abort(error);
    stopChild();
  };
  try {
    const { mode, values } = parseArgs(args);
    if (mode === 'help') { stdout.write(HELP); return 0; }
    const locations = resolvePaths({ env, platform, homeDir });
    if (mode === 'configure') {
      const previous = await readConfig(locations.configPath);
      const initial = { env: {
        ...Object.fromEntries(REQUIRED_ACCOUNT_FIELDS.map(field => [`EMAIL_ACCOUNTS_DEFAULT_${field}`, ''])),
        EMAIL_ALLOW_SENDING: 'false', EMAIL_ALLOW_DELETION: 'false',
      } };
      const updated = { ...(Object.keys(previous).length ? previous : initial), ...values };
      if (updated.binaryPath) updated.binaryPath = absolutePath(updated.binaryPath, homeDir);
      await saveConfig(locations.configPath, updated);
      stderr.write(`Email MCP configuration saved to ${locations.configPath}. Edit credentials privately, run --install, then restart the plugin/session.\n`);
      return 0;
    }
    const config = await resolveConfiguration({ env, platform, homeDir });
    if (mode === 'show-config') {
      stdout.write(`${JSON.stringify({ version: RELEASE_VERSION, ...redactConfiguration(config) }, null, 2)}\n`);
      return 0;
    }
    if (mode === 'start') requireConfiguredAccounts(config.env);
    controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        signalExit = 128 + (os.constants.signals[signal] || 1);
        controller.abort(new Error(`Email MCP stopped by ${signal}.`));
        stopChild(signal);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    if (mode === 'start') {
      // Buffer initial MCP messages during installation. Piping also detects EOF without
      // competing with the child for bytes from the inherited stdin descriptor.
      input = new PassThrough();
      stdin.once('end', onInputEnd);
      stdin.once('close', onInputEnd);
      stdin.once('error', onInputError);
      stdin.pipe(input);
      if (stdin.readableEnded || stdin.destroyed) onInputEnd();
    }
    const binary = config.binaryPath ? await manualBinary(config.binaryPath) : await ensureBinary({
      cacheDir: config.cacheDir, platform, arch: arch || detectHostArchitecture({ platform, env }), signal: controller.signal,
    });
    checkAbort(controller.signal);
    if (mode === 'install') {
      stderr.write(`Email MCP ${RELEASE_VERSION} executable ready: ${binary}\n`);
      return 0;
    }
    const childEnv = { ...env };
    for (const key of Object.keys(childEnv)) if (key.startsWith('EMAIL_')) delete childEnv[key];
    Object.assign(childEnv, config.env);
    await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    await fs.access(config.dataDir, fsConstants.W_OK);
    checkAbort(controller.signal);
    stderr.write(`Email MCP server working directory: ${config.dataDir}\n`);
    child = spawnImpl(binary, [
      '-Dquarkus.mcp.server.stdio.enabled=true', '-Dquarkus.config.locations=.', `-Duser.dir=${config.dataDir}`,
    ], {
      env: childEnv, cwd: config.dataDir, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true, shell: false,
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stderr.write(`Email MCP stdin: ${error.message}\n`); });
    input.pipe(child.stdin);
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (inputError) reject(inputError);
        else resolve(signalExit ?? (inputClosed ? 0 : code ?? 128 + (os.constants.signals[signal] || 1)));
      });
    });
  } catch (error) {
    if (controller?.signal.aborted && !signalExit && inputClosed) return 0;
    stderr.write(`Email MCP: ${error.message}\n`);
    return signalExit || 1;
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    if (killTimer) clearTimeout(killTimer);
    stdin.off('end', onInputEnd);
    stdin.off('close', onInputEnd);
    stdin.off('error', onInputError);
    if (input) { stdin.unpipe(input); input.destroy(); stdin.pause(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

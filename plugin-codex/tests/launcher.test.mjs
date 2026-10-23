// Copyright (C) 2026 Marcus Hirt. SPDX-License-Identifier: BSD-3-Clause
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import {
  RELEASE_VERSION, RELEASE_ARTIFACT_PREFIX, detectHostArchitecture, ensureBinary, main, parseArgs, platformAsset,
  readConfig, requireConfiguredAccounts, resolveConfiguration, resolvePaths, saveConfig, validateConfig,
} from '../scripts/email-mcp.mjs';

const testRoot = path.resolve('target/email-codex-plugin-tests');
const platforms = [
  ['linux', 'x64', 'linux-x86_64'],
  ['linux', 'arm64', 'linux-aarch64'],
  ['darwin', 'arm64', 'macos-aarch64'],
  ['win32', 'x64', 'windows-x86_64.exe'],
];

async function temporary(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testRoot, 'case-'));
  t.after(async () => {
    const resolved = await fs.realpath(directory);
    const root = await fs.realpath(testRoot);
    assert.equal(path.dirname(resolved), root, 'Only remove this test-created directory');
    assert.ok(path.basename(resolved).startsWith('case-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

function output() {
  let text = '';
  return { write(value) { text += value; }, get text() { return text; } };
}

function transport(route, requests = []) {
  return (url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = error => { queueMicrotask(() => request.emit('error', error)); return request; };
    request.end = () => queueMicrotask(() => {
      try {
        if (options.signal?.aborted) return request.destroy(options.signal.reason);
        requests.push(url.href);
        const reply = route(url);
        const body = Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body || '');
        const response = Readable.from(body.length ? [body] : []);
        response.statusCode = reply.status || 200;
        response.headers = reply.headers || {};
        callback(response);
      } catch (error) { request.destroy(error); }
    });
    return request;
  };
}

function releaseTransport(asset, body, { digest, redirect, downloadBody = body } = {}) {
  const requests = [];
  const expectedDigest = digest === undefined ? `sha256:${createHash('sha256').update(body).digest('hex')}` : digest;
  const requestImpl = transport(url => {
    if (url.hostname === 'api.github.com') {
      assert.equal(url.pathname, `/repos/thegreystone/email-mcp/releases/tags/v${RELEASE_VERSION}`);
      return { body: JSON.stringify({ assets: [{ name: asset, size: body.length, digest: expectedDigest }] }) };
    }
    if (url.hostname === 'github.com') {
      assert.equal(url.pathname, `/thegreystone/email-mcp/releases/download/v${RELEASE_VERSION}/${asset}`);
      if (redirect) return { status: 302, headers: { location: redirect } };
      return { body: downloadBody };
    }
    assert.equal(url.hostname, 'release-assets.githubusercontent.com');
    return { body: downloadBody };
  }, requests);
  return { requestImpl, requests };
}

test('selects the exact native release for every supported OS and architecture', () => {
  for (const [platform, arch, suffix] of platforms) {
    assert.equal(platformAsset(platform, arch), `${RELEASE_ARTIFACT_PREFIX}-${RELEASE_VERSION}-${suffix}`);
  }
  for (const [platform, arch] of [['darwin', 'x64'], ['win32', 'arm64'], ['linux', 'ia32'], ['freebsd', 'x64']]) {
    assert.throws(() => platformAsset(platform, arch), error =>
      error.message.includes(`${platform}/${arch}`) && error.message.includes('EMAIL_MCP_BINARY'));
  }
});

test('detects the native host independently of the Node process architecture', () => {
  for (const [machine, expected] of [['x86_64', 'x64'], ['AMD64', 'x64'], ['aarch64', 'arm64'], ['ARM64', 'arm64']]) {
    assert.equal(detectHostArchitecture({ platform: 'linux', machine, processArch: 'ia32', env: {} }), expected);
  }
  assert.equal(detectHostArchitecture({ platform: 'linux', machine: () => undefined, processArch: 'x64', env: {} }), 'x64');
  assert.equal(detectHostArchitecture({ platform: 'linux', machine() { throw new Error('Machine unavailable'); }, processArch: 'arm64', env: {} }), 'arm64');
  assert.equal(detectHostArchitecture({ platform: 'win32', machine: 'AMD64', processArch: 'ia32', env: { PROCESSOR_ARCHITECTURE: 'x86', PROCESSOR_ARCHITEW6432: 'AMD64' } }), 'x64');
  assert.equal(detectHostArchitecture({ platform: 'win32', machine() { throw new Error('Machine unavailable'); }, processArch: 'ia32', env: { PROCESSOR_ARCHITECTURE: 'x86', PROCESSOR_ARCHITEW6432: 'AMD64' } }), 'x64');
  assert.equal(detectHostArchitecture({ platform: 'win32', machine: 'AMD64', processArch: 'x64', env: { PROCESSOR_ARCHITEW6432: 'ARM64' } }), 'arm64');
  assert.equal(detectHostArchitecture({ platform: 'win32', machine: 'AMD64', processArch: 'x64', env: { PROCESSOR_ARCHITECTURE: 'ARM64' } }), 'arm64');
  for (const affirmativeKey of ['sysctl.proc_translated', 'hw.optional.arm64', undefined]) {
    const queries = [];
    const arch = detectHostArchitecture({ platform: 'darwin', machine: 'x86_64', processArch: 'x64', env: {}, execFileSyncImpl(command, args, options) {
      assert.equal(command, '/usr/sbin/sysctl');
      assert.equal(args[0], '-in');
      assert.equal(options.timeout, 1000);
      queries.push(args[1]);
      return args[1] === affirmativeKey ? '1\n' : '0\n';
    } });
    assert.equal(arch, affirmativeKey ? 'arm64' : 'x64');
    assert.equal(queries.length, affirmativeKey === 'sysctl.proc_translated' ? 1 : 2);
  }
  assert.equal(detectHostArchitecture({ platform: 'darwin', machine: 'x86_64', env: {}, execFileSyncImpl() { throw new Error('No such sysctl'); } }), 'x64');
});

test('downloads the selected asset and keeps distinct platform caches', async t => {
  const cacheDir = await temporary(t);
  const filenames = new Set();
  for (const [platform, arch] of platforms) {
    const asset = platformAsset(platform, arch);
    const body = Buffer.from(`native test fixture: ${asset}`);
    const network = releaseTransport(asset, body);
    const filename = await ensureBinary({ cacheDir, platform, arch, requestImpl: network.requestImpl });
    assert.equal(path.basename(filename), asset);
    assert.equal(path.basename(path.dirname(filename)), RELEASE_VERSION);
    assert.deepEqual(await fs.readFile(filename), body);
    assert.equal(network.requests.length, 2);
    filenames.add(filename);
  }
  assert.equal(filenames.size, platforms.length);
});

test('reuses a verified binary offline and replaces a corrupt cache entry', async t => {
  const cacheDir = await temporary(t);
  const asset = platformAsset('linux', 'x64');
  const body = Buffer.from('verified native fixture');
  const network = releaseTransport(asset, body);
  const options = { cacheDir, platform: 'linux', arch: 'x64' };
  const filename = await ensureBinary({ ...options, requestImpl: network.requestImpl });
  assert.equal(await ensureBinary({ ...options, requestImpl() { throw new Error('Offline: network must not be needed'); } }), filename);
  await fs.writeFile(filename, Buffer.alloc(body.length, 120));
  await ensureBinary({ ...options, requestImpl: network.requestImpl });
  assert.deepEqual(await fs.readFile(filename), body);
  assert.equal(network.requests.length, 4);
});

test('rejects wrong hashes and incomplete downloads without publishing a binary', async t => {
  const cacheDir = await temporary(t);
  const asset = platformAsset('win32', 'x64');
  const body = Buffer.from('complete fixture');
  const options = { cacheDir, platform: 'win32', arch: 'x64' };
  const badHash = releaseTransport(asset, body, { digest: `sha256:${'0'.repeat(64)}` });
  await assert.rejects(ensureBinary({ ...options, requestImpl: badHash.requestImpl }), /SHA-256 verification failed/);
  assert.deepEqual(await fs.readdir(path.join(cacheDir, RELEASE_VERSION)), []);
  const shortDownload = releaseTransport(asset, body, { downloadBody: body.subarray(0, 3) });
  await assert.rejects(ensureBinary({ ...options, requestImpl: shortDownload.requestImpl }), /incomplete/);
  assert.deepEqual(await fs.readdir(path.join(cacheDir, RELEASE_VERSION)), []);
});

test('a missing release asset never falls back to another architecture', async t => {
  const cacheDir = await temporary(t);
  const requested = platformAsset('win32', 'x64');
  const requests = [];
  const requestImpl = transport(url => {
    assert.equal(url.hostname, 'api.github.com', 'Do not download an incompatible release asset');
    return { body: JSON.stringify({ assets: [{ name: platformAsset('linux', 'arm64'), size: 123 }] }) };
  }, requests);
  await assert.rejects(ensureBinary({ cacheDir, platform: 'win32', arch: 'x64', requestImpl }), error =>
    error.message.includes(requested) && error.message.includes('Retry after the release finishes building'));
  assert.equal(requests.length, 1);
  assert.deepEqual(await fs.readdir(path.join(cacheDir, RELEASE_VERSION)), []);
});

test('an unpublished release reports a retryable error without leaving installation files', async t => {
  const cacheDir = await temporary(t);
  const requests = [];
  const requestImpl = transport(() => ({ status: 404 }), requests);
  await assert.rejects(ensureBinary({ cacheDir, platform: 'linux', arch: 'x64', requestImpl }), /HTTP 404.*may still be building/);
  assert.equal(requests.length, 1);
  assert.deepEqual(await fs.readdir(path.join(cacheDir, RELEASE_VERSION)), []);
});

test('cancelling before installation avoids network and cache writes', async t => {
  const directory = await temporary(t);
  const cacheDir = path.join(directory, 'not-created');
  const controller = new AbortController();
  controller.abort(new Error('Cancelled before download'));
  await assert.rejects(ensureBinary({
    cacheDir, platform: 'linux', arch: 'x64', signal: controller.signal,
    requestImpl() { assert.fail('A cancelled installation must not access the network'); },
  }), /Cancelled before download/);
  await assert.rejects(fs.stat(cacheDir), { code: 'ENOENT' });
});

test('cancelling a download removes partial files and releases its installation lock', { timeout: 5000 }, async t => {
  const cacheDir = await temporary(t);
  const asset = platformAsset('linux', 'x64');
  const body = Buffer.from('native executable fixture for an interrupted download');
  const controller = new AbortController();
  const requests = [];
  let downloadStarted;
  const started = new Promise(resolve => { downloadStarted = resolve; });
  const normal = releaseTransport(asset, body);
  const requestImpl = (url, options, callback) => {
    if (url.hostname === 'api.github.com') return normal.requestImpl(url, options, callback);
    requests.push(url.href);
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.end = () => queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = {};
      callback(response);
      response.write(body.subarray(0, 8));
      downloadStarted();
    });
    return request;
  };
  const installation = ensureBinary({ cacheDir, platform: 'linux', arch: 'x64', signal: controller.signal, requestImpl });
  // Observe rejection before aborting so no asynchronous rejection is left unhandled.
  const rejected = assert.rejects(installation, /aborted|cancelled/i);
  await started;
  let partialWritten = false;
  try {
    for (let attempt = 0; attempt < 100 && !partialWritten; attempt++) {
      const directory = path.join(cacheDir, RELEASE_VERSION);
      const partial = (await fs.readdir(directory)).find(name => name.endsWith('.partial'));
      partialWritten = Boolean(partial && (await fs.stat(path.join(directory, partial))).size > 0);
      if (!partialWritten) await new Promise(resolve => setTimeout(resolve, 5));
    }
  } finally {
    controller.abort(new Error('Cancelled test download'));
  }
  await rejected;
  assert.ok(partialWritten, 'Cancel after bytes have reached a partial executable on disk');
  assert.equal(requests.length, 1);
  assert.deepEqual(await fs.readdir(path.join(cacheDir, RELEASE_VERSION)), []);
  const retry = releaseTransport(asset, body);
  const filename = await ensureBinary({ cacheDir, platform: 'linux', arch: 'x64', requestImpl: retry.requestImpl });
  assert.deepEqual(await fs.readFile(filename), body);
  assert.equal(retry.requests.length, 2, 'A retry can acquire the released lock and finish');
});

test('allows official release redirects and rejects HTTPS downgrades or unrelated hosts', async t => {
  const cacheDir = await temporary(t);
  const asset = platformAsset('linux', 'arm64');
  const body = Buffer.from('redirected fixture');
  const valid = releaseTransport(asset, body, { redirect: 'https://release-assets.githubusercontent.com/asset' });
  await ensureBinary({ cacheDir, platform: 'linux', arch: 'arm64', requestImpl: valid.requestImpl });
  assert.equal(valid.requests.length, 3);
  for (const [index, redirect] of ['http://github.com/asset', 'https://unrelated.example/asset'].entries()) {
    const invalid = releaseTransport(asset, body, { redirect });
    await assert.rejects(ensureBinary({ cacheDir: path.join(cacheDir, `invalid-${index}`), platform: 'linux', arch: 'arm64', requestImpl: invalid.requestImpl }), /official GitHub HTTPS/);
    assert.equal(invalid.requests.length, 2);
  }
});

test('concurrent installations share one complete download', async t => {
  const cacheDir = await temporary(t);
  const asset = platformAsset('linux', 'x64');
  const body = Buffer.from('concurrent fixture');
  const network = releaseTransport(asset, body);
  const options = { cacheDir, platform: 'linux', arch: 'x64', requestImpl: network.requestImpl };
  const [first, second] = await Promise.all([ensureBinary(options), ensureBinary(options)]);
  assert.equal(first, second);
  assert.deepEqual(await fs.readFile(first), body);
  assert.equal(network.requests.length, 2);
  assert.equal((await fs.readdir(path.dirname(first))).some(name => /\.partial$|\.lock$/.test(name)), false);
});

function account(name = 'HOME', suffix = 'fixture') {
  return Object.fromEntries([
    ['IMAP_HOST', 'imap.example.invalid'], ['IMAP_USERNAME', `${suffix}@example.invalid`],
    ['IMAP_PASSWORD', `private-imap-${suffix}`], ['SMTP_HOST', 'smtp.example.invalid'],
    ['SMTP_USERNAME', `${suffix}@example.invalid`], ['SMTP_PASSWORD', `private-smtp-${suffix}`],
  ].map(([key, value]) => [`EMAIL_ACCOUNTS_${name}_${key}`, value]));
}

test('default config/cache paths belong to each platform and honor directory overrides', () => {
  const homeDir = path.resolve('target/test-home');
  const windows = resolvePaths({ platform: 'win32', homeDir, env: {} });
  assert.equal(windows.configPath, path.join(homeDir, 'AppData', 'Local', 'email-mcp', 'codex', 'config.json'));
  const mac = resolvePaths({ platform: 'darwin', homeDir, env: {} });
  assert.equal(mac.cacheDir, path.join(homeDir, 'Library', 'Caches', 'email-mcp'));
  const linux = resolvePaths({ platform: 'linux', homeDir, env: {
    XDG_CONFIG_HOME: path.join(homeDir, 'config'), XDG_CACHE_HOME: path.join(homeDir, 'cache'),
  } });
  assert.equal(linux.configPath, path.join(homeDir, 'config', 'email-mcp', 'codex', 'config.json'));
  assert.equal(linux.cacheDir, path.join(homeDir, 'cache', 'email-mcp'));
  assert.equal(resolvePaths({ env: { EMAIL_MCP_CODEX_CONFIG: '~/private.json' }, homeDir }).configPath,
    path.join(homeDir, 'private.json'));
});

test('multiaccount settings persist outside the plugin and environment overrides saved settings', async t => {
  const homeDir = await temporary(t);
  const configPath = path.join(homeDir, 'config', 'email.json');
  const cacheDir = path.join(homeDir, 'native-cache');
  await saveConfig(configPath, { env: { ...account(), ...account('WORK', 'work'), EMAIL_ALLOW_SENDING: 'true' }, binaryPath: '~/saved-binary' });
  const config = await resolveConfiguration({ env: {
    EMAIL_MCP_CODEX_CONFIG: configPath, EMAIL_MCP_CODEX_CACHE: cacheDir,
    EMAIL_ACCOUNTS_HOME_IMAP_PASSWORD: 'environment-password', EMAIL_ALLOW_SENDING: 'false',
    EMAIL_MCP_BINARY: '~/override-binary',
  }, homeDir });
  assert.equal(config.env.EMAIL_ACCOUNTS_HOME_IMAP_PASSWORD, 'environment-password');
  assert.equal(config.env.EMAIL_ACCOUNTS_WORK_SMTP_USERNAME, 'work@example.invalid');
  assert.equal(config.env.EMAIL_ALLOW_SENDING, 'false');
  assert.equal(config.env.EMAIL_ALLOW_DELETION, 'false');
  assert.equal(config.binaryPath, path.join(homeDir, 'override-binary'));
  assert.equal(config.cacheDir, cacheDir);
  assert.equal(config.configPath, configPath);
  requireConfiguredAccounts(config.env);
});

test('configuration rejects unsupported settings and invalid values without echoing them', () => {
  const secret = 'sensitive-value-not-for-diagnostics';
  for (const config of [
    { [secret]: 'x' }, { env: { [secret]: secret } },
    { env: { EMAIL_ACCOUNTS_HOME_IMAP_PASSWORD: { secret } } },
    { env: { EMAIL_ACCOUNTS_HOME_IMAP_HOST: `${secret}\0` } },
    { env: { EMAIL_ALLOW_SENDING: secret } }, { env: { EMAIL_NETWORK_TIMEOUT: secret } },
    { env: { EMAIL_ACCOUNTS_HOME_SMTP_PORT: '65536' } }, { env: [] }, { binaryPath: '' },
  ]) {
    assert.throws(() => validateConfig(config), error => !error.message.includes(secret));
  }
  assert.doesNotThrow(() => validateConfig({ env: {
    EMAIL_ACCOUNTS_HOME_IMAP_PORT: '143', EMAIL_ACCOUNTS_HOME_IMAP_SSL: 'false',
    EMAIL_ACCOUNTS_HOME_SMTP_STARTTLS: 'true', EMAIL_NETWORK_TIMEOUT: '0',
  } }));
});

test('malformed JSON and unknown config keys never appear in diagnostic output', async t => {
  const directory = await temporary(t);
  const configPath = path.join(directory, 'private.json');
  const secret = 'do-not-echo-this-password';
  for (const content of [
    `{"env":{"EMAIL_ACCOUNTS_HOME_IMAP_PASSWORD":"${secret}"},broken`,
    JSON.stringify({ [secret]: secret }),
    JSON.stringify({ env: { EMAIL_ACCOUNTS_HOME_IMAP_PASSWORD: { password: secret } } }),
  ]) {
    await fs.writeFile(configPath, content);
    await assert.rejects(readConfig(configPath), error =>
      error.message.includes('Cannot read Email MCP configuration') && !error.message.includes(secret));
    const stdout = output(), stderr = output();
    assert.equal(await main(['--show-config'], { env: { EMAIL_MCP_CODEX_CONFIG: configPath }, homeDir: directory, stdout, stderr }), 1);
    assert.equal(stdout.text, '');
    assert.equal(stderr.text.includes(secret), false);
    assert.equal(stderr.text.includes(content), false);
  }
});

test('configure creates blank credentials and preserves private settings on repeat', async t => {
  const directory = await temporary(t);
  const configPath = path.join(directory, 'private', 'config.json');
  const env = { EMAIL_MCP_CODEX_CONFIG: configPath };
  const stdout = output(), stderr = output();
  const options = { env, homeDir: directory, stdout, stderr };
  assert.equal(await main(['--configure'], options), 0);
  const template = await readConfig(configPath);
  assert.equal(template.env.EMAIL_ACCOUNTS_DEFAULT_IMAP_PASSWORD, '');
  assert.equal(template.env.EMAIL_ALLOW_SENDING, 'false');
  assert.equal(template.env.EMAIL_ALLOW_DELETION, 'false');
  const saved = { env: { ...account(), EMAIL_NETWORK_TIMEOUT: '30' } };
  await saveConfig(configPath, saved);
  assert.equal(await main(['--configure', '--binary', process.execPath], options), 0);
  const updated = await readConfig(configPath);
  assert.deepEqual(updated.env, saved.env);
  assert.equal(updated.binaryPath, process.execPath);
  assert.equal(stdout.text, '', 'Configuration messages belong on stderr');
  for (const value of Object.values(saved.env)) if (value.startsWith('private-')) assert.equal(stderr.text.includes(value), false);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(configPath))).mode & 0o777, 0o700);
  }
});

test('saving into an existing directory does not change its unrelated permissions', async t => {
  if (process.platform === 'win32') return t.skip('Unix directory modes do not apply to Windows ACLs');
  const directory = await temporary(t);
  await fs.chmod(directory, 0o755);
  await saveConfig(path.join(directory, 'config.json'), { env: account() });
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o755);
});

test('show-config redacts every account password including environment overrides', async t => {
  const directory = await temporary(t);
  const configPath = path.join(directory, 'private.json');
  const saved = { ...account(), ...account('WORK', 'work') };
  await saveConfig(configPath, { env: saved });
  const stdout = output(), stderr = output();
  assert.equal(await main(['--show-config'], { env: {
    EMAIL_MCP_CODEX_CONFIG: configPath, EMAIL_ACCOUNTS_HOME_IMAP_PASSWORD: 'overridden-secret',
    UNRELATED_API_KEY: 'another-secret',
  }, homeDir: directory, stdout, stderr }), 0);
  const visible = JSON.parse(stdout.text);
  assert.equal(visible.env.EMAIL_ACCOUNTS_HOME_IMAP_HOST, 'imap.example.invalid');
  for (const [key, value] of Object.entries(saved)) {
    if (!key.endsWith('_PASSWORD')) continue;
    assert.equal(visible.env[key], '[REDACTED]');
    assert.equal(stdout.text.includes(value), false);
  }
  assert.equal(stdout.text.includes('overridden-secret'), false);
  assert.equal(stdout.text.includes('another-secret'), false);
  assert.equal(stderr.text, '');
});

test('CLI rejects credential arguments, ambiguous modes and changes outside configure', () => {
  assert.throws(() => parseArgs(['--install', '--configure']), /only one/);
  assert.throws(() => parseArgs(['--binary']), /value is required/);
  assert.throws(() => parseArgs(['--binary', 'native']), /require --configure/);
  assert.throws(() => parseArgs(['--configure', '--password', 'secret']), error =>
    error.message.includes('Unknown option') && !error.message.includes('secret'));
  assert.throws(() => parseArgs(['--secret-that-was-accidentally-pasted']), error =>
    !error.message.includes('accidentally-pasted'));
});

test('incomplete accounts fail before download or spawn with clean stdout', async t => {
  const directory = await temporary(t);
  const stdout = output(), stderr = output();
  const code = await main([], { env: {
    EMAIL_MCP_CODEX_CONFIG: path.join(directory, 'absent.json'), EMAIL_ACCOUNTS_HOME_IMAP_PASSWORD: 'private-missing-account',
  }, homeDir: directory, stdin: new PassThrough(), stdout, stderr, spawnImpl() { assert.fail('Do not launch an incomplete account'); } });
  assert.equal(code, 1);
  assert.match(stderr.text, /No fully configured email account/);
  assert.equal(stderr.text.includes('private-missing-account'), false);
  assert.equal(stdout.text, '');
  assert.throws(() => requireConfiguredAccounts({ ...account(), EMAIL_ACCOUNTS_WORK_IMAP_HOST: '' }), /incomplete/);
  assert.doesNotThrow(() => requireConfiguredAccounts({ ...account('WORK_TEAM'), ...account('HOME') }));
});

test('install accepts an existing executable without mailbox credentials or child startup', async t => {
  const directory = await temporary(t);
  const stdout = output(), stderr = output();
  assert.equal(await main(['--install'], { env: {
    EMAIL_MCP_CODEX_CONFIG: path.join(directory, 'absent.json'), EMAIL_MCP_BINARY: process.execPath,
  }, homeDir: directory, stdout, stderr, spawnImpl() { assert.fail('Install must not start a server'); } }), 0);
  assert.match(stderr.text, /executable ready/);
  assert.equal(stdout.text, '');
  await assert.rejects(fs.stat(path.join(directory, 'runtime')), { code: 'ENOENT' });
});

test('launch forwards MCP bytes and merged account env in a writable directory, then stops on EOF', async t => {
  const directory = await temporary(t);
  const configPath = path.join(directory, 'config', 'private.json');
  await saveConfig(configPath, { env: account(), binaryPath: process.execPath });
  const stdin = new PassThrough();
  const stdout = output(), stderr = output();
  const env = {
    EMAIL_MCP_CODEX_CONFIG: configPath, EMAIL_MCP_CODEX_CACHE: path.join(directory, 'cache'),
    EMAIL_ACCOUNTS_HOME_IMAP_PASSWORD: 'environment-secret', EMAIL_ALLOW_SENDING: 'false',
    EMAIL_UNRECOGNIZED: 'not-a-server-setting', PATH: 'preserved-system-path',
  };
  let spawned, received = '', killed;
  let ready;
  const wasSpawned = new Promise(resolve => { ready = resolve; });
  const result = main([], { env, homeDir: directory, stdin, stdout, stderr, spawnImpl(command, args, options) {
    spawned = { command, args, options };
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = new PassThrough();
    child.stdin.on('data', bytes => { received += bytes; });
    child.kill = signal => {
      killed = signal;
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, null));
      return true;
    };
    ready();
    return child;
  } });
  await wasSpawned;
  const request = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n';
  stdin.write(request);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received, request);
  assert.equal(spawned.command, process.execPath);
  const dataDir = path.join(path.dirname(configPath), 'runtime');
  assert.deepEqual(spawned.args, ['-Dquarkus.mcp.server.stdio.enabled=true', '-Dquarkus.config.locations=.', `-Duser.dir=${dataDir}`]);
  assert.equal(spawned.options.cwd, dataDir);
  assert.equal((await fs.stat(dataDir)).isDirectory(), true);
  assert.equal(spawned.options.shell, false);
  assert.equal(spawned.options.windowsHide, true);
  assert.deepEqual(spawned.options.stdio, ['pipe', 'inherit', 'inherit']);
  assert.equal(spawned.options.env.EMAIL_ACCOUNTS_HOME_IMAP_PASSWORD, 'environment-secret');
  assert.equal(spawned.options.env.EMAIL_ACCOUNTS_HOME_SMTP_PASSWORD, 'private-smtp-fixture');
  assert.equal(spawned.options.env.EMAIL_ALLOW_SENDING, 'false');
  assert.equal(spawned.options.env.EMAIL_ALLOW_DELETION, 'false');
  assert.equal(spawned.options.env.PATH, 'preserved-system-path');
  for (const key of ['EMAIL_MCP_CODEX_CONFIG', 'EMAIL_MCP_CODEX_CACHE', 'EMAIL_UNRECOGNIZED']) {
    assert.equal(Object.hasOwn(spawned.options.env, key), false);
  }
  stdin.end();
  assert.equal(await result, 0);
  assert.equal(killed, 'SIGTERM');
  assert.equal(stdout.text, '');
  assert.equal(stderr.text.includes('environment-secret'), false);
  assert.equal(stderr.text.includes('private-smtp-fixture'), false);
  assert.ok(stderr.text.includes(dataDir));
});

test('closed client stdin cancels startup before a native child is spawned', async t => {
  const directory = await temporary(t);
  const stdin = new PassThrough();
  stdin.destroy();
  const stdout = output(), stderr = output();
  assert.equal(await main([], { env: {
    EMAIL_MCP_CODEX_CONFIG: path.join(directory, 'absent.json'), EMAIL_MCP_BINARY: process.execPath, ...account(),
  }, homeDir: directory, stdin, stdout, stderr, spawnImpl() { assert.fail('Client already disconnected'); } }), 0);
  assert.equal(stdout.text, '');
  assert.equal(stderr.text, '');
});

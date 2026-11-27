import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = process.cwd();
const backupRoot = resolve(root, '.backups');
const uploadRoot = resolve(root, process.env.UPLOAD_DIR ?? '.data/uploads');
const mode = process.argv[2] ?? 'create';
const validName = (name) => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(name);

function fail(message) { throw new Error(message); }

function digestFile(path) {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveDigest(hash.digest('hex')));
  });
}

async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!prefix && entry.name === 'manifest.json') continue;
    const child = join(directory, entry.name);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail(`Symbolic links are not supported in backup input: ${child}`);
    if (entry.isDirectory()) files.push(...await inventory(child, path));
    else if (entry.isFile()) {
      const info = await stat(child);
      files.push({ path, bytes: info.size, sha256: await digestFile(child) });
    } else fail(`Unsupported backup input entry: ${child}`);
  }
  return files;
}

async function verify(directory) {
  const pathInfo = await lstat(directory);
  if (!pathInfo.isDirectory() || pathInfo.isSymbolicLink()) fail('Backup must be a real directory.');
  const manifestPath = join(directory, 'manifest.json');
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) fail('Backup manifest must be a regular file.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.format !== 'nri-backup-v1' || !Array.isArray(manifest.files) || !manifest.files.length) {
    fail('Unsupported or empty backup manifest.');
  }
  const actual = await inventory(directory);
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  if (expected.size !== manifest.files.length) fail('Manifest contains duplicate file paths.');
  if (!(expected.get('database.dump')?.bytes > 0)) fail('Manifest lacks a non-empty database archive.');
  if (actual.length !== expected.size) fail('Backup file inventory does not match its manifest.');
  for (const file of actual) {
    const record = expected.get(file.path);
    if (!record || record.bytes !== file.bytes || record.sha256 !== file.sha256) fail(`Manifest verification failed: ${file.path}`);
  }
  return { manifest, count: actual.length };
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const capture = options.capture === true;
    const { capture: _capture, ...spawnOptions } = options;
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', ...spawnOptions });
    let output = '';
    if (capture) child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0
      ? resolveRun(capture ? output : undefined)
      : reject(new Error(`${command} failed (${signal ?? `exit ${code}`}).`)));
  });
}

async function checkedRoot() {
  const info = await lstat(backupRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('The backup root must be a real directory.');
  return realpath(backupRoot);
}

function retentionNumber(name, fallback, minimum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${name} must be an integer of at least ${minimum}.`);
  return value;
}

async function prune(apply) {
  const directory = await checkedRoot();
  const days = retentionNumber('NRI_BACKUP_RETENTION_DAYS', 30, 1);
  const minimum = retentionNumber('NRI_BACKUP_KEEP_MINIMUM', 3, 1);
  const candidates = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !validName(entry.name) || /\.(?:reserve|incomplete-|pruning-)/.test(entry.name)) continue;
    const target = join(directory, entry.name);
    try {
      const { manifest } = await verify(target);
      const created = Date.parse(manifest.createdUtc);
      if (Number.isFinite(created)) candidates.push({ target, created });
    } catch { console.warn(`Skipped unverified backup directory ${entry.name}`); }
  }
  const cutoff = Date.now() - days * 86_400_000;
  candidates.sort((left, right) => right.created - left.created);
  for (const { target } of candidates.slice(minimum).filter(({ created }) => created < cutoff)) {
    if (!apply) { console.info(`Would remove ${target}`); continue; }
    const resolved = await realpath(target);
    if (dirname(resolved) !== directory || resolved !== target) fail('Retention target escaped the backup root.');
    const quarantine = `${target}.pruning-${randomUUID()}`;
    await rename(resolved, quarantine);
    if (dirname(await realpath(quarantine)) !== directory) fail('Retention quarantine escaped the backup root.');
    await rm(quarantine, { recursive: true });
    console.info(`Removed ${target}`);
  }
}

if (mode === 'prune') {
  if (process.argv.slice(3).some((arg) => arg !== '--apply')) fail('Usage: pnpm db:backup:prune [--apply]');
  await prune(process.argv.includes('--apply'));
} else if (mode === 'verify') {
  const name = process.argv[3];
  if (!validName(name)) {
    fail('Usage: pnpm db:backup:verify <backup-directory-name>');
  }
  const target = join(await checkedRoot(), name);
  const verified = await verify(target);
  console.info(`Verified ${verified.count} files for ${verified.manifest.database} at ${target}`);
} else if (mode === 'create') {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail('DATABASE_URL is required.');
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) fail('DATABASE_URL must use PostgreSQL.');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const username = decodeURIComponent(url.username);
  if (!database || !username) fail('DATABASE_URL must include a database and username.');
  const name = process.argv[3] ?? `nri-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
  if (!validName(name)) fail('Backup name must be a simple directory name.');
  const destination = resolve(backupRoot, name);
  const staging = `${destination}.incomplete-${randomUUID()}`;
  const reservation = `${destination}.reserve`;
  if (!destination.startsWith(`${backupRoot}${sep}`)) fail('Backup destination must be inside .backups.');
  await mkdir(backupRoot, { recursive: true });
  const actualRoot = await checkedRoot();
  if (actualRoot !== backupRoot) fail('The backup root resolves to an unexpected directory.');
  let stagingCreated = false;
  let reservationCreated = false;
  try {
    await mkdir(reservation, { recursive: false });
    reservationCreated = true;
    if (await lstat(destination).catch(() => null)) fail(`Backup destination already exists: ${destination}`);
    await mkdir(staging, { recursive: false });
    stagingCreated = true;
    const uploads = await lstat(uploadRoot).catch(() => null);
    if (!uploads?.isDirectory() || uploads.isSymbolicLink()) fail(`Upload directory must exist and must not be a symlink: ${uploadRoot}`);
    const dumpPath = join(staging, 'database.dump');
    const dumpArgs = ['--no-password', '--format=custom', '--file', dumpPath, '--host', url.hostname, '--port', String(url.port || 5432), '--username', username, '--dbname', database];
    const pgEnv = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
    if (url.searchParams.has('sslmode')) pgEnv.PGSSLMODE = url.searchParams.get('sslmode');
    try {
      await run('pg_dump', dumpArgs, { env: pgEnv });
    } catch (error) {
      if (error.code !== 'ENOENT' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw error;
      const published = (await run('docker', ['compose', 'port', 'db', '5432'], { capture: true })).trim();
      if (!['127.0.0.1', '[::1]'].some((host) => published === `${host}:${url.port || 5432}`)) {
        fail('Compose database port does not match DATABASE_URL. Use the PostgreSQL client tools for this database.');
      }
      const { open } = await import('node:fs/promises');
      const dumpFile = await open(dumpPath, 'w');
      try {
        await run('docker', [
          'compose', 'exec', '-T', 'db', 'sh', '-c',
          'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump --no-password --format=custom --username="$1" --dbname="$2"',
          'nri-backup', username, database,
        ], { stdio: ['ignore', dumpFile.fd, 'inherit'] });
      } finally { await dumpFile.close(); }
      const dumpInfo = await stat(dumpPath);
      if (dumpInfo.size === 0) fail('Docker Compose pg_dump returned an empty archive.');
    }
    await cp(uploadRoot, join(staging, 'uploads'), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
    const files = await inventory(staging);
    if (files.length < 1 || !files.some((file) => file.path === 'database.dump')) fail('Database archive was not created.');
    const revision = (await run('git', ['rev-parse', 'HEAD'], { cwd: root, capture: true }).catch(() => 'unknown')).trim();
    const manifest = {
      format: 'nri-backup-v1',
      createdUtc: new Date().toISOString(),
      database,
      revision,
      uploadsDirectory: relative(root, uploadRoot).split(sep).join('/'),
      files,
    };
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    const checked = await verify(staging);
    if (await lstat(destination).catch(() => null)) fail(`Backup destination appeared during creation; refusing to overwrite: ${destination}`);
    await rename(staging, destination);
    stagingCreated = false;
    console.info(`Created and verified ${checked.count} files at ${destination}`);
    console.info('Writes must remain quiesced until this completes; resume them only after verifying the backup.');
  } catch (error) {
    if (stagingCreated && dirname(await realpath(staging)) === actualRoot) await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    if (reservationCreated) await rmdir(reservation);
  }
} else fail('Usage: pnpm db:backup [name] | pnpm db:backup:verify <name> | pnpm db:backup:prune [--apply]');

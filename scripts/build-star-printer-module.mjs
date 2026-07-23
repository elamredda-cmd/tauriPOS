import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repository, 'printer-modules', 'star-tsp100');
const config = JSON.parse(readFileSync(join(source, 'module.json'), 'utf8'));
const working = join(repository, '.printer-module-build', config.id);
const published = join(working, 'published');
const packageSource = join(working, 'package');
const artifactDirectory = join(repository, 'artifacts', 'printer-modules');
const artifact = join(artifactDirectory, `${config.id}-${config.version}.lbjprinter`);

rmSync(working, { recursive: true, force: true });
mkdirSync(published, { recursive: true });
mkdirSync(packageSource, { recursive: true });
mkdirSync(artifactDirectory, { recursive: true });

const publish = spawnSync('dotnet', [
    'publish',
    join(source, 'Lbj.StarTsp100.Module.csproj'),
    '--configuration', 'Release',
    '--output', published,
    '--nologo',
], { cwd: repository, stdio: 'inherit' });
if (publish.status !== 0) process.exit(publish.status ?? 1);

const distributableExtensions = new Set(['.dll', '.exe', '.config', '.json', '.txt']);
for (const entry of readdirSync(published, { withFileTypes: true })) {
    if (!entry.isFile() || !distributableExtensions.has(extname(entry.name).toLowerCase())) continue;
    if (entry.name.toLowerCase().endsWith('_x86.dll')) continue;
    cpSync(join(published, entry.name), join(packageSource, entry.name));
}

const executable = join(packageSource, config.executable);
if (!existsSync(executable)) {
    throw new Error(`The Star module executable was not produced: ${executable}`);
}

writeFileSync(join(packageSource, 'module.json'), `${JSON.stringify(config, null, 2)}\n`);
const starLicense = join(
    homedir(),
    '.nuget',
    'packages',
    'starmicronics.stario.desktop',
    '2.12.0',
    'SoftwareLicenseAgreement.txt',
);
if (!existsSync(starLicense)) {
    throw new Error('The restored Star SDK licence file could not be found.');
}
cpSync(starLicense, join(packageSource, 'STAR-SDK-LICENSE.txt'));
writeFileSync(
    join(packageSource, 'STAR-SDK-NOTICE.txt'),
    [
        'StarIO and StarIOExtension Copyright (c) Star Micronics Co., Ltd.',
        'StarMicronics.StarIO.Desktop 2.12.0',
        'StarMicronics.StarIOExtension.Desktop 1.10.0',
        '',
        'Official SDK licence:',
        'https://www.star-m.jp/wp-content/uploads/SoftwareLicenseAgreement_web.pdf',
        '',
    ].join('\n'),
);

const pack = spawnSync(process.execPath, [
    join(repository, 'scripts', 'pack-printer-module.mjs'),
    packageSource,
    artifact,
], { cwd: repository, stdio: 'inherit' });
if (pack.status !== 0) process.exit(pack.status ?? 1);

const verify = spawnSync(process.execPath, [
    join(repository, 'scripts', 'verify-printer-module.mjs'),
    artifact,
], { cwd: repository, stdio: 'inherit' });
if (verify.status !== 0) process.exit(verify.status ?? 1);

console.log(`Star TSP100 module ready: ${artifact}`);

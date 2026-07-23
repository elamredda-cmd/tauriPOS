import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageArgument = process.argv[2];
if (!packageArgument) {
    throw new Error('Usage: node scripts/verify-printer-module.mjs <package.lbjprinter>');
}

const packagePath = resolve(packageArgument);
const archive = unzipSync(new Uint8Array(readFileSync(packagePath)));
if (!archive['manifest.json']) throw new Error('The package does not contain manifest.json');
const manifest = JSON.parse(strFromU8(archive['manifest.json']));
const trustedKeys = JSON.parse(readFileSync(resolve(repository, 'src-tauri', 'printer-module-public-keys.json'), 'utf8'));
const encodedKey = trustedKeys[manifest.keyId];
if (!encodedKey) throw new Error(`The module key is not trusted: ${manifest.keyId}`);

function compareUtf8(left, right) {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

const expectedFiles = new Set(['manifest.json']);
for (const file of manifest.files || []) {
    expectedFiles.add(file.path);
    const bytes = archive[file.path];
    if (!bytes) throw new Error(`Signed module file is missing: ${file.path}`);
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== file.sha256) throw new Error(`Module file hash does not match: ${file.path}`);
}
for (const path of Object.keys(archive)) {
    if (!expectedFiles.has(path)) throw new Error(`Unsigned extra file in module: ${path}`);
}

const signedManifest = {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    name: manifest.name,
    vendor: manifest.vendor,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    executable: manifest.executable,
    supportedOs: manifest.supportedOs,
    supportedArch: manifest.supportedArch,
    capabilities: manifest.capabilities,
    files: [...manifest.files].sort((left, right) => compareUtf8(left.path, right.path)),
    keyId: manifest.keyId,
};
const payload = Buffer.concat([
    Buffer.from('LBJ-PRINTER-MODULE-V1\n', 'utf8'),
    Buffer.from(JSON.stringify(signedManifest), 'utf8'),
]);
const rawPublicKey = Buffer.from(encodedKey, 'base64url');
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const publicKey = createPublicKey({
    key: Buffer.concat([spkiPrefix, rawPublicKey]),
    format: 'der',
    type: 'spki',
});
if (!verify(null, payload, publicKey, Buffer.from(manifest.signature, 'base64url'))) {
    throw new Error('The printer-module signature is invalid');
}

console.log(`Verified printer module: ${manifest.name} v${manifest.version}`);
console.log(`Signature key: ${manifest.keyId}`);
console.log(`Signed files: ${manifest.files.length}`);

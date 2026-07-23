import { createPrivateKey, createPublicKey, createHash, sign } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { strToU8, zipSync } from 'fflate';

const [sourceArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument) {
    throw new Error('Usage: npm run pack:printer-module -- <module-folder> [output.lbjprinter]');
}

const source = resolve(sourceArgument);
const moduleConfigPath = join(source, 'module.json');
const config = JSON.parse(readFileSync(moduleConfigPath, 'utf8'));
const output = resolve(outputArgument || `${config.id || basename(source)}-${config.version || 'module'}.lbjprinter`);
if (!output.endsWith('.lbjprinter')) throw new Error('The output file must end with .lbjprinter');

const issuerDirectory = join(homedir(), '.lbj-pos', 'licensing');
const issuer = JSON.parse(readFileSync(join(issuerDirectory, 'issuer.json'), 'utf8'));
const pem = readFileSync(join(issuerDirectory, 'issuer-private.pem'), 'utf8');
const privateKey = createPrivateKey({
    key: pem,
    format: 'pem',
    passphrase: process.env.LBJ_ISSUER_KEY_PASSWORD || undefined,
});
const publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
const publicKey = Buffer.from(publicDer).subarray(-32).toString('base64url');
if (publicKey !== issuer.publicKey) throw new Error('The issuer private key does not match issuer.json');

function listFiles(directory) {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${path}`);
        if (entry.isDirectory()) files.push(...listFiles(path));
        else if (entry.isFile() && path !== moduleConfigPath) files.push(path);
    }
    return files;
}

function compareUtf8(left, right) {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

const archivePathFor = (path) => relative(source, path).split(sep).join('/');
const sourceFiles = listFiles(source).sort((left, right) =>
    compareUtf8(archivePathFor(left), archivePathFor(right)),
);
const files = sourceFiles.map((path) => {
    const archivePath = archivePathFor(path);
    const bytes = readFileSync(path);
    return {
        path: archivePath,
        sha256: createHash('sha256').update(bytes).digest('hex'),
    };
});

const signedManifest = {
    schemaVersion: 1,
    id: String(config.id || ''),
    name: String(config.name || ''),
    vendor: String(config.vendor || ''),
    version: String(config.version || ''),
    apiVersion: 1,
    executable: String(config.executable || ''),
    supportedOs: Array.isArray(config.supportedOs) ? config.supportedOs.map(String) : [],
    supportedArch: Array.isArray(config.supportedArch) ? config.supportedArch.map(String) : [],
    capabilities: Array.isArray(config.capabilities) ? config.capabilities.map(String) : [],
    files,
    keyId: issuer.keyId,
};
const domain = Buffer.from('LBJ-PRINTER-MODULE-V1\n', 'utf8');
const message = Buffer.concat([domain, Buffer.from(JSON.stringify(signedManifest), 'utf8')]);
const signature = sign(null, message, privateKey).toString('base64url');
const manifest = { ...signedManifest, signature };

const archive = {
    'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
};
for (const file of sourceFiles) {
    const archivePath = relative(source, file).split(sep).join('/');
    archive[archivePath] = new Uint8Array(readFileSync(file));
}

writeFileSync(output, zipSync(archive, { level: 6 }));
console.log(`Signed printer module: ${output}`);
console.log(`Key: ${issuer.keyId}`);
console.log(`Files: ${files.length}`);

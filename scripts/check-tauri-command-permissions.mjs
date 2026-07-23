import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name.startsWith('.')) return [];
        const target = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(target) : [target];
    });
}

const frontendCommands = new Set();
const unannotatedDynamicInvokes = [];
const frontendFiles = walk(path.join(projectRoot, 'src'))
    .filter((file) => /\.(svelte|ts)$/.test(file));

for (const file of frontendFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/tauri-invoke:[ \t]*([a-z0-9_, -]+)/gi)) {
        for (const command of match[1].split(',').map((value) => value.trim()).filter(Boolean)) {
            frontendCommands.add(command);
        }
    }

    const invokePattern = /\binvoke(?:<[^>]+>)?\s*\(\s*/g;
    for (const match of source.matchAll(invokePattern)) {
        const argumentStart = match.index + match[0].length;
        const quote = source[argumentStart];
        if (quote === "'" || quote === '"') {
            const commandEnd = source.indexOf(quote, argumentStart + 1);
            if (commandEnd > argumentStart) {
                frontendCommands.add(source.slice(argumentStart + 1, commandEnd));
            }
            continue;
        }

        const nearbySource = source.slice(Math.max(0, match.index - 240), match.index);
        if (!/tauri-invoke:[ \t]*[a-z0-9_, -]+/i.test(nearbySource)) {
            const line = source.slice(0, match.index).split('\n').length;
            unannotatedDynamicInvokes.push(`${path.relative(projectRoot, file)}:${line}`);
        }
    }
}

const rustSource = fs.readFileSync(path.join(projectRoot, 'src-tauri/src/lib.rs'), 'utf8');
const handlerBlock = rustSource.match(/invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/)?.[1] || '';
const registeredCommands = new Set(
    [...handlerBlock.matchAll(/(?:[A-Za-z0-9_]+::)*([A-Za-z0-9_]+)\s*,/g)].map((match) => match[1]),
);

const permissionCommands = new Map();
const permissionFiles = walk(path.join(projectRoot, 'src-tauri/permissions'))
    .filter((file) => file.endsWith('.toml'));
for (const file of permissionFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\[\[permission\]\]([\s\S]*?)(?=\[\[permission\]\]|$)/g)) {
        const block = match[1];
        const identifier = block.match(/identifier\s*=\s*"([^"]+)"/)?.[1];
        const allowed = block.match(/commands\.allow\s*=\s*\[([^\]]*)\]/)?.[1]
            .match(/"([^"]+)"/g)
            ?.map((value) => value.slice(1, -1)) || [];
        if (identifier) permissionCommands.set(identifier, allowed);
    }
}

const capability = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'src-tauri/capabilities/default.json'), 'utf8'),
);
const enabledCommands = new Set(
    capability.permissions.flatMap((identifier) => permissionCommands.get(identifier) || []),
);

const missingRegistration = [...frontendCommands]
    .filter((command) => !registeredCommands.has(command))
    .sort();
const missingCapability = [...frontendCommands]
    .filter((command) => !enabledCommands.has(command))
    .sort();
const registeredWithoutCapability = [...registeredCommands]
    .filter((command) => !enabledCommands.has(command))
    .sort();

const problems = [
    unannotatedDynamicInvokes.length
        ? `Dynamic invoke calls missing a tauri-invoke annotation:\n  ${unannotatedDynamicInvokes.join('\n  ')}`
        : '',
    missingRegistration.length
        ? `Frontend commands missing from generate_handler!:\n  ${missingRegistration.join('\n  ')}`
        : '',
    missingCapability.length
        ? `Frontend commands missing from the main-window capability:\n  ${missingCapability.join('\n  ')}`
        : '',
    registeredWithoutCapability.length
        ? `Registered commands missing from the main-window capability:\n  ${registeredWithoutCapability.join('\n  ')}`
        : '',
].filter(Boolean);

if (problems.length > 0) {
    console.error(problems.join('\n\n'));
    process.exit(1);
}

console.log(
    `Tauri command audit passed: ${frontendCommands.size} frontend commands, `
    + `${registeredCommands.size} registered commands, all permitted.`,
);

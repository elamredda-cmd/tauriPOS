# L&Bj POS Printer Modules

Printer modules add vendor SDK support without replacing the main POS installation. They are local to one till and never synchronize through SQLite or MariaDB.

## Package

A module is a signed ZIP archive with the `.lbjprinter` extension. Its root contains `manifest.json` and every executable or SDK file listed by that manifest. Installation rejects path traversal, extra unsigned files, missing files, hash mismatches, incompatible platforms, unsupported API versions, and untrusted signatures. The same checks run again before every module job, so files added or changed after installation disable the module.

Create a source folder containing `module.json`, the module executable, and its SDK files:

```json
{
  "id": "star-prnt",
  "name": "StarPRNT Adapter",
  "vendor": "L&Bj",
  "version": "1.0.0",
  "executable": "star-prnt.exe",
  "supportedOs": ["windows"],
  "supportedArch": ["x86_64"],
  "capabilities": ["discoverDevices", "printRaw", "openDrawer", "getStatus", "cancelJob", "healthCheck"]
}
```

Package and sign it with the existing L&Bj issuer key:

```bash
npm run pack:printer-module -- ./path/to/star-module ./star-prnt-1.0.0.lbjprinter
```

For an encrypted issuer key, provide `LBJ_ISSUER_KEY_PASSWORD` in the packaging terminal. Never place the private key in a module or this repository.

## Process Contract

The POS starts the signed executable with `--lbj-printer-module`. It writes exactly one JSON request to standard input and waits for one JSON response on standard output. Diagnostic text belongs on standard error.

```json
{
  "apiVersion": 1,
  "requestId": 42,
  "operation": "printRaw",
  "payload": {
    "deviceId": "USB:Star TSP100",
    "documentName": "Receipt 1032",
    "protocol": "star-line",
    "dataBase64": "G0AbYQ..."
  }
}
```

A successful response must include `ok: true`:

```json
{
  "ok": true,
  "jobId": "vendor-job-123",
  "status": "accepted",
  "message": "Receipt accepted"
}
```

Failures may return `{ "ok": false, "message": "Printer is offline" }` and a non-zero process exit is treated as a module failure. The host enforces a timeout, serializes requests per module, limits response size, and rechecks signatures and file hashes before execution.

## Supported Operations

- `discoverDevices`
- `getCapabilities`
- `printRaw`
- `printReceipt`
- `printLabel`
- `openDrawer`
- `getStatus`
- `cancelJob`
- `healthCheck`

Only operations declared in the signed `capabilities` list may run, except `getCapabilities` and `healthCheck`.

## Star TSP100 USB Module

The first-party `star-tsp100` module uses Star's official StarIO Desktop SDK on Windows x64. It discovers USB Star printers, reports printer/paper/cover/cutter status, sends Star Line receipts and Star Graphic raster jobs, and opens an attached drawer through the Star SDK.

Build and sign it with:

```bash
npm run build:printer-module:star
```

The installable file is written to:

```text
artifacts/printer-modules/star-tsp100-1.0.1.lbjprinter
```

Install that file from **Settings > Printers > Modules > Install Module** on each Windows till that needs it. The Star futurePRNT driver must already be installed. The TSP100 uses continuous receipt roll; Star Graphic jobs can print a raster layout, but the printer does not gain the gap sensing or media positioning of a dedicated label printer.

## Security Boundary

Printer modules are trusted native programs signed by L&Bj. They run outside the POS process, but they run with the same Windows user permissions as the POS and can use a vendor SDK or installed driver. Only install modules built and signed by L&Bj; a third-party SDK should be wrapped and reviewed before its module package is signed.

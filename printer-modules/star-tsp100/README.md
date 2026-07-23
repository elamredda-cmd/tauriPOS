# Star TSP100 Printer Module

This Windows x64 adapter connects L&Bj POS to a USB Star TSP100 through Star's official StarIO Desktop SDK.

Supported operations:

- USB printer discovery
- Printer, paper, cover, and cutter status
- Star Line receipt jobs
- Star Graphic raster jobs
- Cash drawer channel 1 or 2

The till must have the appropriate Star futurePRNT Windows driver installed. The TSP100 is a continuous-roll receipt printer and does not provide gap-sensing label-media control.

Build and sign the installable package from the repository root:

```bash
npm run build:printer-module:star
```

The signed package is written to `artifacts/printer-modules/star-tsp100-1.0.1.lbjprinter`.

StarIO is licensed by Star Micronics. Review Star's current SDK licence before distributing the module commercially.

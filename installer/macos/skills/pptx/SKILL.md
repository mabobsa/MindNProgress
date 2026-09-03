---
name: pptx
description: Inspect PowerPoint files on macOS using structure extraction and rendered slide images.
---

# PowerPoint verification on macOS

1. Open the presentation with `pptx-mcp` and inspect its text and table structure.
2. Call `export_slides_to_images` for every slide.
3. Confirm that the response renderer is `libreoffice+pymupdf`.
4. Inspect every generated PNG; do not infer layout from extracted text alone.
5. Record font substitution, SmartArt, chart, animation, or layout differences that still require direct PowerPoint verification.

LibreOffice is the native macOS renderer used by this installation. Microsoft PowerPoint COM is Windows-only and must not be expected on macOS.

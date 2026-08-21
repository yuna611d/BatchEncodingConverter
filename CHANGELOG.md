# Change Log

All notable changes to the "batchencodingconverter" extension will be documented in this file.

## v1.1.0

### Added

- EUC-JP, UTF-8 with BOM, UTF-16 LE and UTF-16 BE, on top of the existing Shift_JIS and UTF-8
- Any encoding can now be converted to any other; the source and target are chosen from a picker
- Files that lose characters the target encoding cannot represent are reported instead of silently succeeding

### Changed

- **Breaking:** the commands `extension.convertSjisToUTF8` and `extension.convertUTF8ToSjis`
  are replaced by a single `extension.convertEncoding`. Keybindings or tasks referring to the
  old command ids need updating.
- Binary detection now decodes the leading bytes with the source encoding. The previous
  raw-byte check treated all UTF-16 text as binary.

## Unreleased

- Wait for conversion to actually finish before reporting success
- Skip binary files without raising an uncaught exception
- Report read/write failures instead of crashing the extension host
- Limit how many files are converted in parallel
- Replace the deprecated `vscode` package with `@types/vscode` and `@vscode/test-electron`
- Replace tslint with eslint, and add `lint` / `test` npm scripts
- Add unit tests covering the conversion logic

## v1.0.3

- Resolve some dependency

## v1.0.2

- Some bugs are fixed

## v1.0.1

- Add feature to skip binary file

## v1.0.0

- Initial release

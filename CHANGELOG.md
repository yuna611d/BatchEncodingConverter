# Change Log

All notable changes to the "batchencodingconverter" extension will be documented in this file.

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

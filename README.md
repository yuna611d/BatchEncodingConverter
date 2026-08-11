# README

This extension convert encoding of files in a current workspace.

## Commands

* BatchEncodingConvert: SJIS to UTF8

  * Convert file encoding from ShiftJIS to UTF-8; And output converted files in a `_UTF-8` directory

* BatchEncodingConvert: UTF8 to SJIS

  * Convert file encoding from UTF-8 to ShiftJIS; And output converted files in a `_Shift_JIS` directory

## Notes

* Only files directly under the first workspace folder are converted. Sub directories are not traversed.
* Files that look binary (a NUL or other low control byte in the first 512 bytes) are skipped.
* Existing files in the output directory are overwritten.
* When the run finishes, a message reports how many files were converted, skipped and failed.

## Development

```sh
npm install
npm test              # lint + unit tests
npm run compile       # tsc -p ./
npm run lint          # eslint
npm run test:unit     # mocha, no VS Code required
npm run test:integration   # downloads VS Code and runs the extension host suite
```

Tests live in two places:

* `src/test/unit` runs under plain mocha. `src/test/unit/vscodeStub.ts` substitutes the
  `vscode` module so the conversion logic can be exercised without an extension host.
* `src/test/suite` runs inside a real VS Code instance via `@vscode/test-electron`, and
  covers what only the extension host can answer, such as command registration.

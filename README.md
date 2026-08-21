# README

This extension converts the encoding of files in a current workspace.

## Command

* **BatchEncodingConvert: Convert Files Encoding**

  Pick the encoding to convert *from*, then the encoding to convert *to*. The
  converted files are written to a `_<encoding>` directory inside the workspace
  (for example `_UTF-8`), leaving the originals untouched.

## Supported encodings

| Encoding | Notes |
| --- | --- |
| Shift_JIS | |
| EUC-JP | |
| UTF-8 | No BOM |
| UTF-8 with BOM | |
| UTF-16 LE | A BOM is always written, otherwise the byte order is not recoverable |
| UTF-16 BE | A BOM is always written |

Any encoding can be converted to any other, so all 30 combinations are available
from the single command. A BOM on the source file is removed during conversion.

## Notes

* Only files directly under the first workspace folder are converted. Sub directories are not traversed.
* Files that look binary are skipped. A file is judged by decoding its first 512
  bytes with the source encoding, so UTF-16 text is not mistaken for binary.
* Existing files in the output directory are overwritten.
* If the target encoding cannot represent a character (for example an emoji
  converted to Shift_JIS), the character becomes `?` and the file is listed in a
  warning rather than being reported as a clean success.
* When the run finishes, a message reports how many files were converted,
  skipped, lost characters and failed.

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

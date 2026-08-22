# README

This extension converts the encoding of files in a current workspace.

## Command

* **BatchEncodingConvert: Convert Files Encoding**

  Pick the encoding to convert *from*, then the encoding to convert *to*, then
  whether to include sub directories. The converted files are written to a
  `_<encoding>` directory inside the workspace (for example `_UTF-8`), leaving
  the originals untouched.

## Supported encodings

| Encoding | Notes |
| --- | --- |
| Shift_JIS | |
| EUC-JP | |
| ISO-2022-JP (JIS) | Seven bit, stateful; converted with `encoding-japanese` because iconv-lite does not implement it |
| UTF-8 | No BOM |
| UTF-8 with BOM | |
| UTF-16 LE | A BOM is always written, otherwise the byte order is not recoverable |
| UTF-16 BE | A BOM is always written |

Any encoding can be converted to any other, so all 42 combinations are available
from the single command. A BOM on the source file is removed during conversion.

## Notes

* The command asks whether to convert only the files directly in the workspace
  folder, or to include sub directories. Sub directories are mirrored under the
  output directory, so `src/util/a.txt` becomes `_UTF-8/src/util/a.txt`.
* Only the first workspace folder is used in a multi-root workspace.
* Files that look binary are skipped. A file is judged by decoding its first 512
  bytes with the source encoding, so UTF-16 text is not mistaken for binary.
* Existing files in the output directory are overwritten.
* If the target encoding cannot represent a character (for example an emoji
  converted to Shift_JIS), the character becomes `?` and the file is listed in a
  warning rather than being reported as a clean success.
* When the run finishes, a message reports how many files were converted,
  skipped, lost characters and failed. Files are named by their path relative to
  the workspace folder, so two `index.txt` in different directories stay apart.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `batchEncodingConverter.excludeDirectories` | `["node_modules"]` | Directory names skipped when converting sub directories. |

Three kinds of directory are always skipped while descending, whatever the setting says:

* hidden directories, whose name starts with a dot (`.git`, `.vscode`, …)
* the extension's own `_<encoding>` output directories, so a run never eats the output of an earlier one
* symbolic links to directories, which could otherwise loop forever

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

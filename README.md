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

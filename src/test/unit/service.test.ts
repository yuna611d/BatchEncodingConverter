'use strict';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as iconv from 'iconv-lite';
// Imported before the service so the `vscode` stub is registered first.
import { setWorkspace } from './vscodeStub';
import {
    Service, EncodingTransform, EncodingSpec, EncodingPair, FilePathPair, ConversionSummary,
    ENCODINGS, findEncoding, targetsFor, isOutputDirectoryName, DEFAULT_EXCLUDE_DIRECTORIES
} from '../../Services/Service';

function spec(id: string): EncodingSpec {
    const found = findEncoding(id);
    if (!found) {
        throw new Error(`unknown encoding id: ${id}`);
    }
    return found;
}

const SJIS = spec('Shift_JIS');
const UTF8 = spec('UTF-8');
const UTF8_BOM = spec('UTF-8-BOM');
const UTF16LE = spec('UTF-16LE');
const UTF16BE = spec('UTF-16BE');

const JAPANESE = 'こんにちは世界\nABC 123\n';

function pair(src: EncodingSpec, dist: EncodingSpec): EncodingPair {
    return {srcEncoding: src, distEncoding: dist};
}

/** Bytes for `text` as a file genuinely stored in `target` would hold them. */
function encodeAs(target: EncodingSpec, text: string): Buffer {
    return iconv.encode(text, target.iconvName, {addBOM: target.addBOM});
}

suite('Service', () => {

    let workspace: string;
    const created: string[] = [];

    setup(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bec-'));
        created.push(workspace);
        setWorkspace(workspace);
    });

    suiteTeardown(() => {
        created.forEach(dir => fs.rmSync(dir, {recursive: true, force: true}));
    });

    function write(name: string, contents: Buffer | string): void {
        const target = path.join(workspace, name);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, contents);
    }

    function outputBytes(summary: ConversionSummary, name: string): Buffer {
        return fs.readFileSync(path.join(summary.outputDir, name));
    }

    function outputText(summary: ConversionSummary, name: string, target: EncodingSpec): string {
        return iconv.decode(outputBytes(summary, name), target.iconvName);
    }

    suite('encoding catalogue', () => {

        test('offers every encoding as a source', () => {
            const ids = ENCODINGS.map(e => e.id);
            assert.deepStrictEqual(ids, ['Shift_JIS', 'EUC-JP', 'UTF-8', 'UTF-8-BOM', 'UTF-16LE', 'UTF-16BE']);
        });

        test('never offers converting an encoding into itself', () => {
            ENCODINGS.forEach(source => {
                const targetIds = targetsFor(source).map(e => e.id);
                assert.strictEqual(targetIds.indexOf(source.id), -1, `${source.id} offered itself as a target`);
                assert.strictEqual(targetIds.length, ENCODINGS.length - 1);
            });
        });

        test('resolves encodings by id and rejects unknown ones', () => {
            assert.strictEqual(spec('EUC-JP').iconvName, 'EUC-JP');
            assert.strictEqual(findEncoding('KOI8-R'), undefined);
        });
    });

    suite('round trips', () => {

        // Every encoding must survive a trip out to UTF-8 and back again.
        ENCODINGS.forEach(source => {
            test(`converts ${source.id} to UTF-8 and back`, async () => {
                write('a.txt', encodeAs(source, JAPANESE));

                const out = await new Service(pair(source, UTF8)).convertEncoding();
                assert.deepStrictEqual(out.failed, []);
                assert.deepStrictEqual(out.skipped, [], `${source.id} was mistaken for a binary file`);
                assert.deepStrictEqual(out.lossy, []);
                assert.strictEqual(outputText(out, 'a.txt', UTF8), JAPANESE);

                // ...and back the other way, comparing the bytes a real file would have.
                setWorkspace(workspace);
                write('b.txt', encodeAs(UTF8, JAPANESE));
                const back = await new Service(pair(UTF8, source)).convertEncoding();
                assert.deepStrictEqual(back.failed, []);
                assert.deepStrictEqual(back.lossy, []);
                assert.deepStrictEqual(outputBytes(back, 'b.txt'), encodeAs(source, JAPANESE));
            });
        });
    });

    suite('UTF-16', () => {

        test('does not mistake UTF-16 text for a binary file', async () => {
            // UTF-16 text is full of NUL bytes; a raw-byte sniffer skips it every time.
            write('le.txt', encodeAs(UTF16LE, JAPANESE));

            const out = await new Service(pair(UTF16LE, UTF8)).convertEncoding();

            assert.deepStrictEqual(out.skipped, []);
            assert.strictEqual(out.converted, 1);
            assert.strictEqual(outputText(out, 'le.txt', UTF8), JAPANESE);
        });

        test('writes a byte order mark so the endianness is recoverable', async () => {
            write('a.txt', encodeAs(UTF8, JAPANESE));

            const le = await new Service(pair(UTF8, UTF16LE)).convertEncoding();
            assert.deepStrictEqual(outputBytes(le, 'a.txt').slice(0, 2), Buffer.from([0xFF, 0xFE]));

            setWorkspace(workspace);
            const be = await new Service(pair(UTF8, UTF16BE)).convertEncoding();
            assert.deepStrictEqual(outputBytes(be, 'a.txt').slice(0, 2), Buffer.from([0xFE, 0xFF]));
        });

        test('separates LE and BE output directories', async () => {
            write('a.txt', encodeAs(UTF8, JAPANESE));

            const le = await new Service(pair(UTF8, UTF16LE)).convertEncoding();
            const be = await new Service(pair(UTF8, UTF16BE)).convertEncoding();

            assert.strictEqual(le.outputDir, path.join(workspace, '_UTF-16LE'));
            assert.strictEqual(be.outputDir, path.join(workspace, '_UTF-16BE'));
            assert.notDeepStrictEqual(outputBytes(le, 'a.txt'), outputBytes(be, 'a.txt'));
        });
    });

    suite('byte order marks', () => {

        test('adds a BOM for UTF-8-BOM and omits it for UTF-8', async () => {
            write('a.txt', encodeAs(SJIS, JAPANESE));

            const withBom = await new Service(pair(SJIS, UTF8_BOM)).convertEncoding();
            assert.deepStrictEqual(outputBytes(withBom, 'a.txt').slice(0, 3), Buffer.from([0xEF, 0xBB, 0xBF]));

            setWorkspace(workspace);
            const without = await new Service(pair(SJIS, UTF8)).convertEncoding();
            assert.notDeepStrictEqual(outputBytes(without, 'a.txt').slice(0, 3), Buffer.from([0xEF, 0xBB, 0xBF]));
        });

        test('strips the BOM when reading a UTF-8-BOM source', async () => {
            write('a.txt', encodeAs(UTF8_BOM, JAPANESE));

            const out = await new Service(pair(UTF8_BOM, SJIS)).convertEncoding();

            // A stray BOM would survive as U+FEFF, which Shift_JIS cannot represent.
            assert.deepStrictEqual(out.lossy, []);
            assert.deepStrictEqual(outputBytes(out, 'a.txt'), iconv.encode(JAPANESE, 'Shift_JIS'));
        });
    });

    suite('characters the target cannot represent', () => {

        test('reports the file but still writes it', async () => {
            write('emoji.txt', encodeAs(UTF8, 'メール😀です\n'));
            write('plain.txt', encodeAs(UTF8, 'ふつうの日本語\n'));

            const out = await new Service(pair(UTF8, SJIS)).convertEncoding();

            assert.deepStrictEqual(out.lossy, ['emoji.txt']);
            assert.strictEqual(out.converted, 2, 'a lossy file still counts as converted');
            assert.deepStrictEqual(out.failed, []);
            assert.strictEqual(outputText(out, 'emoji.txt', SJIS), 'メール?です\n');
        });

        test('does not cry wolf when every character survives', async () => {
            write('a.txt', encodeAs(UTF8, '日本語とASCIIと記号：★①\n'));

            const out = await new Service(pair(UTF8, SJIS)).convertEncoding();

            assert.deepStrictEqual(out.lossy, []);
        });

        test('does not flag a question mark that was already in the source', async () => {
            write('a.txt', encodeAs(UTF8, 'これは何ですか? Really?\n'));

            const out = await new Service(pair(UTF8, SJIS)).convertEncoding();

            assert.deepStrictEqual(out.lossy, []);
        });
    });

    suite('binary files', () => {

        test('still skips binary content', async () => {
            write('text.txt', encodeAs(SJIS, JAPANESE));
            write('image.png', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));

            const out = await new Service(pair(SJIS, UTF8)).convertEncoding();

            assert.deepStrictEqual(out.skipped, ['image.png']);
            assert.strictEqual(out.converted, 1);
            assert.strictEqual(fs.existsSync(path.join(out.outputDir, 'image.png')), false);
        });

        test('treats a single NUL byte as binary even in otherwise plain text', async () => {
            const text = iconv.encode('ほとんどはただの日本語テキストです。'.repeat(10), 'Shift_JIS');
            write('stray.txt', Buffer.concat([text, Buffer.from([0x00]), text]));

            const out = await new Service(pair(SJIS, UTF8)).convertEncoding();

            assert.deepStrictEqual(out.skipped, ['stray.txt']);
        });

        test('treats short and empty files as text', async () => {
            write('tiny.txt', encodeAs(SJIS, 'あ'));
            write('empty.txt', Buffer.alloc(0));

            const out = await new Service(pair(SJIS, UTF8)).convertEncoding();

            assert.deepStrictEqual(out.skipped, []);
            assert.strictEqual(out.converted, 2);
            assert.strictEqual(outputText(out, 'tiny.txt', UTF8), 'あ');
            assert.strictEqual(outputBytes(out, 'empty.txt').length, 0);
        });
    });

    suite('workspace traversal', () => {

        test('writes every converted file before it resolves', async () => {
            write('a.txt', encodeAs(SJIS, JAPANESE));
            write('b.txt', encodeAs(SJIS, 'あいうえお'));

            const out = await new Service(pair(SJIS, UTF8)).convertEncoding();

            // The files must be complete right now, not at some later tick.
            assert.strictEqual(outputText(out, 'a.txt', UTF8), JAPANESE);
            assert.strictEqual(outputText(out, 'b.txt', UTF8), 'あいうえお');
            assert.strictEqual(out.converted, 2);
        });

        test('ignores sub directories and the output directory itself', async () => {
            write('top.txt', encodeAs(SJIS, 'うえ'));
            write(path.join('nested', 'inner.txt'), encodeAs(SJIS, 'した'));

            const out = await new Service(pair(SJIS, UTF8)).convertEncoding();

            assert.strictEqual(out.converted, 1);
            assert.deepStrictEqual(fs.readdirSync(out.outputDir), ['top.txt']);
        });

        test('overwrites a stale file left in the output directory', async () => {
            write('a.txt', encodeAs(SJIS, 'あたらしい'));
            write(path.join('_UTF-8', 'a.txt'), 'ふるい');

            const out = await new Service(pair(SJIS, UTF8)).convertEncoding();

            assert.strictEqual(outputText(out, 'a.txt', UTF8), 'あたらしい');
        });
    });


    suite('sub directories', () => {

        /** Every file under dir, relative to it, with forward slashes. */
        function tree(dir: string): string[] {
            const found: string[] = [];
            const walk = (current: string) => {
                for (const entry of fs.readdirSync(current).sort()) {
                    const full = path.join(current, entry);
                    if (fs.statSync(full).isDirectory()) {
                        walk(full);
                    } else {
                        found.push(path.relative(dir, full).split(path.sep).join('/'));
                    }
                }
            };
            walk(dir);
            return found;
        }

        function writeTree(): void {
            write('top.txt', encodeAs(SJIS, 'てっぺん'));
            write(path.join('a', 'one.txt'), encodeAs(SJIS, 'いち'));
            write(path.join('a', 'b', 'two.txt'), encodeAs(SJIS, 'に'));
            write(path.join('a', 'b', 'c', 'three.txt'), encodeAs(SJIS, 'さん'));
        }

        test('converts only the top level by default', async () => {
            writeTree();

            const out = await new Service(pair(SJIS, UTF8)).convertEncoding();

            assert.deepStrictEqual(tree(out.outputDir), ['top.txt']);
            assert.strictEqual(out.converted, 1);
        });

        test('mirrors the tree when recursive', async () => {
            writeTree();

            const out = await new Service(pair(SJIS, UTF8), {recursive: true}).convertEncoding();

            assert.deepStrictEqual(tree(out.outputDir), [
                'a/b/c/three.txt', 'a/b/two.txt', 'a/one.txt', 'top.txt'
            ].sort());
            assert.strictEqual(out.converted, 4);
            assert.strictEqual(outputText(out, path.join('a', 'b', 'c', 'three.txt'), UTF8), 'さん');
        });

        test('names files by their path, not an ambiguous base name', async () => {
            write(path.join('a', 'same.txt'), encodeAs(UTF8, 'ふつう'));
            write(path.join('b', 'same.txt'), encodeAs(UTF8, '絵文字😀'));

            const out = await new Service(pair(UTF8, SJIS), {recursive: true}).convertEncoding();

            assert.deepStrictEqual(out.lossy, [path.join('b', 'same.txt')]);
            assert.strictEqual(out.converted, 2);
        });

        test('skips hidden directories and the configured names', async () => {
            write('keep.txt', encodeAs(SJIS, 'のこす'));
            write(path.join('.git', 'config'), encodeAs(SJIS, 'せってい'));
            write(path.join('node_modules', 'pkg', 'index.js'), encodeAs(SJIS, 'いぞん'));
            write(path.join('vendor', 'lib.txt'), encodeAs(SJIS, 'べんだ'));

            const out = await new Service(pair(SJIS, UTF8), {
                recursive: true,
                excludeDirectories: DEFAULT_EXCLUDE_DIRECTORIES.concat(['vendor'])
            }).convertEncoding();

            assert.deepStrictEqual(tree(out.outputDir), ['keep.txt']);
        });

        test('descends into a directory once it is off the exclude list', async () => {
            write(path.join('vendor', 'lib.txt'), encodeAs(SJIS, 'べんだ'));

            const out = await new Service(pair(SJIS, UTF8), {
                recursive: true, excludeDirectories: []
            }).convertEncoding();

            assert.deepStrictEqual(tree(out.outputDir), ['vendor/lib.txt']);
        });

        test('never descends into its own output directories', async () => {
            write('a.txt', encodeAs(SJIS, 'もと'));
            // Left over from an earlier run in the other direction.
            write(path.join('_Shift_JIS', 'old.txt'), encodeAs(SJIS, 'ふるい'));

            const out = await new Service(pair(SJIS, UTF8), {
                recursive: true, excludeDirectories: []
            }).convertEncoding();

            assert.deepStrictEqual(tree(out.outputDir), ['a.txt']);
            assert.ok(isOutputDirectoryName('_Shift_JIS'));
            assert.ok(!isOutputDirectoryName('_Whatever'));
        });

        test('does not follow a directory symlink that loops back', async () => {
            write(path.join('a', 'one.txt'), encodeAs(SJIS, 'いち'));
            // A link to an ancestor: following it would recurse until the depth cap.
            fs.symlinkSync(workspace, path.join(workspace, 'a', 'loop'), 'dir');

            const out = await new Service(pair(SJIS, UTF8), {recursive: true}).convertEncoding();

            assert.deepStrictEqual(tree(out.outputDir), ['a/one.txt']);
            assert.deepStrictEqual(out.failed, []);
        });

        test('still converts a file reached through a symlink', async () => {
            write('real.txt', encodeAs(SJIS, 'じつたい'));
            fs.symlinkSync(path.join(workspace, 'real.txt'), path.join(workspace, 'link.txt'));

            const out = await new Service(pair(SJIS, UTF8), {recursive: true}).convertEncoding();

            assert.deepStrictEqual(tree(out.outputDir).sort(), ['link.txt', 'real.txt']);
        });
    });

    suite('failure handling', () => {

        test('reports a failing file without aborting the rest of the run', async () => {
            write('good.txt', encodeAs(SJIS, 'だいじょうぶ'));
            write('bad.txt', encodeAs(SJIS, 'だめ'));

            class FlakyService extends Service {
                protected convertEncodingForOneFile(fpPair: FilePathPair): Promise<boolean> {
                    if (path.basename(fpPair.SrcFp) === 'bad.txt') {
                        return Promise.reject(new Error('EACCES: permission denied'));
                    }
                    return super.convertEncodingForOneFile(fpPair);
                }
            }

            const out = await new FlakyService(pair(SJIS, UTF8)).convertEncoding();

            assert.strictEqual(out.converted, 1);
            assert.deepStrictEqual(out.failed, [{file: 'bad.txt', reason: 'EACCES: permission denied'}]);
            assert.strictEqual(outputText(out, 'good.txt', UTF8), 'だいじょうぶ');
        });

        test('rejects when no workspace is open', async () => {
            setWorkspace(undefined);

            await assert.rejects(() => new Service(pair(SJIS, UTF8)).convertEncoding(), /Missing workspace/);
        });

        test('rejects rather than crashing when the source cannot be read', async () => {
            const service = new Service(pair(SJIS, UTF8));
            const fpPair = {
                SrcFp: path.join(workspace, 'does-not-exist.txt'),
                DistFp: path.join(workspace, 'out.txt')
            };

            // convertEncodingForOneFile is protected; reach it the way a subclass would.
            await assert.rejects(
                () => (service as unknown as {
                    convertEncodingForOneFile(p: FilePathPair): Promise<boolean>;
                }).convertEncodingForOneFile(fpPair),
                /ENOENT/
            );
        });
    });

    suite('concurrency', () => {

        test('never runs more than eight conversions at once', async () => {
            for (let i = 0; i < 40; i++) {
                write(`f${i}.txt`, encodeAs(SJIS, 'なかみ'));
            }

            class CountingService extends Service {
                public peak = 0;
                private inFlight = 0;

                protected async convertEncodingForOneFile(fpPair: FilePathPair): Promise<boolean> {
                    this.inFlight++;
                    this.peak = Math.max(this.peak, this.inFlight);
                    const lossy = await super.convertEncodingForOneFile(fpPair);
                    this.inFlight--;
                    return lossy;
                }
            }

            const service = new CountingService(pair(SJIS, UTF8));
            const out = await service.convertEncoding();

            assert.strictEqual(out.converted, 40);
            assert.ok(service.peak <= 8, `expected at most 8 in flight, saw ${service.peak}`);
            assert.ok(service.peak > 1, `expected some parallelism, saw ${service.peak}`);
        });
    });

    suite('large files', () => {

        test('handles content larger than one stream chunk', async () => {
            // Exercises the chunk-boundary handling in the encoding transform.
            const big = '日本語のテキストです。ABC\n'.repeat(20000);
            write('big.txt', encodeAs(UTF8, big));

            const out = await new Service(pair(UTF8, SJIS)).convertEncoding();

            assert.deepStrictEqual(out.failed, []);
            assert.deepStrictEqual(out.lossy, []);
            assert.strictEqual(outputText(out, 'big.txt', SJIS), big);
        });

        test('detects loss in a large file and keeps surrogate pairs intact', async () => {
            const big = 'あ'.repeat(50000) + '😀' + 'い'.repeat(50000);
            write('big.txt', encodeAs(UTF8, big));

            const toUtf16 = await new Service(pair(UTF8, UTF16LE)).convertEncoding();
            assert.deepStrictEqual(toUtf16.lossy, [], 'UTF-16 can represent every character');
            assert.strictEqual(outputText(toUtf16, 'big.txt', UTF16LE), big);

            setWorkspace(workspace);
            const toSjis = await new Service(pair(UTF8, SJIS)).convertEncoding();
            assert.deepStrictEqual(toSjis.lossy, ['big.txt']);
        });
    });
});

suite('EncodingTransform', () => {

    /** Feed the transform the given chunks and collect what it produces. */
    function run(target: EncodingSpec, chunks: string[]): Promise<{bytes: Buffer, lossy: boolean}> {
        return new Promise((resolve, reject) => {
            const transform = new EncodingTransform(target);
            const collected: Buffer[] = [];
            transform.on('data', (chunk: Buffer) => collected.push(chunk));
            transform.on('error', reject);
            transform.on('end', () => resolve({bytes: Buffer.concat(collected), lossy: transform.lossy}));
            chunks.forEach(chunk => transform.write(chunk));
            transform.end();
        });
    }

    test('keeps a surrogate pair together when the writer splits it', async () => {
        // '\uD83D\uDE00' is a single astral character stored as two code units.
        const whole = await run(UTF16LE, ['\uD83D\uDE00']);
        const split = await run(UTF16LE, ['\uD83D', '\uDE00']);

        assert.deepStrictEqual(split.bytes, whole.bytes, 'a split pair produced different bytes');
        assert.strictEqual(split.lossy, false);
    });

    test('writes the BOM once, not per chunk', async () => {
        const single = await run(UTF16LE, ['あいうえお']);
        const many = await run(UTF16LE, ['あい', 'うえ', 'お']);

        assert.deepStrictEqual(many.bytes, single.bytes);
        assert.deepStrictEqual(single.bytes.slice(0, 2), Buffer.from([0xFF, 0xFE]));
    });

    test('leaves an empty stream empty rather than writing a lone BOM', async () => {
        const empty = await run(UTF16LE, []);

        assert.strictEqual(empty.bytes.length, 0);
        assert.strictEqual(empty.lossy, false);
    });
});

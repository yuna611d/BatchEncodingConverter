'use strict';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as iconv from 'iconv-lite';
// Imported before the service so the `vscode` stub is registered first.
import { setWorkspace } from './vscodeStub';
import { Service, Encoding, FilePathPair, ConversionSummary } from '../../Services/Service';

const SJIS_TO_UTF8 = { srcEncoding: Encoding.Shift_JIS, distEncoding: Encoding.UTF8 };
const UTF8_TO_SJIS = { srcEncoding: Encoding.UTF8, distEncoding: Encoding.Shift_JIS };

suite('Service', () => {

    let workspace: string;
    const created: string[] = [];

    setup(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bec-'));
        created.push(workspace);
        setWorkspace(workspace);
    });

    suiteTeardown(() => {
        created.forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
    });

    function write(name: string, contents: Buffer | string): void {
        const target = path.join(workspace, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
    }

    function readOutput(summary: ConversionSummary, name: string, encoding: Encoding): string {
        return iconv.decode(fs.readFileSync(path.join(summary.outputDir, name)), encoding);
    }

    suite('Shift_JIS to UTF-8', () => {

        test('writes every converted file before it resolves', async () => {
            write('a.txt', iconv.encode('こんにちは世界\nHello\n', 'Shift_JIS'));
            write('b.txt', iconv.encode('あいうえお', 'Shift_JIS'));

            const summary = await new Service(SJIS_TO_UTF8).convertEncoding();

            // The whole point of awaiting: the files must be complete right now,
            // not at some later tick. Reading synchronously proves it.
            assert.strictEqual(readOutput(summary, 'a.txt', Encoding.UTF8), 'こんにちは世界\nHello\n');
            assert.strictEqual(readOutput(summary, 'b.txt', Encoding.UTF8), 'あいうえお');
            assert.strictEqual(summary.converted, 2);
            assert.deepStrictEqual(summary.skipped, []);
            assert.deepStrictEqual(summary.failed, []);
        });

        test('names the output directory after the target encoding', async () => {
            const summary = await new Service(SJIS_TO_UTF8).convertEncoding();

            assert.strictEqual(summary.outputDir, path.join(workspace, '_UTF-8'));
            assert.ok(fs.statSync(summary.outputDir).isDirectory());
        });

        test('skips binary files instead of throwing', async () => {
            write('text.txt', iconv.encode('ただのテキスト', 'Shift_JIS'));
            write('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));

            const summary = await new Service(SJIS_TO_UTF8).convertEncoding();

            assert.deepStrictEqual(summary.skipped, ['image.png']);
            assert.strictEqual(summary.converted, 1);
            assert.strictEqual(fs.existsSync(path.join(summary.outputDir, 'image.png')), false);
        });

        test('treats a file shorter than the sniff length as text', async () => {
            write('tiny.txt', iconv.encode('あ', 'Shift_JIS'));
            write('empty.txt', Buffer.alloc(0));

            const summary = await new Service(SJIS_TO_UTF8).convertEncoding();

            assert.deepStrictEqual(summary.skipped, []);
            assert.strictEqual(summary.converted, 2);
            assert.strictEqual(readOutput(summary, 'tiny.txt', Encoding.UTF8), 'あ');
            assert.strictEqual(readOutput(summary, 'empty.txt', Encoding.UTF8), '');
        });

        test('ignores sub directories and the output directory itself', async () => {
            write('top.txt', iconv.encode('うえ', 'Shift_JIS'));
            write(path.join('nested', 'inner.txt'), iconv.encode('した', 'Shift_JIS'));

            const summary = await new Service(SJIS_TO_UTF8).convertEncoding();

            assert.strictEqual(summary.converted, 1);
            assert.deepStrictEqual(fs.readdirSync(summary.outputDir), ['top.txt']);
        });

        test('overwrites a stale file left in the output directory', async () => {
            write('a.txt', iconv.encode('あたらしい', 'Shift_JIS'));
            write(path.join('_UTF-8', 'a.txt'), 'ふるい');

            const summary = await new Service(SJIS_TO_UTF8).convertEncoding();

            assert.strictEqual(readOutput(summary, 'a.txt', Encoding.UTF8), 'あたらしい');
        });
    });

    suite('UTF-8 to Shift_JIS', () => {

        test('round trips Japanese text', async () => {
            write('u.txt', Buffer.from('日本語テキスト', 'utf8'));

            const summary = await new Service(UTF8_TO_SJIS).convertEncoding();

            assert.strictEqual(summary.outputDir, path.join(workspace, '_Shift_JIS'));
            const raw = fs.readFileSync(path.join(summary.outputDir, 'u.txt'));
            // 日=93FA 本=967B 語=8CEA テ=8365 キ=834C ス=8358 ト=8367
            assert.strictEqual(raw.toString('hex'), '93fa967b8cea8365834c83588367');
            assert.strictEqual(iconv.decode(raw, 'Shift_JIS'), '日本語テキスト');
        });
    });

    suite('failure handling', () => {

        test('reports a failing file without aborting the rest of the run', async () => {
            write('good.txt', iconv.encode('だいじょうぶ', 'Shift_JIS'));
            write('bad.txt', iconv.encode('だめ', 'Shift_JIS'));

            class FlakyService extends Service {
                protected convertEncodingForOneFile(fpPair: FilePathPair): Promise<void> {
                    if (path.basename(fpPair.SrcFp) === 'bad.txt') {
                        return Promise.reject(new Error('EACCES: permission denied'));
                    }
                    return super.convertEncodingForOneFile(fpPair);
                }
            }

            const summary = await new FlakyService(SJIS_TO_UTF8).convertEncoding();

            assert.strictEqual(summary.converted, 1);
            assert.deepStrictEqual(summary.failed, [
                { file: 'bad.txt', reason: 'EACCES: permission denied' }
            ]);
            assert.strictEqual(readOutput(summary, 'good.txt', Encoding.UTF8), 'だいじょうぶ');
        });

        test('rejects when no workspace is open', async () => {
            setWorkspace(undefined);

            await assert.rejects(
                () => new Service(SJIS_TO_UTF8).convertEncoding(),
                /Missing workspace/
            );
        });

        test('rejects rather than crashing when the source cannot be read', async () => {
            const service = new Service(SJIS_TO_UTF8);
            const pair = {
                SrcFp: path.join(workspace, 'does-not-exist.txt'),
                DistFp: path.join(workspace, 'out.txt')
            };

            // convertEncodingForOneFile is protected; reach it the way a subclass would.
            await assert.rejects(
                () => (service as unknown as {
                    convertEncodingForOneFile(p: FilePathPair): Promise<void>;
                }).convertEncodingForOneFile(pair),
                /ENOENT/
            );
        });
    });

    suite('concurrency', () => {

        test('never runs more than eight conversions at once', async () => {
            for (let i = 0; i < 40; i++) {
                write(`f${i}.txt`, iconv.encode('なかみ', 'Shift_JIS'));
            }

            class CountingService extends Service {
                public peak = 0;
                private inFlight = 0;

                protected async convertEncodingForOneFile(fpPair: FilePathPair): Promise<void> {
                    this.inFlight++;
                    this.peak = Math.max(this.peak, this.inFlight);
                    await super.convertEncodingForOneFile(fpPair);
                    this.inFlight--;
                }
            }

            const service = new CountingService(SJIS_TO_UTF8);
            const summary = await service.convertEncoding();

            assert.strictEqual(summary.converted, 40);
            assert.ok(service.peak <= 8, `expected at most 8 in flight, saw ${service.peak}`);
            assert.ok(service.peak > 1, `expected some parallelism, saw ${service.peak}`);
        });
    });
});

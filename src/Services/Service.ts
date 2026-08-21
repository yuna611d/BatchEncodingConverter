'use strict';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';
import { Transform } from 'stream';

/**
 * A conversion endpoint. `iconvName` alone cannot express everything we need:
 * "UTF-8" and "UTF-8 with BOM" share a codec but differ on output, so the BOM
 * decision travels with the spec rather than being encoded in the name.
 */
export interface EncodingSpec {
    /** Stable identifier, also used as the output directory suffix. */
    id: string;
    /** Shown to the user when picking encodings. */
    label: string;
    /** Name handed to iconv-lite. */
    iconvName: string;
    /** Whether a BOM is written when this spec is the conversion target. */
    addBOM: boolean;
}

/**
 * Conversion endpoints offered to the user.
 *
 * UTF-16 targets always get a BOM: without one the byte order of a UTF-16 file
 * is not recoverable. As a source, `UTF-8-BOM` behaves exactly like `UTF-8`
 * because iconv-lite strips a BOM while decoding either way; it is listed on
 * both sides so the two menus stay symmetric.
 */
export const ENCODINGS: EncodingSpec[] = [
    {id: 'Shift_JIS', label: 'Shift_JIS',            iconvName: 'Shift_JIS', addBOM: false},
    {id: 'EUC-JP',    label: 'EUC-JP',               iconvName: 'EUC-JP',    addBOM: false},
    {id: 'UTF-8',     label: 'UTF-8',                iconvName: 'UTF-8',     addBOM: false},
    {id: 'UTF-8-BOM', label: 'UTF-8 with BOM',       iconvName: 'UTF-8',     addBOM: true},
    {id: 'UTF-16LE',  label: 'UTF-16 LE (with BOM)', iconvName: 'UTF-16LE',  addBOM: true},
    {id: 'UTF-16BE',  label: 'UTF-16 BE (with BOM)', iconvName: 'UTF-16BE',  addBOM: true},
];

/** Look an encoding up by its stable id. */
export function findEncoding(id: string): EncodingSpec | undefined {
    return ENCODINGS.filter(spec => spec.id === id)[0];
}

/**
 * Encodings that may be converted *into*, given the chosen source. Converting a
 * file to the encoding it is already in would only copy it, so the source is
 * excluded.
 */
export function targetsFor(source: EncodingSpec): EncodingSpec[] {
    return ENCODINGS.filter(spec => spec.id !== source.id);
}

export interface EncodingPair {
    srcEncoding: EncodingSpec;
    distEncoding: EncodingSpec;
}

export interface FilePathPair {
    SrcFp: string;
    DistFp: string;
}

/** What actually happened during a run, so the caller can report it truthfully. */
export interface ConversionSummary {
    outputDir: string;
    converted: number;
    skipped: string[];
    /** Files that were written but lost characters the target encoding cannot represent. */
    lossy: string[];
    failed: Array<{file: string, reason: string}>;
}

/**
 * Encodes decoded text and notices when the target encoding cannot represent it.
 *
 * iconv-lite substitutes an unmappable character with `?` and reports nothing,
 * so the only way to detect the loss is to decode the bytes again and compare.
 * Encoding here rather than using `iconv.encodeStream` keeps that to one pass.
 */
export class EncodingTransform extends Transform {

    /** Set once the target encoding has silently dropped something. */
    public lossy = false;

    private readonly spec: EncodingSpec;
    private atStart = true;
    /** A high surrogate held back so a pair is never split across chunks. */
    private pendingSurrogate = '';

    constructor(spec: EncodingSpec) {
        // decodeStrings would turn the decoder's strings back into Buffers.
        super({decodeStrings: false});
        this.spec = spec;
    }

    public _transform(chunk: string | Buffer, _encoding: string, callback: (error?: Error | null, data?: Buffer) => void) {
        let text = this.pendingSurrogate + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        this.pendingSurrogate = '';

        const lastCode = text.charCodeAt(text.length - 1);
        if (text.length > 0 && lastCode >= 0xD800 && lastCode <= 0xDBFF) {
            this.pendingSurrogate = text.slice(-1);
            text = text.slice(0, -1);
        }

        if (text.length === 0) {
            callback();
            return;
        }
        callback(null, this.encodeAndCheck(text));
    }

    public _flush(callback: (error?: Error | null, data?: Buffer) => void) {
        if (this.pendingSurrogate.length === 0) {
            callback();
            return;
        }
        const trailing = this.pendingSurrogate;
        this.pendingSurrogate = '';
        callback(null, this.encodeAndCheck(trailing));
    }

    private encodeAndCheck(text: string): Buffer {
        // A BOM belongs to the start of the file, so only the first chunk asks for one.
        const options = this.atStart ? {addBOM: this.spec.addBOM} : {};
        this.atStart = false;

        const bytes = iconv.encode(text, this.spec.iconvName, options);
        // decode() strips the BOM, so its presence never looks like a difference.
        if (!this.lossy && iconv.decode(bytes, this.spec.iconvName) !== text) {
            this.lossy = true;
        }
        return bytes;
    }
}

export class Service {

    /** Number of leading bytes inspected when guessing whether a file is binary. */
    private static readonly SNIFF_LENGTH = 512;

    /** Upper bound on files converted in parallel, so large workspaces cannot exhaust file descriptors. */
    private static readonly MAX_CONCURRENCY = 8;

    /** Control characters that legitimately occur in text: TAB, LF, FF, CR. */
    private static readonly ALLOWED_CONTROLS = [0x09, 0x0A, 0x0C, 0x0D];

    /** Share of undecodable or control characters above which a file is treated as binary. */
    private static readonly BINARY_RATIO = 0.1;

    /** Characters dropped from the end of a sniff, where a truncated sequence would decode as garbage. */
    private static readonly TRUNCATION_GUARD = 2;

    protected encodingPair: EncodingPair;

    constructor(encodingPair: EncodingPair) {
        this.encodingPair = encodingPair;
    }

    /**
     * Convert every file directly under the workspace root and write the results
     * into a `_<distEncoding.id>` directory next to them. Resolves once every file
     * has been written; a failure on one file does not abort the others.
     */
    public async convertEncoding(): Promise<ConversionSummary> {

        // Determine Base and output Directory
        const baseDir = this.getBaseDir();
        const outputDir = path.join(baseDir, "_" + this.encodingPair.distEncoding.id);
        // Create OutputDir
        this.createOutputDir(outputDir);

        const fpPairs = await this.collectTargets(baseDir, outputDir);

        const summary: ConversionSummary = {outputDir: outputDir, converted: 0, skipped: [], lossy: [], failed: []};
        await this.forEachLimited(fpPairs, Service.MAX_CONCURRENCY, async fpPair => {
            const name = path.basename(fpPair.SrcFp);
            try {
                if (await this.seemsBinary(fpPair.SrcFp)) {
                    summary.skipped.push(name);
                    return;
                }
                const lostCharacters = await this.convertEncodingForOneFile(fpPair);
                summary.converted++;
                if (lostCharacters) {
                    summary.lossy.push(name);
                }
            } catch (e) {
                summary.failed.push({file: name, reason: e instanceof Error ? e.message : String(e)});
            }
        });

        return summary;
    }

    /** Seek files directly under baseDir and pair them with their destination path. */
    protected async collectTargets(baseDir: string, outputDir: string): Promise<FilePathPair[]> {
        const entries = await this.readDir(baseDir);
        const fpPairs: FilePathPair[] = [];
        for (const entry of entries) {
            const srcFp = path.join(baseDir, entry);
            if (srcFp === outputDir) {
                continue;
            }
            // Entries we cannot stat (dangling symlinks, races) are simply not convertible.
            const stats = await this.tryStat(srcFp);
            if (stats === undefined || !stats.isFile()) {
                continue;
            }
            fpPairs.push({SrcFp: srcFp, DistFp: path.join(outputDir, entry)});
        }
        return fpPairs;
    }

    /**
     * Read file -> convert encoding -> write file. Rejects if any stage fails.
     * Resolves true when the target encoding could not represent every character.
     */
    protected convertEncodingForOneFile(fpPair: FilePathPair): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            const source = fs.createReadStream(fpPair.SrcFp);
            const decoder = iconv.decodeStream(this.encodingPair.srcEncoding.iconvName);
            const encoder = new EncodingTransform(this.encodingPair.distEncoding);
            const destination = fs.createWriteStream(fpPair.DistFp);

            // pipe() does not forward errors, so every stage needs its own handler.
            const fail = (error: Error) => {
                source.destroy();
                destination.destroy();
                reject(error);
            };
            const stages: NodeJS.EventEmitter[] = [source, decoder, encoder, destination];
            stages.forEach(stage => stage.on('error', fail));
            destination.on('close', () => resolve(encoder.lossy));

            source.pipe(decoder).pipe(encoder).pipe(destination);
        });
    }

    protected getBaseDir(): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            throw new Error("Missing workspace");
        }
        return workspaceFolders[0].uri.fsPath;
    }

    private createOutputDir(outputDir: string) {
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
    }

    /**
     * Guess whether a file is binary by decoding its leading bytes with the source
     * encoding and looking at the text that comes out. Inspecting raw bytes cannot
     * work here: UTF-16 text is full of NUL bytes and would always look binary.
     */
    private async seemsBinary(filePath: string): Promise<boolean> {
        const head = await this.readHead(filePath, Service.SNIFF_LENGTH);
        const decoded = iconv.decode(head, this.encodingPair.srcEncoding.iconvName);
        return Service.decodesAsBinary(decoded);
    }

    private static decodesAsBinary(decoded: string): boolean {
        // The sniff cuts mid-character, which decodes as garbage through no fault of the file.
        const text = decoded.slice(0, Math.max(0, decoded.length - Service.TRUNCATION_GUARD));
        if (text.length === 0) {
            return false;
        }

        let suspicious = 0;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            // Real text never contains a NUL character once decoded, whatever the encoding.
            if (code === 0) {
                return true;
            }
            const isControl = (code < 0x20 && Service.ALLOWED_CONTROLS.indexOf(code) === -1) || code === 0x7F;
            if (isControl || code === 0xFFFD) {
                suspicious++;
            }
        }
        return suspicious / text.length > Service.BINARY_RATIO;
    }

    private readHead(filePath: string, length: number): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            const buffer = Buffer.alloc(length);
            fs.open(filePath, 'r', (openError, fd) => {
                if (openError) {
                    reject(openError);
                    return;
                }
                fs.read(fd, buffer, 0, length, 0, (readError, bytesRead) => {
                    fs.close(fd, () => {
                        if (readError) {
                            reject(readError);
                            return;
                        }
                        resolve(buffer.slice(0, bytesRead));
                    });
                });
            });
        });
    }

    private readDir(dir: string): Promise<string[]> {
        return new Promise<string[]>((resolve, reject) => {
            fs.readdir(dir, (error, entries) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(entries);
            });
        });
    }

    private tryStat(fp: string): Promise<fs.Stats | undefined> {
        return new Promise<fs.Stats | undefined>(resolve => {
            fs.stat(fp, (error, stats) => {
                resolve(error ? undefined : stats);
            });
        });
    }

    /** Run worker over every item, with at most `limit` in flight at a time. */
    private async forEachLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
        let cursor = 0;
        const runners: Array<Promise<void>> = [];
        for (let i = 0; i < Math.min(limit, items.length); i++) {
            runners.push((async () => {
                while (cursor < items.length) {
                    await worker(items[cursor++]);
                }
            })());
        }
        await Promise.all(runners);
    }

}

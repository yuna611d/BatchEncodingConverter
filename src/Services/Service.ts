'use strict';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';
import * as japanese from 'encoding-japanese';
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
    /** Name handed to iconv-lite. Only consulted when `codec` is 'iconv'. */
    iconvName: string;
    /** Whether a BOM is written when this spec is the conversion target. */
    addBOM: boolean;
    /**
     * Which library converts this encoding. iconv-lite has never implemented
     * ISO-2022-JP — it is stateful, and even the current 0.7 release reports
     * `encodingExists('ISO-2022-JP') === false` — so that one goes through
     * encoding-japanese instead.
     */
    codec: 'iconv' | 'iso-2022-jp';
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
    {id: 'Shift_JIS',   label: 'Shift_JIS',            iconvName: 'Shift_JIS', addBOM: false, codec: 'iconv'},
    {id: 'EUC-JP',      label: 'EUC-JP',               iconvName: 'EUC-JP',    addBOM: false, codec: 'iconv'},
    {id: 'ISO-2022-JP', label: 'ISO-2022-JP (JIS)',    iconvName: 'ISO-2022-JP', addBOM: false, codec: 'iso-2022-jp'},
    {id: 'UTF-8',       label: 'UTF-8',                iconvName: 'UTF-8',     addBOM: false, codec: 'iconv'},
    {id: 'UTF-8-BOM',   label: 'UTF-8 with BOM',       iconvName: 'UTF-8',     addBOM: true,  codec: 'iconv'},
    {id: 'UTF-16LE',    label: 'UTF-16 LE (with BOM)', iconvName: 'UTF-16LE',  addBOM: true,  codec: 'iconv'},
    {id: 'UTF-16BE',    label: 'UTF-16 BE (with BOM)', iconvName: 'UTF-16BE',  addBOM: true,  codec: 'iconv'},
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

/** How a run walks the workspace. */
export interface ConversionOptions {
    /** Descend into sub directories, mirroring the tree under the output directory. */
    recursive: boolean;
    /** Directory names skipped while descending. */
    excludeDirectories: string[];
}

/**
 * Directories skipped unless the user says otherwise. Recursing into a checkout
 * without these turns a handful of source files into thousands of dependency and
 * repository-internal ones.
 */
export const DEFAULT_EXCLUDE_DIRECTORIES: string[] = ['node_modules'];

export const DEFAULT_OPTIONS: ConversionOptions = {
    recursive: false,
    excludeDirectories: DEFAULT_EXCLUDE_DIRECTORIES
};

/** True for the `_<encoding>` directories this extension writes its own output to. */
export function isOutputDirectoryName(name: string): boolean {
    return ENCODINGS.some(spec => '_' + spec.id === name);
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

const ESCAPE = 0x1B;
/** The `$` that marks an escape sequence as selecting a two-byte character set. */
const MULTI_BYTE_INTRODUCER = 0x24;
/** The `(` that, after `$`, makes the escape sequence four bytes rather than three. */
const EXTENDED_INTRODUCER = 0x28;

/** Encode text as `spec` stores it. */
export function encodeText(spec: EncodingSpec, text: string): Buffer {
    if (spec.codec === 'iso-2022-jp') {
        return Buffer.from(japanese.convert(japanese.stringToCode(text), {to: 'JIS', from: 'UNICODE'}));
    }
    return iconv.encode(text, spec.iconvName, {addBOM: spec.addBOM});
}

/** Encode a continuation chunk, which must never repeat a BOM. */
export function encodeContinuation(spec: EncodingSpec, text: string): Buffer {
    if (spec.codec === 'iso-2022-jp') {
        return encodeText(spec, text);
    }
    return iconv.encode(text, spec.iconvName, {});
}

/** Decode bytes stored as `spec`. */
export function decodeBytes(spec: EncodingSpec, bytes: Buffer): string {
    if (spec.codec === 'iso-2022-jp') {
        return japanese.codeToString(japanese.convert(bytes, {to: 'UNICODE', from: 'JIS'}));
    }
    return iconv.decode(bytes, spec.iconvName);
}

/** Length of the escape sequence starting at `at`, whether or not it is all present. */
function escapeLength(buffer: Buffer, at: number): number {
    return buffer[at + 1] === MULTI_BYTE_INTRODUCER && buffer[at + 2] === EXTENDED_INTRODUCER ? 4 : 3;
}

function selectsMultiByte(escape: Buffer): boolean {
    return escape.length > 1 && escape[1] === MULTI_BYTE_INTRODUCER;
}

/**
 * How much of `buffer` ends on a character boundary, and which escape sequence is
 * in effect there. ISO-2022-JP is stateful, so a chunk cannot simply be decoded on
 * its own: cutting inside a two-byte character or an escape sequence corrupts it,
 * and a chunk that starts mid-character set has lost the escape that said so.
 */
export function splitIso2022Jp(buffer: Buffer, escape: Buffer): {end: number, escape: Buffer} {
    let at = 0;
    let current = escape;
    let multiByte = selectsMultiByte(current);
    while (at < buffer.length) {
        if (buffer[at] === ESCAPE) {
            const length = escapeLength(buffer, at);
            if (at + length > buffer.length) {
                break;
            }
            current = buffer.slice(at, at + length);
            multiByte = selectsMultiByte(current);
            at += length;
            continue;
        }
        const width = multiByte ? 2 : 1;
        if (at + width > buffer.length) {
            break;
        }
        at += width;
    }
    return {end: at, escape: current};
}

/**
 * Decodes an ISO-2022-JP byte stream into text, holding back any trailing bytes
 * that do not yet form a whole character and re-stating the character set at the
 * start of every slice it hands to the decoder.
 */
export class Iso2022JpDecodeStream extends Transform {

    private pending: Buffer = Buffer.alloc(0);
    /** Escape sequence in effect at the start of `pending`; empty means ASCII. */
    private escape: Buffer = Buffer.alloc(0);

    constructor() {
        // Mirrors iconv-lite's decode streams, whose readable side yields strings.
        super({encoding: 'utf8'});
    }

    public _transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
        this.pending = Buffer.concat([this.pending, chunk]);
        const boundary = splitIso2022Jp(this.pending, this.escape);
        if (boundary.end === 0) {
            callback();
            return;
        }
        const complete = Buffer.concat([this.escape, this.pending.slice(0, boundary.end)]);
        this.pending = this.pending.slice(boundary.end);
        this.escape = boundary.escape;
        this.push(japanese.codeToString(japanese.convert(complete, {to: 'UNICODE', from: 'JIS'})), 'utf8');
        callback();
    }

    public _flush(callback: (error?: Error | null) => void) {
        if (this.pending.length === 0) {
            callback();
            return;
        }
        // Whatever is left is truncated; decode it anyway rather than dropping it.
        const rest = Buffer.concat([this.escape, this.pending]);
        this.pending = Buffer.alloc(0);
        this.push(japanese.codeToString(japanese.convert(rest, {to: 'UNICODE', from: 'JIS'})), 'utf8');
        callback();
    }
}

/** A stream that turns bytes stored as `spec` into text. */
export function decodeStreamFor(spec: EncodingSpec): NodeJS.ReadWriteStream {
    if (spec.codec === 'iso-2022-jp') {
        return new Iso2022JpDecodeStream() as unknown as NodeJS.ReadWriteStream;
    }
    return iconv.decodeStream(spec.iconvName);
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
        const bytes = this.atStart ? encodeText(this.spec, text) : encodeContinuation(this.spec, text);
        this.atStart = false;

        // Decoding strips the BOM, so its presence never looks like a difference.
        // ISO-2022-JP survives this too: every chunk is encoded starting and ending
        // in ASCII, so the pieces concatenate into a valid stream.
        if (!this.lossy && decodeBytes(this.spec, bytes) !== text) {
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

    /** Safety net against pathological trees; real projects nest nowhere near this deep. */
    private static readonly MAX_DEPTH = 32;

    protected encodingPair: EncodingPair;
    protected options: ConversionOptions;

    constructor(encodingPair: EncodingPair, options?: Partial<ConversionOptions>) {
        this.encodingPair = encodingPair;
        this.options = {
            recursive: options && options.recursive !== undefined ? options.recursive : DEFAULT_OPTIONS.recursive,
            excludeDirectories: options && options.excludeDirectories !== undefined
                ? options.excludeDirectories
                : DEFAULT_OPTIONS.excludeDirectories
        };
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
        // Mirrored sub directories must exist before any worker opens a write stream;
        // doing it up front once also keeps concurrent workers from racing each other.
        fpPairs.forEach(fpPair => this.ensureDirectory(path.dirname(fpPair.DistFp)));

        const summary: ConversionSummary = {outputDir: outputDir, converted: 0, skipped: [], lossy: [], failed: []};
        await this.forEachLimited(fpPairs, Service.MAX_CONCURRENCY, async fpPair => {
            // Relative, not just the file name: sub directories make base names ambiguous.
            const name = path.relative(baseDir, fpPair.SrcFp);
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

    /**
     * Seek files to convert and pair them with their destination path. With
     * `recursive` the workspace tree is mirrored under the output directory.
     */
    protected async collectTargets(baseDir: string, outputDir: string): Promise<FilePathPair[]> {
        const fpPairs: FilePathPair[] = [];
        await this.collectFrom(baseDir, baseDir, outputDir, fpPairs, 0);
        return fpPairs;
    }

    private async collectFrom(dir: string, baseDir: string, outputDir: string, found: FilePathPair[], depth: number): Promise<void> {
        if (depth > Service.MAX_DEPTH) {
            return;
        }
        const entries = await this.readDir(dir);
        for (const entry of entries) {
            const srcFp = path.join(dir, entry);
            if (srcFp === outputDir) {
                continue;
            }
            // Entries we cannot stat (dangling symlinks, races) are simply not convertible.
            const kind = await this.describeEntry(srcFp);
            if (kind === undefined) {
                continue;
            }
            if (kind.isDirectory) {
                if (this.options.recursive && !this.skipsDirectory(entry, kind.isSymlink)) {
                    await this.collectFrom(srcFp, baseDir, outputDir, found, depth + 1);
                }
                continue;
            }
            if (!kind.isFile) {
                continue;
            }
            found.push({SrcFp: srcFp, DistFp: path.join(outputDir, path.relative(baseDir, srcFp))});
        }
    }

    /**
     * Directories left alone while descending: the extension's own output, anything
     * hidden, the configured names, and symlinks — following those can loop forever.
     */
    private skipsDirectory(name: string, isSymlink: boolean): boolean {
        return isSymlink
            || name.charAt(0) === '.'
            || isOutputDirectoryName(name)
            || this.options.excludeDirectories.indexOf(name) > -1;
    }

    /** Classify an entry, resolving symlinks but remembering that it was one. */
    private async describeEntry(fp: string): Promise<{isDirectory: boolean, isFile: boolean, isSymlink: boolean} | undefined> {
        const link = await this.tryLstat(fp);
        if (link === undefined) {
            return undefined;
        }
        if (!link.isSymbolicLink()) {
            return {isDirectory: link.isDirectory(), isFile: link.isFile(), isSymlink: false};
        }
        const target = await this.tryStat(fp);
        if (target === undefined) {
            return undefined;
        }
        return {isDirectory: target.isDirectory(), isFile: target.isFile(), isSymlink: true};
    }

    /**
     * Read file -> convert encoding -> write file. Rejects if any stage fails.
     * Resolves true when the target encoding could not represent every character.
     */
    protected convertEncodingForOneFile(fpPair: FilePathPair): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            const source = fs.createReadStream(fpPair.SrcFp);
            const decoder = decodeStreamFor(this.encodingPair.srcEncoding);
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
        this.ensureDirectory(outputDir);
    }

    /**
     * Create a directory and any missing parents. Hand-rolled because
     * `fs.mkdirSync`'s `recursive` option only arrived in Node 10.12, later than
     * the Node the oldest supported VS Code ships.
     */
    private ensureDirectory(dir: string) {
        if (fs.existsSync(dir)) {
            return;
        }
        const parent = path.dirname(dir);
        if (parent !== dir) {
            this.ensureDirectory(parent);
        }
        fs.mkdirSync(dir);
    }

    /**
     * Guess whether a file is binary by decoding its leading bytes with the source
     * encoding and looking at the text that comes out. Inspecting raw bytes cannot
     * work here: UTF-16 text is full of NUL bytes and would always look binary.
     */
    private async seemsBinary(filePath: string): Promise<boolean> {
        const head = await this.readHead(filePath, Service.SNIFF_LENGTH);
        const decoded = decodeBytes(this.encodingPair.srcEncoding, head);
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

    private tryLstat(fp: string): Promise<fs.Stats | undefined> {
        return new Promise<fs.Stats | undefined>(resolve => {
            fs.lstat(fp, (error, stats) => {
                resolve(error ? undefined : stats);
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

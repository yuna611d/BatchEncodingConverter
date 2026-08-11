'use strict';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';

export enum Encoding {
    "Shift_JIS"= "Shift_JIS",
    "UTF8"= "UTF-8",
}

export interface EncodingPair {
    srcEncoding: Encoding;
    distEncoding: Encoding;
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
    failed: Array<{file: string, reason: string}>;
}

export class Service {

    /** Number of leading bytes inspected when guessing whether a file is binary. */
    private static readonly SNIFF_LENGTH = 512;

    /** Upper bound on files converted in parallel, so large workspaces cannot exhaust file descriptors. */
    private static readonly MAX_CONCURRENCY = 8;

    /** Control characters that virtually never occur in text. TAB/LF/VT/FF/CR are deliberately absent. */
    private static readonly BINARY_MARKERS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

    protected encodingPair: EncodingPair;

    constructor(encodingPair: EncodingPair) {
        this.encodingPair = encodingPair;
    }

    /**
     * Convert every file directly under the workspace root and write the results
     * into a `_<distEncoding>` directory next to them. Resolves once every file
     * has been written; a failure on one file does not abort the others.
     */
    public async convertEncoding(): Promise<ConversionSummary> {

        // Determine Base and output Directory
        const baseDir = this.getBaseDir();
        const outputDir = path.join(baseDir, "_" + this.encodingPair.distEncoding);
        // Create OutputDir
        this.createOutputDir(outputDir);

        const fpPairs = await this.collectTargets(baseDir, outputDir);

        const summary: ConversionSummary = {outputDir: outputDir, converted: 0, skipped: [], failed: []};
        await this.forEachLimited(fpPairs, Service.MAX_CONCURRENCY, async fpPair => {
            const name = path.basename(fpPair.SrcFp);
            try {
                if (await this.seemsBinary(fpPair.SrcFp)) {
                    summary.skipped.push(name);
                    return;
                }
                await this.convertEncodingForOneFile(fpPair);
                summary.converted++;
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

    /** Read file -> convert encoding -> write file. Rejects if any stage fails. */
    protected convertEncodingForOneFile(fpPair: FilePathPair): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const source = fs.createReadStream(fpPair.SrcFp);
            const decoder = iconv.decodeStream(this.encodingPair.srcEncoding);
            const encoder = iconv.encodeStream(this.encodingPair.distEncoding);
            const destination = fs.createWriteStream(fpPair.DistFp);

            // pipe() does not forward errors, so every stage needs its own handler.
            const fail = (error: Error) => {
                source.destroy();
                destination.destroy();
                reject(error);
            };
            const stages: NodeJS.EventEmitter[] = [source, decoder, encoder, destination];
            stages.forEach(stage => stage.on('error', fail));
            destination.on('close', () => resolve());

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

    /** Check binary or not, by sniffing the leading bytes of the file. */
    private seemsBinary(filePath: string): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            const buffer = Buffer.alloc(Service.SNIFF_LENGTH);
            fs.open(filePath, 'r', (openError, fd) => {
                if (openError) {
                    reject(openError);
                    return;
                }
                fs.read(fd, buffer, 0, Service.SNIFF_LENGTH, 0, (readError, bytesRead) => {
                    fs.close(fd, () => {
                        if (readError) {
                            reject(readError);
                            return;
                        }
                        resolve(Service.containsBinaryMarker(buffer, bytesRead));
                    });
                });
            });
        });
    }

    private static containsBinaryMarker(buffer: Buffer, length: number): boolean {
        for (let i = 0; i < length; i++) {
            if (Service.BINARY_MARKERS.indexOf(buffer[i]) > -1) {
                return true;
            }
        }
        return false;
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

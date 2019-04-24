'use strict';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';

export class Service {

    protected encodingPair: {srcEncoding: Encoding, distEncoding: Encoding};

    constructor(encodingPair: {srcEncoding: Encoding, distEncoding: Encoding}) {
        this.encodingPair = encodingPair;
    }

    public async convertEncoding(fpPair ? : {SrcFp: string, DistFp: string}) {
        if (fpPair) {
            await this.convertEncodingForOneFile(fpPair);
        } else {
            this.convertEncodingForAllFiles();
        }
    }

    protected async convertEncodingForAllFiles() {

        // Determine Base and output Directory
        const baseDir = this.getBaseDir();
        const outputDir = path.join(baseDir, "_" + this.encodingPair.distEncoding);
        // Create OutputDir
        this.createOutputDir(outputDir);

        // Seek files
        const files = fs.readdirSync(baseDir);
        // Get filePath -> filter files -> convert encoding            
        const fpPairs = files.map(file => {
            return {
                SrcFp: path.join(baseDir, file),
                DistFp: path.join(outputDir, file)
            };
        })
        .filter(fpPair => {
            return fs.statSync(fpPair.SrcFp).isFile();
        });
        
        await Promise.all(fpPairs.map(async fpPair => {
            return await this.convertEncoding(fpPair);
        }));
    }

    protected async convertEncodingForOneFile(fpPair: {SrcFp: string, DistFp: string}) {

        // Check binary or not
        await fs.createReadStream(fpPair.SrcFp, {end: 512})
        .on('data', data => {
            if (this.seemsBinary(data)) {
                throw new Error(`${fpPair.SrcFp} seems binary`);
            }
        })
        .on('close', async() => {
            // Read file -> convert encoding -> write file
            await fs.createReadStream(fpPair.SrcFp)
                .pipe(iconv.decodeStream(this.encodingPair.srcEncoding))
                .pipe(iconv.encodeStream(this.encodingPair.distEncoding))
                .pipe(fs.createWriteStream(fpPair.DistFp));
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

    private seemsBinary(buffer: Buffer): boolean {
        const controls = [0,1,2,3,4,5,6,7,8];
        for (let i = 0; i < 512; i++) {
            const c = buffer[i];
            if (controls.indexOf(c) > -1) {
                return true;
            }
        }
        return false;
    }

}

export enum Encoding {
    "Shift_JIS"= "Shift_JIS",
    "UTF8"= "UTF-8",
}

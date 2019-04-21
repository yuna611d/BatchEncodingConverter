'use strict';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';

export class Service {

    protected encodingPair: {
        srcEncoding: Encoding,
        distEncoding: Encoding
    };

    constructor(encodingPair: {
        srcEncoding: Encoding,
        distEncoding: Encoding
    }) {
        this.encodingPair = encodingPair;
    }

    public convertEncoding(fpPair ? : {
        SrcFp: string,
        DistFp: string
    }) {
        if (fpPair) {
            this.convertEncodingForOneFile(fpPair);
        }
        this.convertEncodingForAllFiles();
    }

    protected convertEncodingForAllFiles() {

        // Determine Base and output Directory
        const baseDir = this.getBaseDir();
        const outputDir = path.join(baseDir, "_" + this.encodingPair.distEncoding);
        // Create OutputDir
        this.createOutputDir(outputDir);

        // Seek files
        fs.readdir(baseDir, (err, files) => {
            if (err) {
                return;
            }

            // Get filePath -> filter files -> convert encoding            
            files.map(file => {
                    return {
                        SrcFp: path.join(baseDir, file),
                        DistFp: path.join(outputDir, file)
                    };
                })
                .filter(fpPair => {
                    return fs.statSync(fpPair.SrcFp).isFile();
                })
                .map(fpPair => {
                    return this.convertEncoding(fpPair);
                });
        });


    }

    protected convertEncodingForOneFile(fpPair: {
        SrcFp: string,
        DistFp: string
    }): void {

        console.log(`src: ${fpPair.SrcFp}, dist: ${fpPair.DistFp},
                     srcEnc: ${this.encodingPair.srcEncoding}, distEnc: ${this.encodingPair.distEncoding}`);

        fs.createReadStream(fpPair.SrcFp)
            .pipe(iconv.decodeStream(this.encodingPair.srcEncoding))
            .pipe(iconv.encodeStream(this.encodingPair.distEncoding))
            .pipe(fs.createWriteStream(fpPair.DistFp));

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

}

export enum Encoding {
    "Shift_JIS"= "Shift_JIS",
    "UTF8"= "UTF-8",
}

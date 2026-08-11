'use strict';
import * as fs from 'fs';
import * as path from 'path';
import * as Mocha from 'mocha';

function findTestFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) {
            found.push(...findTestFiles(full));
        } else if (entry.endsWith('.test.js')) {
            found.push(full);
        }
    }
    return found;
}

/** Entry point called by @vscode/test-electron from inside the extension host. */
export function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20000 });
    findTestFiles(__dirname).forEach(file => mocha.addFile(file));

    return new Promise<void>((resolve, reject) => {
        mocha.run(failures => {
            if (failures > 0) {
                reject(new Error(`${failures} test(s) failed.`));
                return;
            }
            resolve();
        });
    });
}

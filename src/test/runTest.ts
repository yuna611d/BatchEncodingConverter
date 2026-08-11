'use strict';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Downloads a VS Code build and runs the suite in `./suite` inside the extension host.
 * Invoked by `npm run test:integration`; the unit tests in `./unit` run under plain
 * mocha and do not need any of this.
 */
async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await runTests({ extensionDevelopmentPath: extensionDevelopmentPath, extensionTestsPath: extensionTestsPath });
}

main().catch(error => {
    console.error('Failed to run integration tests:', error);
    process.exit(1);
});

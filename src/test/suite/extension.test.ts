'use strict';
import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'yuna611d.batchencodingconverter';

suite('Extension', () => {

    test('registers the conversion command when activated', async () => {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        if (!extension) {
            assert.fail(`extension ${EXTENSION_ID} was not found`);
        }

        // The command is contributed with an `onCommand:` activation event, so it
        // only reaches the command registry once activate() has run.
        await extension.activate();
        const commands = await vscode.commands.getCommands(true);

        assert.notStrictEqual(commands.indexOf('extension.convertEncoding'), -1);
    });

    test('no longer contributes the removed per-pair commands', async () => {
        const commands = await vscode.commands.getCommands(true);

        assert.strictEqual(commands.indexOf('extension.convertSjisToUTF8'), -1);
        assert.strictEqual(commands.indexOf('extension.convertUTF8ToSjis'), -1);
    });
});

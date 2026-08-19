'use strict';
import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'yuna611d.batchencodingconverter';

suite('Extension', () => {

    test('registers both conversion commands when activated', async () => {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        if (!extension) {
            assert.fail(`extension ${EXTENSION_ID} was not found`);
        }

        // The commands are contributed with `onCommand:` activation events, so they
        // only reach the command registry once activate() has run.
        await extension.activate();
        const commands = await vscode.commands.getCommands(true);

        assert.notStrictEqual(commands.indexOf('extension.convertSjisToUTF8'), -1);
        assert.notStrictEqual(commands.indexOf('extension.convertUTF8ToSjis'), -1);
    });
});

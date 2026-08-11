'use strict';
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension', () => {

    test('contributes both conversion commands', async () => {
        const commands = await vscode.commands.getCommands(true);

        assert.notStrictEqual(commands.indexOf('extension.convertSjisToUTF8'), -1);
        assert.notStrictEqual(commands.indexOf('extension.convertUTF8ToSjis'), -1);
    });
});

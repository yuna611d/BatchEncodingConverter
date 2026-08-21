'use strict';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as iconv from 'iconv-lite';
import * as vscode from 'vscode';
// Imported before the extension so the `vscode` stub is registered first.
import {
    setWorkspace, resetStub, answerQuickPicks,
    quickPickPrompts, quickPickChoices, shownMessages,
    registeredCommand, registeredCommandIds
} from './vscodeStub';
import { activate } from '../../extension';

const COMMAND_ID = 'extension.convertEncoding';

suite('extension', () => {

    let workspace: string;
    const created: string[] = [];

    setup(() => {
        resetStub();
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bec-ext-'));
        created.push(workspace);
        setWorkspace(workspace);
        activate({subscriptions: []} as unknown as vscode.ExtensionContext);
    });

    suiteTeardown(() => {
        created.forEach(dir => fs.rmSync(dir, {recursive: true, force: true}));
    });

    function write(name: string, text: string, encoding: string): void {
        fs.writeFileSync(path.join(workspace, name), iconv.encode(text, encoding));
    }

    /** Invoke the contributed command the way VS Code would. */
    async function invoke(): Promise<void> {
        const handler = registeredCommand(COMMAND_ID);
        if (!handler) {
            assert.fail(`${COMMAND_ID} was never registered`);
        }
        await handler();
    }

    test('contributes exactly one command', () => {
        assert.deepStrictEqual(registeredCommandIds(), [COMMAND_ID]);
    });

    test('asks for the source first, then a target that excludes it', async () => {
        write('a.txt', 'あいうえお', 'Shift_JIS');
        answerQuickPicks('Shift_JIS', 'UTF-8');

        await invoke();

        const choices = quickPickChoices();
        assert.strictEqual(choices.length, 2, 'expected a source picker and a target picker');
        assert.deepStrictEqual(choices[0], [
            'Shift_JIS', 'EUC-JP', 'UTF-8', 'UTF-8 with BOM', 'UTF-16 LE (with BOM)', 'UTF-16 BE (with BOM)'
        ]);
        assert.strictEqual(choices[1].indexOf('Shift_JIS'), -1, 'the source was offered as a target');
        assert.strictEqual(choices[1].length, 5);
        assert.ok(quickPickPrompts()[1].indexOf('Shift_JIS') > -1, 'the second prompt should name the source');
    });

    test('converts and reports success', async () => {
        write('a.txt', 'あいうえお', 'Shift_JIS');
        answerQuickPicks('Shift_JIS', 'UTF-8');

        await invoke();

        const written = fs.readFileSync(path.join(workspace, '_UTF-8', 'a.txt'), 'utf8');
        assert.strictEqual(written, 'あいうえお');
        assert.strictEqual(shownMessages().info.length, 1);
        assert.ok(shownMessages().info[0].indexOf('Saved 1 file(s) as UTF-8') > -1);
        assert.deepStrictEqual(shownMessages().warning, []);
    });

    test('warns rather than reporting plain success when characters are lost', async () => {
        write('emoji.txt', 'メール😀です', 'UTF-8');
        answerQuickPicks('UTF-8', 'Shift_JIS');

        await invoke();

        assert.deepStrictEqual(shownMessages().info, []);
        assert.strictEqual(shownMessages().warning.length, 1);
        assert.ok(shownMessages().warning[0].indexOf('emoji.txt') > -1);
    });

    test('does nothing when the source picker is dismissed', async () => {
        write('a.txt', 'あいうえお', 'Shift_JIS');
        answerQuickPicks(undefined);

        await invoke();

        assert.strictEqual(quickPickChoices().length, 1, 'should not ask for a target');
        assert.deepStrictEqual(shownMessages(), {info: [], warning: [], error: []});
        assert.deepStrictEqual(fs.readdirSync(workspace), ['a.txt'], 'nothing should have been written');
    });

    test('does nothing when the target picker is dismissed', async () => {
        write('a.txt', 'あいうえお', 'Shift_JIS');
        answerQuickPicks('Shift_JIS', undefined);

        await invoke();

        assert.deepStrictEqual(shownMessages(), {info: [], warning: [], error: []});
        assert.deepStrictEqual(fs.readdirSync(workspace), ['a.txt'], 'nothing should have been written');
    });

    test('surfaces a missing workspace as an error message', async () => {
        setWorkspace(undefined);
        answerQuickPicks('Shift_JIS', 'UTF-8');

        await invoke();

        assert.strictEqual(shownMessages().error.length, 1);
        assert.ok(shownMessages().error[0].indexOf('Missing workspace') > -1);
    });
});

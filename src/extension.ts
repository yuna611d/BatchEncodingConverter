'use strict';
import * as vscode from 'vscode';
import {
    Service, ConversionSummary, EncodingSpec, ENCODINGS, targetsFor,
    DEFAULT_EXCLUDE_DIRECTORIES
} from './Services/Service';

interface Scope {
    label: string;
    recursive: boolean;
}

const SCOPES: Scope[] = [
    {label: 'Only files directly in the workspace folder', recursive: false},
    {label: 'Include sub directories', recursive: true},
];

export function activate(context: vscode.ExtensionContext) {

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.convertEncoding', convertEncoding)
    );

    /**
     * Ask for the source and target encodings, then convert the workspace.
     * Dismissing either picker cancels the command without a message.
     */
    async function convertEncoding() {
        const source = await pickEncoding('Convert files from which encoding?', ENCODINGS);
        if (!source) {
            return;
        }
        const target = await pickEncoding(`Convert from ${source.label} to which encoding?`, targetsFor(source));
        if (!target) {
            return;
        }
        const scope = await pickScope();
        if (!scope) {
            return;
        }

        try {
            const service = new Service({srcEncoding: source, distEncoding: target}, {
                recursive: scope.recursive,
                excludeDirectories: excludeDirectories()
            });
            const summary = await service.convertEncoding();
            report(summary, target);
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`BatchEncodingConvert failed: ${reason}`);
        }
    }

    /**
     * Show the encodings and return the chosen one, or undefined if dismissed.
     * @param placeHolder prompt shown above the list
     * @param choices encodings to offer
     */
    async function pickEncoding(placeHolder: string, choices: EncodingSpec[]): Promise<EncodingSpec | undefined> {
        const picked = await vscode.window.showQuickPick(
            choices.map(spec => ({label: spec.label, spec: spec})),
            {placeHolder: placeHolder}
        );
        return picked ? picked.spec : undefined;
    }

    /** Ask how far to walk, or return undefined if dismissed. */
    async function pickScope(): Promise<Scope | undefined> {
        const picked = await vscode.window.showQuickPick(
            SCOPES.map(scope => ({label: scope.label, scope: scope})),
            {placeHolder: 'Which files should be converted?'}
        );
        return picked ? picked.scope : undefined;
    }

    /**
     * Directory names the user wants left alone. Hidden directories and the
     * extension's own output are always skipped, whatever this returns.
     */
    function excludeDirectories(): string[] {
        const configured = vscode.workspace
            .getConfiguration('batchEncodingConverter')
            .get<string[]>('excludeDirectories');
        return configured === undefined ? DEFAULT_EXCLUDE_DIRECTORIES : configured;
    }

    /**
     * Report the outcome. Losing characters or failing on a file is a warning,
     * not the plain success the old code always reported.
     */
    function report(summary: ConversionSummary, target: EncodingSpec) {
        const message = describe(summary, target);
        if (summary.lossy.length > 0 || summary.failed.length > 0) {
            vscode.window.showWarningMessage(message);
            return;
        }
        vscode.window.showInformationMessage(message);
    }

    /**
     * Build the completion message out of what the run actually did.
     * @param summary outcome reported by the service
     * @param target encoding the files were converted to
     */
    function describe(summary: ConversionSummary, target: EncodingSpec): string {
        const parts = [`Saved ${summary.converted} file(s) as ${target.label} in ${summary.outputDir}`];
        if (summary.skipped.length > 0) {
            parts.push(`skipped ${summary.skipped.length} binary file(s)`);
        }
        if (summary.lossy.length > 0) {
            parts.push(`${summary.lossy.length} file(s) lost characters ${target.label} cannot represent: ${summary.lossy.join(', ')}`);
        }
        if (summary.failed.length > 0) {
            parts.push(`failed on ${summary.failed.length} file(s): ${summary.failed.map(f => f.file).join(', ')}`);
        }
        return parts.join('; ');
    }

}

// this method is called when your extension is deactivated
export function deactivate() {
}

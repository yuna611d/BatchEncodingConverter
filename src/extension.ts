'use strict';
import * as vscode from 'vscode';
import { ServiceProvider, ServiceType } from './Providers/ServiceProvider';
import { ConversionSummary } from './Services/Service';

export function activate(context: vscode.ExtensionContext) {

    // Convert to UTF8
    context.subscriptions.push(
        disposableAction('extension.convertSjisToUTF8', ServiceType.SJIStoUTF8, 'UTF8')
    );
    // Convert to SJIS
    context.subscriptions.push(
        disposableAction('extension.convertUTF8ToSjis', ServiceType.UTF8toSJIS, 'SJIS')
    );


    /**
     * Return register command, which has main action
     * @param command command id contributed in package.json
     * @param serviceType conversion direction to run
     * @param label human readable name of the target encoding
     */
    function disposableAction(command: string, serviceType: ServiceType, label: string) {

        return vscode.commands.registerCommand(command, async () => {
            try {
                // Main Action
                const service = new ServiceProvider().provide(serviceType);
                const summary = await service.convertEncoding();

                // FinishMessage
                vscode.window.showInformationMessage(describe(summary, label));
            } catch (e) {
                const reason = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`BatchEncodingConvert failed: ${reason}`);
            }
        });
    }

    /**
     * Build the completion message out of what the run actually did.
     * @param summary outcome reported by the service
     * @param label human readable name of the target encoding
     */
    function describe(summary: ConversionSummary, label: string): string {
        const parts = [`Saved ${summary.converted} file(s) as ${label} in ${summary.outputDir}`];
        if (summary.skipped.length > 0) {
            parts.push(`skipped ${summary.skipped.length} binary file(s)`);
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


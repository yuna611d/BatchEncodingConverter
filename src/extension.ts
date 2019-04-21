'use strict';
import * as vscode from 'vscode';
import { ServiceProvider, ServiceType } from './Providers/ServiceProvider';

export function activate(context: vscode.ExtensionContext) {

    // Convert to UTF8
    context.subscriptions.push(
        disposableAction('extension.convertSjisToUTF8', ServiceType.SJIStoUTF8, {FinishMessage:'Saved all files as UTF8'})
    );
    // Convert to SJIS
    context.subscriptions.push(
        disposableAction('extension.convertUTF8ToSjis', ServiceType.UTF8toSJIS, {FinishMessage:'Saved all files as SJIS'})
    );


    /**
     * Return register command, which has main action
     * @param command 
     * @param message 
     */
    function disposableAction(command:string, serviceType: ServiceType ,message: {StartMessage?: string, FinishMessage?: string}) {

        return vscode.commands.registerCommand(command, () => { 
            // StartMessage
            showMessage(message.StartMessage);

            // Main Action
            const service = new ServiceProvider().provide(serviceType);
            service.convertEncoding();
    
            // FinishMessage
            showMessage(message.FinishMessage);
        });
    }

    /**
     * Show InformationMessage if message exist.
     * @param message 
     */
    function showMessage(message?: string) {
        if (message) {
            vscode.window.showInformationMessage(message);
        }
    }
}

// this method is called when your extension is deactivated
export function deactivate() {
}


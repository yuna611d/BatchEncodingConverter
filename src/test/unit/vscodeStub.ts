'use strict';
import * as Module from 'module';

/**
 * `Service` imports the `vscode` module at load time, which only exists inside the
 * extension host. Registering a stub loader lets the conversion logic be unit tested
 * in plain Node. This module must be loaded before anything that reaches `vscode`;
 * `.mocharc.json` requires it, and the test files import it before the service.
 */

interface WorkspaceFolderStub {
    uri: { fsPath: string };
}

const state: { workspaceFolders: WorkspaceFolderStub[] | undefined } = {
    workspaceFolders: undefined
};

/** Point the stubbed workspace at `fsPath`, or pass undefined for "no workspace open". */
export function setWorkspace(fsPath: string | undefined): void {
    state.workspaceFolders = fsPath === undefined ? undefined : [{ uri: { fsPath: fsPath } }];
}

const fakeVscode = {
    workspace: {
        get workspaceFolders(): WorkspaceFolderStub[] | undefined {
            return state.workspaceFolders;
        }
    }
};

type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;

// `Module._load` is internal and therefore absent from @types/node.
const loadable = Module as unknown as { _load: ModuleLoader };
const originalLoad = loadable._load;

loadable._load = (request, parent, isMain) => {
    if (request === 'vscode') {
        return fakeVscode;
    }
    return originalLoad.call(loadable, request, parent, isMain);
};

'use strict';
import * as Module from 'module';

/**
 * `Service` and `extension` import the `vscode` module at load time, which only
 * exists inside the extension host. Registering a stub loader lets both be unit
 * tested in plain Node. This module must be loaded before anything that reaches
 * `vscode`; `.mocharc.json` requires it, and the test files import it before the
 * code under test.
 */

interface WorkspaceFolderStub {
    uri: { fsPath: string };
}

interface QuickPickItemStub {
    label: string;
}

interface Disposable {
    dispose(): void;
}

type CommandHandler = (...args: unknown[]) => unknown;

interface StubState {
    workspaceFolders: WorkspaceFolderStub[] | undefined;
    /** Labels the next showQuickPick calls resolve to; undefined means dismissed. */
    quickPickAnswers: Array<string | undefined>;
    /** Prompts shown, in order. */
    quickPickPrompts: string[];
    /** Labels offered by each showQuickPick call, in order. */
    quickPickChoices: string[][];
    info: string[];
    warning: string[];
    error: string[];
    commands: Map<string, CommandHandler>;
    /** Values returned by workspace.getConfiguration(...).get(key), by 'section.key'. */
    configuration: Map<string, unknown>;
}

const state: StubState = {
    workspaceFolders: undefined,
    quickPickAnswers: [],
    quickPickPrompts: [],
    quickPickChoices: [],
    info: [],
    warning: [],
    error: [],
    commands: new Map<string, CommandHandler>(),
    configuration: new Map<string, unknown>()
};

/** Point the stubbed workspace at `fsPath`, or pass undefined for "no workspace open". */
export function setWorkspace(fsPath: string | undefined): void {
    state.workspaceFolders = fsPath === undefined ? undefined : [{uri: {fsPath: fsPath}}];
}

/** Forget everything recorded so far, including registered commands. */
export function resetStub(): void {
    state.quickPickAnswers = [];
    state.quickPickPrompts = [];
    state.quickPickChoices = [];
    state.info = [];
    state.warning = [];
    state.error = [];
    state.commands.clear();
    state.configuration.clear();
}

/** Queue the labels the next quick picks resolve to. `undefined` dismisses one. */
export function answerQuickPicks(...answers: Array<string | undefined>): void {
    state.quickPickAnswers = answers;
}

/** Make workspace.getConfiguration(section).get(key) return `value`. */
export function setConfiguration(section: string, key: string, value: unknown): void {
    state.configuration.set(section + '.' + key, value);
}

export function quickPickPrompts(): string[] {
    return state.quickPickPrompts;
}

export function quickPickChoices(): string[][] {
    return state.quickPickChoices;
}

export function shownMessages(): {info: string[], warning: string[], error: string[]} {
    return {info: state.info, warning: state.warning, error: state.error};
}

export function registeredCommand(id: string): CommandHandler | undefined {
    return state.commands.get(id);
}

export function registeredCommandIds(): string[] {
    return Array.from(state.commands.keys());
}

const fakeVscode = {
    workspace: {
        get workspaceFolders(): WorkspaceFolderStub[] | undefined {
            return state.workspaceFolders;
        },
        getConfiguration(section: string) {
            return {
                get<T>(key: string): T | undefined {
                    return state.configuration.get(section + '.' + key) as T | undefined;
                }
            };
        }
    },
    window: {
        showQuickPick<T extends QuickPickItemStub>(items: T[], options?: {placeHolder?: string}): Promise<T | undefined> {
            state.quickPickPrompts.push(options && options.placeHolder ? options.placeHolder : '');
            state.quickPickChoices.push(items.map(item => item.label));
            const answer = state.quickPickAnswers.shift();
            if (answer === undefined) {
                return Promise.resolve(undefined);
            }
            return Promise.resolve(items.filter(item => item.label === answer)[0]);
        },
        showInformationMessage(message: string): Promise<undefined> {
            state.info.push(message);
            return Promise.resolve(undefined);
        },
        showWarningMessage(message: string): Promise<undefined> {
            state.warning.push(message);
            return Promise.resolve(undefined);
        },
        showErrorMessage(message: string): Promise<undefined> {
            state.error.push(message);
            return Promise.resolve(undefined);
        }
    },
    commands: {
        registerCommand(id: string, handler: CommandHandler): Disposable {
            state.commands.set(id, handler);
            return {dispose: () => state.commands.delete(id)};
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

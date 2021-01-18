import * as vscode from 'vscode';
import { SourceFile } from './cmantics';
import * as util from './utility';
import { failReason } from './addDefinition';


export class CodeActionProvider implements vscode.CodeActionProvider
{
    public async provideCodeActions(
        document: vscode.TextDocument,
        rangeOrSelection: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.CodeAction[]> {
        // TODO: Clean up this mess.
        const sourceFile = new SourceFile(document);

        const [matchingUri, symbol] = await Promise.all([
            sourceFile.findMatchingSourceFile(),
            sourceFile.getSymbol(rangeOrSelection.start)
        ]);
        const existingDefinition = await symbol?.findDefinition();

        let sourceTitle = 'Add Definition';
        let sourceDisabled: { readonly reason: string } | undefined;
        let currentDisabled: { readonly reason: string } | undefined;
        let newSourceDisabled: { readonly reason: string } | undefined;
        let headerGuardDisabled: { readonly reason: string } | undefined;
        let getterSetterDisabled: { readonly reason: string } | undefined;

        if (symbol?.isInline()) {
            sourceDisabled = { reason: failReason.isInline };
        }
        if (symbol?.isConstexpr()) {
            sourceDisabled = { reason: failReason.isConstexpr };
        }
        if (!symbol?.isFunctionDeclaration()) {
            sourceDisabled = { reason: failReason.notFunctionDeclaration };
            currentDisabled = sourceDisabled;
        }
        if (existingDefinition) {
            sourceDisabled = { reason: failReason.definitionExists };
            currentDisabled = sourceDisabled;
        }
        if (!sourceFile.isHeader()) {
            sourceDisabled = { reason: failReason.notHeaderFile };
            newSourceDisabled = sourceDisabled;
            headerGuardDisabled = sourceDisabled;
            sourceTitle += ' in matching source file';
        } else if (matchingUri) {
            newSourceDisabled = { reason: 'A matching source file already exists.' };
            // TODO: Elide the path if it is very long.
            sourceTitle += ' in "' + util.workspaceRelativePath(matchingUri.path) + '"';
        } else {
            sourceDisabled = { reason: failReason.noMatchingSourceFile };
            sourceTitle += ' in matching source file';
        }
        if (await sourceFile.hasHeaderGuard()) {
            headerGuardDisabled = { reason: 'A header guard already exists.'};
        }
        if (!symbol?.isMemberVariable()) {
            getterSetterDisabled = { reason: 'Symbol is not a member variable.' };
        }

        return [{
            title: sourceTitle,
            kind: vscode.CodeActionKind.Refactor,
            command: {
                title: sourceTitle,
                command: 'cmantic.addDefinition',
                arguments: [symbol, sourceFile, matchingUri]
            },
            disabled: sourceDisabled
        },
        {
            title: 'Add Definition in this file',
            kind: vscode.CodeActionKind.Refactor,
            command: {
                title: 'Add Definition in this file',
                command: 'cmantic.addDefinition',
                arguments: [symbol, sourceFile, sourceFile.uri]
            },
            disabled: currentDisabled
        },
        {
            title: 'Generate \'get\' and \'set\' methods',
            kind: vscode.CodeActionKind.Refactor,
            command: {
                title: 'Generate \'get\' and \'set\' methods',
                command: 'cmantic.generateGetterSetterFor',
                arguments: [symbol]
            },
            disabled: getterSetterDisabled
        },
        {
            title: 'Generate \'get\' method',
            kind: vscode.CodeActionKind.Refactor,
            command: {
                title: 'Generate \'get\' method',
                command: 'cmantic.generateGetterFor',
                arguments: [symbol]
            },
            disabled: getterSetterDisabled
        },
        {
            title: 'Generate \'set\' method',
            kind: vscode.CodeActionKind.Refactor,
            command: {
                title: 'Generate \'set\' method',
                command: 'cmantic.generateSetterFor',
                arguments: [symbol]
            },
            disabled: getterSetterDisabled
        },
        {
            title: 'Add Header Guard',
            kind: vscode.CodeActionKind.Source,
            command: {
                title: 'Add Header Guard',
                command: 'cmantic.addHeaderGuard'
            },
            disabled: headerGuardDisabled
        },
        {
            title: 'Add Include',
            kind: vscode.CodeActionKind.Source,
            command: {
                title: 'Add Include',
                command: 'cmantic.addInclude'
            }
        },
        {
            title: 'Create Matching Source File',
            kind: vscode.CodeActionKind.Source,
            command: {
                title: 'Create Matching Source File',
                command: 'cmantic.createMatchingSourceFile'
            },
            disabled: newSourceDisabled
        }];
    }

    public resolveCodeAction(
        codeAction: vscode.CodeAction,
        token: vscode.CancellationToken,
    ): vscode.CodeAction {
        return codeAction;
    }
}

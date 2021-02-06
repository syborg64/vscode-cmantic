import * as vscode from 'vscode';
import * as util from './utility';
import { SourceDocument } from "./SourceDocument";
import { logger } from './extension';


export async function addInclude(): Promise<void>
{
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        logger.showErrorMessage('No active text editor detected.');
        return;
    }

    const userInput = vscode.window.showInputBox({ value: '#include ', valueSelection: [9, 9] });

    const sourceDoc = new SourceDocument(editor.document);
    const newIncludePosition = sourceDoc.findPositionForNewInclude();
    const eol = sourceDoc.endOfLine;

    userInput.then(value => {
        if (value?.trim().match(/^#include\s*<.+>/)) {
            editor.edit(edit => edit.insert(newIncludePosition.system, value + eol));
        } else if (value?.trim().match(/^#include\s*".+"/)) {
            editor.edit(edit => edit.insert(newIncludePosition.project, value + eol));
        } else if (value) {
            logger.showInformationMessage('This doesn\'t seem to be a valid include statement. It wasn\'t added.');
        }
    });
}

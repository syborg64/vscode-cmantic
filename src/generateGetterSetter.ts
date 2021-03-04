import * as vscode from 'vscode';
import * as cfg from './configuration';
import * as util from './utility';
import { ProposedPosition, TargetLocation } from './ProposedPosition';
import { SourceDocument } from './SourceDocument';
import { CSymbol } from './CSymbol';
import { Accessor, Getter, Setter } from "./Accessor";
import { getMatchingSourceFile } from './extension';
import { logger } from './logger';


export const title = {
    getterSetter: 'Generate Getter and Setter Member Functions',
    getter: 'Generate Getter Member Function',
    setter: 'Generate Setter Member Function'
};

export const failure = {
    noActiveTextEditor: 'No active text editor detected.',
    notCpp: 'Detected language is not C++, cannot create a member function.',
    notHeaderFile: 'This file is not a header file.',
    noMemberVariable: 'No member variable detected.',
    positionNotFound: 'Could not find a position for a new public member function.',
    getterOrSetterExists: 'There already exists a getter or setter member function.',
    getterAndSetterExists: 'There already exists getter and setter member functions.',
    getterExists: 'There already exists a getter member function.',
    setterExists: 'There already exists a setter member function.',
    isConst: 'Const variables cannot be assigned after initialization.'
};

enum AccessorType {
    Getter,
    Setter,
    Both
}

export async function generateGetterSetter(): Promise<void> {
    await getCurrentSymbolAndCall(generateGetterSetterFor);
}

export async function generateGetter(): Promise<void> {
    await getCurrentSymbolAndCall(generateGetterFor);
}

export async function generateSetter(): Promise<void> {
    await getCurrentSymbolAndCall(generateSetterFor);
}

async function getCurrentSymbolAndCall(
    callback: (symbol: CSymbol, classDoc: SourceDocument) => Promise<void>
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        logger.alertError(failure.noActiveTextEditor);
        return;
    }

    const sourceDoc = new SourceDocument(editor.document);
    if (sourceDoc.languageId !== 'cpp') {
        logger.alertWarning(failure.notCpp);
        return;
    } else if (!sourceDoc.isHeader()) {
        logger.alertWarning(failure.notHeaderFile);
        return;
    }

    const symbol = await sourceDoc.getSymbol(editor.selection.start);
    if (!symbol?.isMemberVariable()) {
        logger.alertWarning(failure.noMemberVariable);
        return;
    }

    await callback(symbol, sourceDoc);
}

export async function generateGetterSetterFor(symbol: CSymbol, classDoc: SourceDocument): Promise<void> {
    const getter = symbol.parent?.findGetterFor(symbol);
    const setter = symbol.parent?.findSetterFor(symbol);

    if (symbol.isConst()) {
        if (getter) {
            logger.alertInformation(failure.isConst + ' ' + failure.getterExists);
            return;
        }
        logger.alertInformation(failure.isConst + ' Only generating a getter member function.');
        await generateGetterFor(symbol, classDoc);
        return;
    } else if (getter && !setter) {
        logger.alertInformation(failure.getterExists + ' Only generating a setter member function.');
        await generateSetterFor(symbol, classDoc);
        return;
    } else if (!getter && setter) {
        logger.alertInformation(failure.setterExists + ' Only generating a getter member function.');
        await generateGetterFor(symbol, classDoc);
        return;
    } else if (getter && setter) {
        logger.alertInformation(failure.getterAndSetterExists);
        return;
    }

    const getterPosition = getPositionForNewAccessorDeclaration(symbol, AccessorType.Both);
    if (!getterPosition) {
        logger.alertError(failure.positionNotFound);
        return;
    }

    const setterPosition = new ProposedPosition(getterPosition, {
        relativeTo: getterPosition.options.relativeTo,
        after: true,
        nextTo: true,
        emptyScope: getterPosition.options.emptyScope
    });

    const workspaceEdit = new vscode.WorkspaceEdit();
    await addNewAccessorToWorkspaceEdit(new Getter(symbol), getterPosition, classDoc, workspaceEdit);
    await addNewAccessorToWorkspaceEdit(await Setter.create(symbol), setterPosition, classDoc, workspaceEdit);
    await vscode.workspace.applyEdit(workspaceEdit);
}

export async function generateGetterFor(symbol: CSymbol, classDoc: SourceDocument): Promise<void> {
    const getter = symbol.parent?.findGetterFor(symbol);
    if (getter) {
        logger.alertInformation(failure.getterExists);
        return;
    }

    const position = getPositionForNewAccessorDeclaration(symbol, AccessorType.Getter);
    if (!position) {
        logger.alertError(failure.positionNotFound);
        return;
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    await addNewAccessorToWorkspaceEdit(new Getter(symbol), position, classDoc, workspaceEdit);
    await vscode.workspace.applyEdit(workspaceEdit);
}

export async function generateSetterFor(symbol: CSymbol, classDoc: SourceDocument): Promise<void> {
    if (symbol.isConst()) {
        logger.alertInformation(failure.isConst);
        return;
    }

    const setter = symbol.parent?.findSetterFor(symbol);
    if (setter) {
        logger.alertInformation(failure.setterExists);
        return;
    }

    const position = getPositionForNewAccessorDeclaration(symbol, AccessorType.Setter);
    if (!position) {
        logger.alertError(failure.positionNotFound);
        return;
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    await addNewAccessorToWorkspaceEdit(await Setter.create(symbol), position, classDoc, workspaceEdit);
    await vscode.workspace.applyEdit(workspaceEdit);
}

function getPositionForNewAccessorDeclaration(
    symbol: CSymbol,
    type: AccessorType
): ProposedPosition | undefined {
    // If the new accessor is a getter, then we want to place it relative to the setter, and vice-versa.
    switch (type) {
    case AccessorType.Getter:
        return symbol.parent?.findPositionForNewMemberFunction(util.Access.public, symbol.setterName(), symbol);
    case AccessorType.Setter:
        return symbol.parent?.findPositionForNewMemberFunction(util.Access.public, symbol.getterName(), symbol);
    case AccessorType.Both:
        return symbol.parent?.findPositionForNewMemberFunction(util.Access.public);
    }
}

async function addNewAccessorToWorkspaceEdit(
    newAccessor: Accessor,
    declarationPos: ProposedPosition,
    classDoc: SourceDocument,
    workspaceEdit: vscode.WorkspaceEdit
): Promise<void> {
    const target = await getTargetForAccessorDefinition(newAccessor, declarationPos, classDoc);

    if (target.sourceDoc.fileName === classDoc.fileName && target.position.isEqual(declarationPos)) {
        const inlineDefinition = newAccessor.declaration + ' { ' + newAccessor.body + ' }';
        const formattedInlineDefinition = await declarationPos.formatTextToInsert(inlineDefinition, classDoc);

        workspaceEdit.insert(target.sourceDoc.uri, target.position, formattedInlineDefinition);
    } else {
        const curlySeparator = (cfg.functionCurlyBraceFormat('cpp') === cfg.CurlyBraceFormat.NewLine)
                ? target.sourceDoc.endOfLine
                : ' ';

        const formattedDeclaration = await declarationPos.formatTextToInsert(newAccessor.declaration + ';', classDoc);

        const definition = await newAccessor.definition(target.sourceDoc, target.position, curlySeparator);
        const formattedDefinition = await target.formatTextToInsert(definition);

        workspaceEdit.insert(classDoc.uri, declarationPos, formattedDeclaration);
        workspaceEdit.insert(target.sourceDoc.uri, target.position, formattedDefinition);
    }
}

async function getTargetForAccessorDefinition(
    accessor: Accessor,
    declarationPos: ProposedPosition,
    classDoc: SourceDocument
): Promise<TargetLocation> {
    const accessorDefinitionLocation = (accessor instanceof Getter)
            ? cfg.getterDefinitionLocation()
            : cfg.setterDefinitionLocation();

    switch (accessorDefinitionLocation) {
    case cfg.DefinitionLocation.Inline:
        return new TargetLocation(declarationPos, classDoc);
    case cfg.DefinitionLocation.SourceFile:
        // If the class is not in a header file then control will pass down to CurrentFile.
        if (classDoc.isHeader()) {
            const matchingUri = await getMatchingSourceFile(classDoc.uri);
            if (matchingUri && !accessor.parent?.isTemplate()) {
                const targetDoc = await SourceDocument.open(matchingUri);
                return new TargetLocation(
                        await classDoc.findPositionForFunctionDefinition(declarationPos, targetDoc), targetDoc);
            }
        }
    case cfg.DefinitionLocation.CurrentFile:
        return new TargetLocation(
                await classDoc.findPositionForFunctionDefinition(declarationPos, classDoc), classDoc);
    }
}

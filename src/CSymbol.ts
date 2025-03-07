import * as vscode from 'vscode';
import * as cfg from './configuration';
import * as util from './utility';
import * as parse from './parsing';
import SourceFile from './SourceFile';
import SourceDocument from './SourceDocument';
import SourceSymbol from './SourceSymbol';
import SubSymbol from './SubSymbol';
import { ProposedPosition } from './ProposedPosition';
import { activeLanguageServer, LanguageServer } from './extension';


// Only matches identifiers that are not followed by a scope resolution operator (::).
const re_scopeResolvedIdentifier = /[\w_][\w\d_]*\b(?!\s*::)/;
const re_beginningOfScopeString = /(?<!::\s*|[\w\d_])[\w_][\w\d_]*(?=\s*::)/g;

/**
 * Extends SourceSymbol by adding a document property that gives more semantic-awareness over SourceSymbol.
 */
export default class CSymbol extends SourceSymbol {
    readonly document: SourceDocument;
    parent?: CSymbol;

    // Don't use these, use their getters instead.
    private _parsableText?: string;
    private _parsableTemplateSnippet?: string;
    private _accessSpecifiers?: SubSymbol[];
    private _namedScopes?: string[];
    private _trueStart?: vscode.Position;
    private _trueEnd?: vscode.Position;
    private _leadingCommentStart?: vscode.Position;

    constructor(symbol: SourceSymbol, document: SourceDocument) {
        super(symbol, document.uri);
        this.document = document;

        if (symbol.parent) {
            this.parent = new CSymbol(symbol.parent, document);
        }

        this.selectionRange = parse.getRangeOfSymbolName(this);

        this.range = this.range.with(this.range.start, parse.getEndOfStatement(this.document, this.range.end));
    }

    text(): string { return this.document.getText(this.range); }

    fullText(): string { return this.document.getText(this.fullRange); }

    /**
     * The entire range of all code associated with this symbol, including template statements,
     * and trailing object declarations, up to (and including) the final semi-colon.
     */
     get fullRange(): vscode.Range { return new vscode.Range(this.trueStart, this.trueEnd); }

    /**
     * Returns the text contained in this symbol with comments, strings, and attributes masked with spaces.
     */
    get parsableText(): string {
        if (this._parsableText !== undefined) {
            return this._parsableText;
        }
        return this._parsableText = parse.maskNonSourceText(this.text());
    }

    get parsableFullText(): string {
        return this.parsableTemplateSnippet + this.parsableText;
    }

    get parsableLeadingText(): string {
        const endIndex = this.document.offsetAt(this.selectionRange.start) - this.startOffset();
        return this.parsableText.substring(0, endIndex);
    }

    get parsableTrailingText(): string {
        const startIndex = this.document.offsetAt(this.selectionRange.end) - this.startOffset();
        return this.parsableText.substring(startIndex);
    }

    get parsableFullLeadingText(): string {
        return this.parsableTemplateSnippet + this.parsableLeadingText;
    }

    private get parsableTemplateSnippet(): string {
        if (this._parsableTemplateSnippet !== undefined) {
            return this._parsableTemplateSnippet;
        }

        this._parsableTemplateSnippet = this.document.getText(new vscode.Range(this.trueStart, this.range.start));
        if (!this._parsableTemplateSnippet) {
            return this._parsableTemplateSnippet;
        }

        return this._parsableTemplateSnippet = parse.maskNonSourceText(this._parsableTemplateSnippet);
    }

    get rangeWithComments(): vscode.Range {
        return new vscode.Range(this.leadingCommentStart, this.trailingCommentEnd());
    }

    startOffset(): number { return this.document.offsetAt(this.range.start); }

    endOffset(): number { return this.document.offsetAt(this.range.end); }

    isBefore(offset: number): boolean { return this.endOffset() < offset; }

    isAfter(offset: number): boolean { return this.startOffset() > offset; }

    matches(other: CSymbol): boolean {
        return super.matches(other) && util.arraysAreEqual(this.allScopes(), other.allScopes())
                && this.templatedName(true) === other.templatedName(true);
    }

    get accessSpecifiers(): SubSymbol[] {
        if (this._accessSpecifiers) {
            return this._accessSpecifiers;
        }

        this._accessSpecifiers = [];

        if (!this.isClassType()) {
            return this._accessSpecifiers;
        }

        const startOffset = this.startOffset();

        let parsableText = this.parsableText;
        this.children.forEach(child => {
            // Mask children in order to easily match access specifiers.
            const childCSymbol = new CSymbol(child, this.document);
            const relativeStartOffset = childCSymbol.startOffset() - startOffset;
            const relativeEndOffset = childCSymbol.endOffset() - startOffset;
            parsableText = parsableText.slice(0, relativeStartOffset)
                    + ' '.repeat(relativeEndOffset - relativeStartOffset)
                    + parsableText.slice(relativeEndOffset);
        });

        // Prevent potential macro arguments from affecting access specifier matching.
        parsableText = parse.maskParentheses(parsableText);

        for (const match of parsableText.matchAll(/\b[\w_][\w\d_]*\s*:(?!:)/g)) {
            if (match.index === undefined) {
                continue;
            }
            const start = this.document.positionAt(startOffset + match.index);
            const end = this.document.positionAt(startOffset + match.index + match[0].length);
            this._accessSpecifiers.push(new SubSymbol(this, new vscode.Range(start, end)));
        }

        return this._accessSpecifiers;
    }

    rangesOfAccess(access: util.AccessLevel): vscode.Range[] {
        const re_accessSpecifier = util.accessSpecifierRegexp(access);
        const ranges: vscode.Range[] = [];
        let start: vscode.Position | undefined;

        if (access === util.AccessLevel.private && this.isClass()) {
            start = this.bodyStart();
        } else if (access === util.AccessLevel.public && this.isStruct()) {
            start = this.bodyStart();
        }

        for (const accessSpecifier of this.accessSpecifiers) {
            if (re_accessSpecifier.test(accessSpecifier.name)) {
                if (start) {
                    ranges.push(new vscode.Range(start, accessSpecifier.range.start));
                }
                start = accessSpecifier.range.end;
            } else if (start) {
                ranges.push(new vscode.Range(start, accessSpecifier.range.start));
                start = undefined;
            }
        }

        if (start) {
            ranges.push(new vscode.Range(start, this.bodyEnd()));
        }

        return ranges;
    }

    positionHasAccess(position: vscode.Position, access: util.AccessLevel): boolean {
        return this.rangesOfAccess(access).some(range => range.contains(position));
    }

    getterName(): string {
        if (!this.isMemberVariable()) {
            return '';
        }

        const formattedBaseName = cfg.formatToCaseStyle(this.baseName(), this.uri);

        if (cfg.boolGetterIsPrefix(this.uri)) {
            const maskedLeadingText = parse.maskParentheses(parse.maskAngleBrackets(this.parsableLeadingText));
            if (/\bbool\b/.test(maskedLeadingText) && !/^[iI]s[_A-Z]/.test(formattedBaseName)) {
                return cfg.formatToCaseStyle('is_' + formattedBaseName, this.uri);
            }
        }

        if (formattedBaseName !== this.name) {
            return formattedBaseName;
        }

        return cfg.formatToCaseStyle('get_' + formattedBaseName, this.uri);
    }

    setterName(): string {
        if (!this.isMemberVariable()) {
            return '';
        }

        return cfg.formatToCaseStyle('set_' + this.baseName(), this.uri);
    }

    findGetterFor(memberVariable: CSymbol): SourceSymbol | undefined {
        if (memberVariable.parent !== this || !memberVariable.isMemberVariable()) {
            return;
        }

        const getterName = memberVariable.getterName();

        return this.children.find(child => child.name === getterName);
    }

    findSetterFor(memberVariable: CSymbol): SourceSymbol | undefined {
        if (memberVariable.parent !== this || !memberVariable.isMemberVariable()) {
            return;
        }

        const setterName = memberVariable.setterName();

        return this.children.find(child => child.name === setterName);
    }

    /**
     * Finds a position for a new member function within this class or struct. Optionally provide a relativeName
     * to look for a position next to. Optionally provide a memberVariable if the new member function is an
     * accessor. Returns undefined if this is not a class or struct.
     */
    findPositionForNewMemberFunction(
        access: util.AccessLevel, relativeName?: string, memberVariable?: CSymbol
    ): ProposedPosition | undefined {
        if (!this.isClassType()) {
            return;
        }

        if (relativeName) {
            /* If relativeName is a setterName, then ProposedPosition should be before, since the new member function
             * is a getter. This is to match the order of these members when both are generated at the same time. */
            const isGetter = memberVariable ? relativeName === memberVariable.setterName() : false;

            // This is a reverse ranged for loop, since we generally want to place new members towards the end.
            for (let i = this.children.length - 1, child: CSymbol;
                i >= 0 && (child = new CSymbol(this.children[i], this.document));
                --i
            ) {
                if (child.name === relativeName) {
                    if (isGetter) {
                        return new ProposedPosition(child.leadingCommentStart, {
                            relativeTo: child.range,
                            before: true,
                            nextTo: true
                        });
                    } else {
                        return new ProposedPosition(child.trailingCommentEnd(), {
                            relativeTo: child.range,
                            after: true,
                            nextTo: true
                        });
                    }
                }
            }
        }

        for (let i = this.children.length - 1, child: CSymbol;
            i >= 0 && (child = new CSymbol(this.children[i], this.document));
            --i
        ) {
            if (this.positionHasAccess(child.range.end, access)) {
                return new ProposedPosition(child.trailingCommentEnd(), {
                    relativeTo: child.range,
                    after: true
                });
            }
        }

        return this.getPositionForNewChild();
    }

    scopes(): CSymbol[] { return super.scopes() as CSymbol[]; }

    get namedScopes(): string[] {
        if (this._namedScopes) {
            return this._namedScopes;
        }

        this._namedScopes = [];

        const scopeStringStartIndex = this.document.offsetAt(this.scopeStringStart()) - this.startOffset();
        const scopeStringEndIndex = this.parsableLeadingText.lastIndexOf('::');
        if (scopeStringEndIndex < scopeStringStartIndex) {
            return [];
        }

        const scopeString = this.parsableLeadingText.slice(scopeStringStartIndex, scopeStringEndIndex);
        const maskedScopeString = parse.maskAngleBrackets(scopeString);

        for (const match of maskedScopeString.matchAll(/[\w_][\w\d_]*(\s*<\s*>)?/g)) {
            if (match.index !== undefined) {
                const scope = scopeString.slice(match.index, match.index + match[0].length);
                this._namedScopes.push(parse.normalizeWhitespace(scope));
            }
        }

        return this._namedScopes;
    }

    allScopes(): string[] {
        const allScopes: string[] = [];

        this.scopes().forEach(scope => {
            if (!scope.isNamespace()) {
                allScopes.push(...scope.namedScopes);
            }
            allScopes.push(scope.templatedName(true));
        });

        if (!this.isNamespace()) {
            allScopes.push(...this.namedScopes);
        }

        return allScopes;
    }

    async scopeString(target: SourceDocument, position: vscode.Position, namespacesOnly?: boolean): Promise<string> {
        let scopeString = '';
        const scopes = (this.isClassType() || this.isNamespace())
                ? [...this.scopes(), this]
                : this.scopes();

        for (const scope of scopes) {
            if (namespacesOnly && scope.isClassType()) {
                break;
            }

            let targetScope = await target.findMatchingSymbol(scope);
            // Check if position exists inside of a corresponding scope block. If so, omit that scope.name.
            if (!targetScope || !util.containsExclusive(targetScope.range, position)) {
                if (!targetScope) {
                    targetScope = scope;
                }

                if (targetScope.isAnonymous()) {
                    continue;
                }

                if (targetScope.isNamespace()) {
                    scopeString += targetScope.name + '::';
                } else {
                    const nameRange = new vscode.Range(targetScope.scopeStringStart(), targetScope.selectionRange.end);
                    scopeString += targetScope.document.getText(nameRange) + targetScope.templateParameters() + '::';
                }
            }
        }

        return scopeString;
    }

    immediateScope(): SubSymbol | undefined {
        const maskedLeadingText = parse.maskAngleBrackets(this.parsableLeadingText);
        const match = maskedLeadingText.match(/([\w_][\w\d_]*)(<\s*>)?(?=\s*::\s*$)/);
        if (match?.index === undefined || match.length < 2) {
            return;
        }

        const startOffset = this.startOffset() + match.index;
        const start = this.document.positionAt(startOffset);
        const end = this.document.positionAt(startOffset + match[0].length);
        const selectionEnd = this.document.positionAt(startOffset + match[1].length);

        return new SubSymbol(this.document, new vscode.Range(start, end), new vscode.Range(start, selectionEnd));
    }

    async getParentClass(): Promise<CSymbol | undefined> {
        const immediateScope = this.immediateScope();
        if (immediateScope) {
            const immediateScopeDefinition = await immediateScope.findDefinition();
            if (immediateScopeDefinition) {
                const immediateScopeDoc = (immediateScopeDefinition.uri.fsPath === this.uri.fsPath)
                        ? this.document
                        : await SourceDocument.open(immediateScopeDefinition.uri);
                const immediateScopeSymbol = await immediateScopeDoc.getSymbol(immediateScopeDefinition.range.start);
                if (immediateScopeSymbol?.isClassType()) {
                    return immediateScopeSymbol;
                }
            }
        }
    }

    baseClasses(): SubSymbol[] {
        if (!this.isClassType()) {
            return [];
        }

        const startOffset = this.document.offsetAt(this.selectionRange.end);
        let trailingText = this.document.getText(new vscode.Range(this.selectionRange.end, this.declarationEnd()));
        trailingText = parse.maskComments(trailingText, false);
        trailingText = parse.maskAngleBrackets(trailingText);
        trailingText = trailingText.replace(/\b(public|protected|private|virtual)\b/g, parse.masker);

        const baseClasses: SubSymbol[] = [];
        for (const match of trailingText.matchAll(/\b[\w_][\w\d_]*(\s*::\s*[\w_][\w\d_]*)*\b(\s*<\s*>)?/g)) {
            if (match.index !== undefined) {
                const matchStartOffset = startOffset + match.index;
                const start = this.document.positionAt(matchStartOffset);
                const end = this.document.positionAt(startOffset + match.index + match[0].length);
                const selectionMatch = match[0].match(re_scopeResolvedIdentifier);
                let selectionRange: vscode.Range | undefined;
                if (selectionMatch?.index !== undefined) {
                    const selectionStart = this.document.positionAt(matchStartOffset + selectionMatch.index);
                    const selectionEnd = this.document.positionAt(
                            matchStartOffset + selectionMatch.index + selectionMatch[0].length);
                    selectionRange = new vscode.Range(selectionStart, selectionEnd);
                }
                baseClasses.push(new SubSymbol(this.document, new vscode.Range(start, end), selectionRange));
            }
        }

        return baseClasses;
    }

    childNamespaces(): CSymbol[] {
        const namespaces: CSymbol[] = [];
        this.children.forEach(child => {
            if (child.isNamespace()) {
                namespaces.push(new CSymbol(child, this.document));
            }
        });

        return namespaces;
    }

    /**
     * Returns the member variables of this class/struct that are const or a reference.
     */
    memberVariablesThatRequireInitialization(): CSymbol[] {
        if (!this.isClassType()) {
            return [];
        }

        const memberVariables: CSymbol[] = [];
        this.children.forEach(child => {
            if (child.isMemberVariable()) {
                const memberVariable = new CSymbol(child, this.document);
                if (memberVariable.isConst() || memberVariable.isReference()) {
                    memberVariables.push(memberVariable);
                }
            }
        });

        return memberVariables;
    }

    nonStaticMemberVariables(): CSymbol[] {
        if (!this.isClassType()) {
            return [];
        }

        const memberVariables: CSymbol[] = [];
        this.children.forEach(child => {
            if (child.isMemberVariable()) {
                const memberVariable = new CSymbol(child, this.document);
                if (!memberVariable.isStatic()) {
                    memberVariables.push(memberVariable);
                }
            }
        });

        return memberVariables;
    }

    templateStatements(removeDefaultArgs?: boolean): string[] {
        if (!this.isTemplate()) {
            return [];
        }

        const fullTemplateRange = new vscode.Range(this.trueStart, this.declarationStart());
        let fullTemplateStatement = this.document.getText(fullTemplateRange);
        fullTemplateStatement = parse.removeComments(fullTemplateStatement);
        fullTemplateStatement = fullTemplateStatement.replace(parse.getIndentationRegExp(this), '');

        const maskedTemplateStatement = parse.maskAngleBrackets(fullTemplateStatement);

        const templateStatements: string[] = [];
        for (const match of maskedTemplateStatement.matchAll(/\btemplate(\s*<\s*>)?/g)) {
            if (match.index !== undefined) {
                const templateStatement = fullTemplateStatement.slice(match.index, match.index + match[0].length);
                if (!templateStatement.endsWith('>')) {
                    templateStatements.push(templateStatement + '<>');
                } else {
                    templateStatements.push(
                            removeDefaultArgs ? templateStatement.replace(/\s*=[^,>]+(?=[,>])/g, '') : templateStatement);
                }
            }
        }

        return templateStatements;
    }

    allTemplateStatements(removeDefaultArgs?: boolean, forMember?: boolean): string[] {
        const allTemplateStatements: string[] = [];

        this.scopes().forEach(scope => {
            if (scope.isClassType() && scope.isUnspecializedTemplate())  {
                allTemplateStatements.push(...scope.templateStatements(removeDefaultArgs));
            }
        });

        if (!forMember || this.isUnspecializedTemplate()) {
            allTemplateStatements.push(...this.templateStatements(removeDefaultArgs));
        }

        return allTemplateStatements;
    }

    combinedTemplateStatements(removeDefaultArgs?: boolean, separator?: string, forMember?: boolean): string {
        if (separator === undefined) {
            separator = this.document.endOfLine;
        }
        const allTemplateStatements = this.allTemplateStatements(removeDefaultArgs, forMember);
        return allTemplateStatements.length > 0
                ? allTemplateStatements.join(separator) + separator
                : '';
    }

    templateParameters(): string {
        if (this.isSpecializedTemplate()) {
            const startOffset = this.startOffset();
            const startIndex = this.document.offsetAt(this.selectionRange.end) - startOffset;
            const maskedTrailingText = parse.maskAngleBrackets(this.parsableText.slice(startIndex));

            const templateParamStartIndex = maskedTrailingText.indexOf('<');
            const templateParamEndIndex = maskedTrailingText.indexOf('>');
            if (templateParamStartIndex === -1 || templateParamEndIndex === -1) {
                return '';
            }

            const templateParamStart = this.document.positionAt(startOffset + startIndex + templateParamStartIndex);
            const templateParamEnd = this.document.positionAt(startOffset + startIndex + templateParamEndIndex + 1);

            return this.document.getText(new vscode.Range(templateParamStart, templateParamEnd));
        }

        const templateStatements = this.templateStatements(true);
        if (templateStatements.length === 0) {
            return '';
        }
        const templateStatement = templateStatements[templateStatements.length - 1];

        const templateParamStart = templateStatement.indexOf('<');
        if (templateParamStart === -1) {
            return '';
        }

        const parameterList = parse.maskAngleBrackets(templateStatement.slice(templateParamStart + 1, -1));
        const parameters: string[] = [];

        for (const parameter of parameterList.matchAll(/(?<=[\w_][\w\d_]*\b\s*)(\.\.\.)?\s*\b([\w_][\w\d_]*)/g)) {
            parameters.push(parameter[2] + (parameter[1] ? parameter[1] : ''));
        }

        return '<' + parameters.join(', ') + '>';
    }

    templatedName(normalize?: boolean): string {
        const templateName = this.name + this.templateParameters();
        return normalize ? parse.normalizeWhitespace(templateName) : templateName;
    }

    /**
     * Returns the first non-anonymous parent of this symbol, or undefined if there is none.
     */
    firstNamedParent(): CSymbol | undefined {
        let parent = this.parent;
        while (parent?.isAnonymous()) {
            parent = parent.parent;
        }
        return parent;
    }

    isFunctionDeclaration(): boolean {
        return this.isFunction() && !/}\s*(\s*;)*$/.test(this.parsableText)
            && !this.isDeletedOrDefaulted() && !this.isPureVirtual();
    }

    isFunctionDefinition(): boolean {
        return this.isFunction() && /}\s*(\s*;)*$/.test(this.parsableText)
            && !this.isDeletedOrDefaulted() && !this.isPureVirtual();
    }

    isVirtual(): boolean {
        if (/\bvirtual\b/.test(this.parsableLeadingText)) {
            return true;
        }
        const endIndex = this.document.offsetAt(this.declarationEnd())
                - this.document.offsetAt(this.selectionRange.end);
        const maskedTrailingText = parse.maskParentheses(this.parsableTrailingText.slice(0, endIndex));
        return /\b(override|final)\b/.test(maskedTrailingText);
    }

    isPureVirtual(): boolean {
        return /\s*=\s*0\s*(\s*;)*$/.test(this.parsableText) && this.isVirtual();
    }

    isDeletedOrDefaulted(): boolean {
        return /\s*=\s*(delete|default)\s*(\s*;)*$/.test(this.parsableText);
    }

    isInline(): boolean {
        return /\binline\b/.test(this.parsableLeadingText);
    }

    isConstexpr(): boolean {
        return /\bconstexpr\b/.test(this.parsableLeadingText);
    }

    isConsteval(): boolean {
        return /\bconsteval\b/.test(this.parsableLeadingText);
    }

    isPointer(): boolean {
        return parse.maskAngleBrackets(this.parsableLeadingText).includes('*');
    }

    isReference(): boolean {
        return parse.maskAngleBrackets(this.parsableLeadingText).includes('&');
    }

    isConst(): boolean {
        return /\bconst\b/.test(parse.maskAngleBrackets(this.parsableLeadingText));
    }

    isStatic(): boolean {
        return /\bstatic\b/.test(this.parsableLeadingText);
    }

    isTemplate(): boolean {
        return /^template\b/.test(this.parsableFullText);
    }

    isUnspecializedTemplate(): boolean {
        return /\btemplate\s*<\s*[^\s>]/.test(this.parsableFullLeadingText);
    }

    isSpecializedTemplate(): boolean {
        return this.isTemplate() && !this.isUnspecializedTemplate();
    }

    hasUnspecializedTemplate(): boolean {
        for (const scope of this.scopes()) {
            if (scope.isUnspecializedTemplate()) {
                return true;
            }
        }
        return this.isUnspecializedTemplate();
    }

    /**
     * ```cpp
     * namespace isUnqualified::isQualified { namespace isNeither {} }
     * ```
     */
    isQualifiedNamespace(): boolean {
        return this.isNamespace() && /::\s*(inline\s*)?$/.test(this.parsableFullLeadingText);
    }

    /**
     * ```cpp
     * namespace isUnqualified::isQualified { namespace isNeither {} }
     * ```
     */
    isUnqualifiedNamespace(): boolean {
        return this.isNamespace() && /^\s*::\s*[\w_][\w\d_]*/.test(this.parsableTrailingText);
    }

    isAnonymous(): boolean {
        switch (activeLanguageServer()) {
        case LanguageServer.cpptools:
            return this.name.includes('anonymous-namespace')
                || /__unnamed_(class|struct|union)/.test(this.name);
        case LanguageServer.clangd:
            return /anonymous (namespace|class|struct|union)/.test(this.name);
        case LanguageServer.ccls:
            return /anon (class|struct|union)/.test(this.name);
        case LanguageServer.unknown:
            return false;
        }
    }

    isTypedef(): boolean {
        return this.mightBeTypedefOrTypeAlias() && /\btypedef\b/.test(this.parsableText);
    }

    isTypeAlias(): boolean {
        return this.mightBeTypedefOrTypeAlias()
            && /\busing\b/.test(this.parsableText) && this.parsableText.includes('=');
    }

    async isPrimitive(resolveTypes: boolean): Promise<boolean> {
        const resolveThisType = async (offset: number): Promise<boolean> => {
            const locations = await this.document.findDefinitions(this.document.positionAt(offset));

            if (locations.length > 0) {
                const typeFile = new SourceFile(locations[0].uri);
                const typeSymbol = await typeFile.getSymbol(locations[0].range.start);

                if (typeSymbol?.isEnum()) {
                    return true;
                } else if (typeSymbol?.mightBeTypedefOrTypeAlias()) {
                    const typeDoc = await typeFile.openDocument();
                    const typeCSymbol = new CSymbol(typeSymbol, typeDoc);
                    return typeCSymbol.isPrimitive(true);
                }
            }

            return false;
        };

        if (this.isVariable()) {
            const leadingText = this.parsableLeadingText;
            if (parse.matchesPrimitiveType(leadingText)) {
                return true;
            } else if (!resolveTypes) {
                return false;
            }

            const type = leadingText.replace(/\b(static|const|constexpr|inline|mutable)\b/g, parse.masker);
            const index = type.search(re_scopeResolvedIdentifier);
            if (index !== -1) {
                return resolveThisType(this.startOffset() + index);
            }
        } else if (this.isTypedef()) {
            if (parse.matchesPrimitiveType(this.parsableText)) {
                return true;
            } else if (/\b(struct|class|(<(>(?=>)|[^>])*>))\b/.test(this.parsableText)) {
                return false;
            } else if (!resolveTypes) {
                return false;
            }

            const maskedText = this.parsableText.replace(/\b(typedef|const)\b/g, parse.masker);
            const index = maskedText.search(re_scopeResolvedIdentifier);
            if (index !== -1) {
                return resolveThisType(this.startOffset() + index);
            }
        } else if (this.isTypeAlias()) {
            if (parse.matchesPrimitiveType(this.parsableText)) {
                return true;
            } else if (/\b(struct|class|(<(>(?=>)|[^>])*>))\b/.test(this.parsableText)) {
                return false;
            } else if (!resolveTypes) {
                return false;
            }

            const indexOfEquals = this.parsableText.indexOf('=');
            if (indexOfEquals === -1) {
                return false;
            }

            const type = this.parsableText.substring(indexOfEquals + 1);
            const index = type.search(re_scopeResolvedIdentifier);
            if (index !== -1) {
                return resolveThisType(this.startOffset() + index);
            }
        }

        return false;
    }

    async getDefinitionForTargetPosition(
        targetDoc: SourceDocument,
        position: vscode.Position,
        declarationSymbol?: CSymbol,
        checkForInline?: boolean
    ): Promise<string> {
        const bodyRange = new vscode.Range(this.declarationEnd(), this.range.end);
        const bodyText = this.document.getText(bodyRange).replace(parse.getIndentationRegExp(this), '');
        const scopeString = await declarationSymbol?.scopeString(targetDoc, position);

        let comment = '';
        if (cfg.alwaysMoveComments(this.uri)) {
            comment = this.document.getText(new vscode.Range(this.leadingCommentStart, this.trueStart));
            comment = comment.replace(parse.getIndentationRegExp(this), '');
        }

        // This CSymbol is a definition, but it can be treated as a declaration for the purposes of this function.
        const declaration = await this.formatDeclaration(targetDoc, position, scopeString, checkForInline);
        return comment + declaration + bodyText;
    }

    async getDeclarationForTargetPosition(targetDoc: SourceDocument, position: vscode.Position): Promise<string> {
        return (await this.formatDeclaration(targetDoc, position)) + ';';
    }

    /**
     * Formats this function declaration for use as a definition (without curly braces).
     */
    async newFunctionDefinition(targetDoc: SourceDocument, position: vscode.Position): Promise<string> {
        if (!this.isFunctionDeclaration()) {
            return '';
        }
        return this.formatDeclaration(targetDoc, position, undefined, true);
    }

    private async formatDeclaration(
        targetDoc: SourceDocument,
        position: vscode.Position,
        scopeString?: string,
        checkForInline?: boolean
    ): Promise<string> {
        if (scopeString === undefined) {
            scopeString = await this.scopeString(targetDoc, position);
        }

        const declarationStart = this.declarationStart();
        const declarationRange = new vscode.Range(declarationStart, this.declarationEnd());
        const declaration = this.document.getText(declarationRange).replace(/;$/, '');
        let maskedDeclaration = parse.maskNonSourceText(declaration);
        maskedDeclaration = parse.maskParentheses(maskedDeclaration);

        // const nameEndIndex =
        //         this.document.offsetAt(this.selectionRange.end) - this.document.offsetAt(declarationStart);
        const paramStartIndex = maskedDeclaration.indexOf('(');
        const paramEndIndex = maskedDeclaration.lastIndexOf(')');
        if (paramStartIndex === -1 || paramEndIndex === -1) {
            vscode.window.showErrorMessage("Failed to parse (parenthesis)")
            return ''; //dumb early return
        }
        const parameters = parse.stripDefaultValues(declaration.substring(paramStartIndex + 1, paramEndIndex));
        const paramStart = this.document.positionAt(this.document.offsetAt(declarationStart) + paramStartIndex);
        const nameToParamRange = new vscode.Range(this.selectionRange.start, paramStart);

        const inlineSpecifier =
            ((!this.parent || !util.containsExclusive(this.parent.range, position))
            && (this.document.fileName === targetDoc.fileName || targetDoc.isHeader())
            && checkForInline && !this.isInline() && !this.isConstexpr() && !this.isConsteval())
                ? 'inline '
                : '';

        // Intelligently align the definition in the case of a multi-line declaration.
        const scopeStringStart = this.scopeStringStart();
        let leadingText = this.document.getText(new vscode.Range(declarationStart, scopeStringStart));
        const oldScopeString = this.document.getText(new vscode.Range(scopeStringStart, this.selectionRange.start));
        const line = this.document.lineAt(this.range.start);
        const leadingIndent = line.text.substring(0, line.firstNonWhitespaceCharacterIndex).length;
        const leadingLines = leadingText.split(this.document.endOfLine);
        const alignLength = leadingLines[leadingLines.length - 1].trimStart().length;
        const newLineAlignment = leadingIndent + alignLength + oldScopeString.length;
        const re_newLineAlignment =
                new RegExp('^' + ' '.repeat(newLineAlignment), 'gm');
        leadingText = leadingText.replace(/\b(virtual|static|explicit|friend)\b\s*/g, '');
        if (!targetDoc.isHeader() || !checkForInline) {
            leadingText = leadingText.replace(/\binline\b\s*/, '');
        }
        leadingText = leadingText.replace(parse.getIndentationRegExp(this), '');
        let definition = this.document.getText(nameToParamRange)
                + '(' + parameters + ')' + declaration.substring(paramEndIndex + 1);

        const eol = targetDoc.endOfLine;
        const newLeadingLines = leadingText.split(eol);
        const newAlignLength = newLeadingLines[newLeadingLines.length - 1].length;
        const inlineSpecifierAlignment = newLeadingLines.length === 1 ? inlineSpecifier.length : 0;
        if (newLineAlignment) {
            definition = definition.replace(
                    re_newLineAlignment, ' '.repeat(newAlignLength + inlineSpecifierAlignment + scopeString.length));
        }
        definition = this.combinedTemplateStatements(true, eol)
                + inlineSpecifier + leadingText + scopeString + definition;
        return definition.replace(/\s*\b(override|final)\b/g, '');
    }

    newFunctionDeclaration(): string {
        if (!this.isFunctionDefinition()) {
            return '';
        }
        return this.document.getText(new vscode.Range(this.trueStart, this.declarationEnd())).trimEnd() + ';';
    }

    combineDefinition(definition: CSymbol): string {
        const body = definition.document.getText(new vscode.Range(definition.declarationEnd(), definition.range.end));
        const re_oldIndentation = parse.getIndentationRegExp(definition);
        const line = this.document.lineAt(this.range.start);
        const newIndentation = line.text.substring(0, line.firstNonWhitespaceCharacterIndex);

        // If this CSymbol (declaration) doesn't have a comment, then we want to pull the comment from the definition.
        if (!this.hasLeadingComment && definition.hasLeadingComment) {
            const leadingCommentRange = new vscode.Range(definition.leadingCommentStart, definition.trueStart);
            const leadingComment = definition.document.getText(leadingCommentRange);
            return leadingComment.replace(re_oldIndentation, '').replace(/\n(?!$)/gm, '\n' + newIndentation)
                    + newIndentation + this.fullText().replace(/(\s*;)*$/, '')
                    + body.replace(re_oldIndentation, '').replace(/\n(?!$)/gm, '\n' + newIndentation);
        }

        return this.fullText().replace(/\s*;$/, '')
                + body.replace(re_oldIndentation, '').replace(/\n(?!$)/gm, '\n' + newIndentation);
    }

    /**
     * Finds the beginning of template statement(s) preceding this symbol since clangd and ccls
     * don't include template statements in provided DocumentSymbol ranges.
     * For nested namespaces (namespace unqualified::nested), this finds the beginning of the
     * unqualified namespace statement.
     */
    get trueStart(): vscode.Position {
        if (this._trueStart) {
            return this._trueStart;
        }

        const before = new vscode.Range(new vscode.Position(0, 0), this.range.start);
        let maskedText = parse.maskComments(this.document.getText(before), false);

        if (this.isNamespace()) {
            const namespaceStartOffset = maskedText.search(
                    /\b(inline\s*)?namespace\s*[\w_][\w\d_]*(\s*::\s*(inline\s*)?[\w_][\w\d_]*)*(\s*::\s*)?$/);
            if (namespaceStartOffset === -1) {
                this._trueStart = this.range.start;
                return this._trueStart;
            }

            return this._trueStart = this.document.positionAt(namespaceStartOffset);
        }

        maskedText = parse.maskAngleBrackets(maskedText).trimEnd();
        if (!maskedText.endsWith('>')) {
            return this._trueStart = this.range.start;
        }

        const templateOffset = maskedText.search(/\b(template\s*<\s*>\s*)$/);
        if (templateOffset === -1) {
            return this._trueStart = this.range.start;
        }

        return this._trueStart = this.document.positionAt(templateOffset);
    }

    /**
     * Only relevant to class-types and enums which can have trailing
     * instance declarations and initializations. Returns the position
     * past the final semi-colon of the class-type/enum definition.
     */
    get trueEnd(): vscode.Position {
        if (this._trueEnd) {
            return this._trueEnd;
        }

        if (this.parsableText.endsWith(';') || this.isNamespace() || this.isFunctionDefinition()) {
            return this._trueEnd = this.range.end;
        }

        if (this.isClassType() || this.isEnum()) {
            const end = this.document.lineAt(this.document.lineCount - 1).range.end;
            const maskedText = parse.maskNonSourceText(this.document.getText(new vscode.Range(this.range.end, end)));
            const indexOfSemiColon = maskedText.indexOf(';');
            if (indexOfSemiColon !== -1) {
                return this._trueEnd = this.document.positionAt(this.endOffset() + indexOfSemiColon + 1);
            }
        }

        return this._trueEnd = this.range.end;
    }

    declarationStart(): vscode.Position {
        if (!this.parsableLeadingText.startsWith('template')) {
            return this.range.start;
        }

        const maskedLeadingText = parse.maskAngleBrackets(this.parsableLeadingText);
        const templateStatementsMatch = maskedLeadingText.match(/^(template(\s*<\s*>)?\s*)*/);
        if (!templateStatementsMatch || templateStatementsMatch.length === 0) {
            return this.range.start;
        }

        return this.document.positionAt(this.startOffset() + templateStatementsMatch[0].length);
    }

    declarationEnd(): vscode.Position {
        const maskedText = parse.maskParentheses(this.parsableText);
        const startOffset = this.startOffset();
        const nameEndIndex = this.document.offsetAt(this.selectionRange.end) - startOffset;
        const bodyStartIndex = maskedText.substring(nameEndIndex).search(/\s*{|\s*;$/);
        if (bodyStartIndex === -1) {
            return this.range.end;
        }

        if (!this.isConstructor()) {
            return this.document.positionAt(startOffset + nameEndIndex + bodyStartIndex);
        }

        // Get the start of the constructor's member initializer list, if one is present.
        const initializerIndex = maskedText.substring(nameEndIndex, bodyStartIndex + nameEndIndex).search(/\s*:(?!:)/);
        if (initializerIndex === -1) {
            return this.document.positionAt(startOffset + nameEndIndex + bodyStartIndex);
        }
        return this.document.positionAt(startOffset + nameEndIndex + initializerIndex);
    }

    bodyStart(): vscode.Position {
        const maskedText = parse.maskBraces(parse.maskParentheses(this.parsableText));
        const bodyStartIndex = maskedText.lastIndexOf('{');
        if (bodyStartIndex === -1) {
            return this.range.end;
        }

        return this.document.positionAt(this.startOffset() + bodyStartIndex + 1);
    }

    bodyEnd(): vscode.Position {
        const bodyEndIndex = this.parsableText.lastIndexOf('}');
        if (bodyEndIndex === -1) {
            return this.range.end;
        }

        return this.document.positionAt(this.startOffset() + bodyEndIndex);
    }

    scopeStringStart(): vscode.Position {
        // FIXME: This function does not work with C++20's 'namespace foo::inline bar {}' syntax.
        const trimmedLeadingText = parse.maskAngleBrackets(this.parsableLeadingText.trimEnd(), false);
        if (!trimmedLeadingText.endsWith('::')) {
            return this.selectionRange.start;
        }

        let lastMatch: RegExpMatchArray | undefined;
        for (const match of trimmedLeadingText.matchAll(re_beginningOfScopeString)) {
            lastMatch = match;
        }
        if (lastMatch?.index === undefined) {
            return this.selectionRange.start;
        }

        return this.document.positionAt(this.startOffset() + lastMatch.index);
    }

    get hasLeadingComment(): boolean {
        return !this.leadingCommentStart.isEqual(this.trueStart);
    }

    get leadingCommentStart(): vscode.Position {
        if (this._leadingCommentStart) {
            return this._leadingCommentStart;
        }

        const before = new vscode.Range(new vscode.Position(0, 0), this.trueStart);
        const re_trimEnd = new RegExp(`[ \\t]*${this.document.endOfLine}?[ \\t]*$`);
        const maskedText = parse.maskComments(this.document.getText(before)).replace(re_trimEnd, '');
        if (!maskedText.endsWith('//') && !maskedText.endsWith('*/')) {
            return this._leadingCommentStart = this.trueStart;
        }

        if (maskedText.endsWith('*/')) {
            const commentStartOffset = maskedText.lastIndexOf('/*');
            if (commentStartOffset !== -1) {
                return this._leadingCommentStart = this.document.positionAt(commentStartOffset);
            }
            return this._leadingCommentStart = this.trueStart;
        }

        for (let i = this.trueStart.line - 1; i >= 0; --i) {
            const line = this.document.lineAt(i);
            if (!line.text.trimStart().startsWith('//')) {
                const indexOfComment = this.document.lineAt(i + 1).text.indexOf('//');
                if (indexOfComment === -1) {
                    break;  // This shouldn't happen, but just in-case.
                }
                return this._leadingCommentStart = new vscode.Position(i + 1, indexOfComment);
            }
        }

        return this._leadingCommentStart = this.trueStart;
    }

    trailingCommentEnd(): vscode.Position {
        const documentEnd = this.document.lineAt(this.document.lineCount - 1).range.end;
        const documentTrailingText = this.document.getText(new vscode.Range(this.trueEnd, documentEnd));

        if (/[ \t]*\/\//.test(documentTrailingText)) {
            return this.document.lineAt(this.trueEnd).range.end;
        }

        if (/[ \t]*\/\*/.test(documentTrailingText)) {
            const maskedTrailingText = parse.maskComments(documentTrailingText);
            const commentEndIndex = maskedTrailingText.indexOf('*/');
            if (commentEndIndex !== -1) {
                return this.document.positionAt(this.document.offsetAt(this.trueEnd) + commentEndIndex + 2);
            }
        }

        return this.trueEnd;
    }

    private getPositionForNewChild(): ProposedPosition {
        if (this.children.length > 0) {
            const lastChild = new CSymbol(this.children[this.children.length - 1], this.document);
            return new ProposedPosition(lastChild.trailingCommentEnd(), {
                relativeTo: lastChild.range,
                after: true
            });
        }

        return new ProposedPosition(this.bodyStart(), {
            after: true,
            nextTo: true,
            indent: true
        });
    }
}

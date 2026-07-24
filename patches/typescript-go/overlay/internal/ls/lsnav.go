package ls

// LS navigation payloads for the NAPI bridge (TNB issue #12): stock-services-shaped
// quickinfo / references / definitionAndBoundSpan results computed Go-side, so the
// tsserver path fetches them with one arena call instead of composing them from
// dozens of inner checker RPCs. Every function mirrors its Strada counterpart
// (services.ts getQuickInfoAtPosition, findAllReferences.ts findReferencedSymbols,
// goToDefinition.ts getDefinitionAndBoundSpan) — parity with stock is the contract.

import (
	"context"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/astnav"
	"github.com/microsoft/typescript-go/internal/checker"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/ls/lsutil"
	"github.com/microsoft/typescript-go/internal/lsp/lsproto"
	"github.com/microsoft/typescript-go/internal/scanner"
	"github.com/microsoft/typescript-go/internal/tspath"
)

// DisplayPart mirrors Strada's SymbolDisplayPart { text, kind }.
type DisplayPart struct {
	Text string
	Kind string
}

// JSDocTagPayload mirrors Strada's JSDocTagInfo { name, text? } with the tag text
// as display parts (segmented like stock's getCommentDisplayParts).
type JSDocTagPayload struct {
	Name string
	Text []DisplayPart
}

// QuickInfoPayload mirrors Strada's QuickInfo (services/types.ts), with displayParts
// pre-flattened into DisplayString (the session flattens parts unconditionally, so
// part segmentation is not observable downstream).
type QuickInfoPayload struct {
	Kind                      string
	KindModifiers             string
	Span                      core.TextRange
	DisplayString             string
	Documentation             []DisplayPart
	Tags                      []JSDocTagPayload
	CanIncreaseVerbosityLevel *bool
}

// DocumentSpanPayload mirrors Strada's DocumentSpan: absolute UTF-8 span in a file,
// converted to UTF-16 by the API layer.
type DocumentSpanPayload struct {
	FileName       string
	TextSpan       core.TextRange
	ContextSpan    core.TextRange
	HasContextSpan bool
}

// DefinitionInfoPayload mirrors Strada's DefinitionInfo (and
// ReferencedSymbolDefinitionInfo when HasDisplayParts is set). Nil pointers round
// trip stock's `undefined`.
type DefinitionInfoPayload struct {
	DocumentSpanPayload
	Kind                  string
	Name                  string
	ContainerKind         *string // stock sets containerKind: undefined!
	ContainerName         *string
	DisplayParts          []DisplayPart
	HasDisplayParts       bool
	Unverified            *bool
	IsLocal               *bool
	IsAmbient             *bool
	FailedAliasResolution *bool
}

// ReferenceEntryPayload mirrors Strada's ReferencedSymbolEntry.
type ReferenceEntryPayload struct {
	DocumentSpanPayload
	IsWriteAccess bool
	IsDefinition  *bool
	IsInString    *bool
}

// ReferencedSymbolPayload mirrors Strada's ReferencedSymbol.
type ReferencedSymbolPayload struct {
	Definition *DefinitionInfoPayload
	References []*ReferenceEntryPayload
}

// DefinitionAndBoundSpanPayload mirrors Strada's DefinitionInfoAndBoundSpan.
type DefinitionAndBoundSpanPayload struct {
	Definitions []*DefinitionInfoPayload
	TextSpan    core.TextRange
}

// scriptElementKindString maps lsutil kinds to Strada's ScriptElementKind strings.
// (lsutil's iota order diverges from Strada's declaration order at JsxAttribute —
// never map by index.)
func scriptElementKindString(kind lsutil.ScriptElementKind) string {
	switch kind {
	case lsutil.ScriptElementKindWarning:
		return "warning"
	case lsutil.ScriptElementKindKeyword:
		return "keyword"
	case lsutil.ScriptElementKindScriptElement:
		return "script"
	case lsutil.ScriptElementKindModuleElement:
		return "module"
	case lsutil.ScriptElementKindClassElement:
		return "class"
	case lsutil.ScriptElementKindLocalClassElement:
		return "local class"
	case lsutil.ScriptElementKindInterfaceElement:
		return "interface"
	case lsutil.ScriptElementKindTypeElement:
		return "type"
	case lsutil.ScriptElementKindEnumElement:
		return "enum"
	case lsutil.ScriptElementKindEnumMemberElement:
		return "enum member"
	case lsutil.ScriptElementKindVariableElement:
		return "var"
	case lsutil.ScriptElementKindLocalVariableElement:
		return "local var"
	case lsutil.ScriptElementKindVariableUsingElement:
		return "using"
	case lsutil.ScriptElementKindVariableAwaitUsingElement:
		return "await using"
	case lsutil.ScriptElementKindFunctionElement:
		return "function"
	case lsutil.ScriptElementKindLocalFunctionElement:
		return "local function"
	case lsutil.ScriptElementKindMemberFunctionElement:
		return "method"
	case lsutil.ScriptElementKindMemberGetAccessorElement:
		return "getter"
	case lsutil.ScriptElementKindMemberSetAccessorElement:
		return "setter"
	case lsutil.ScriptElementKindMemberVariableElement:
		return "property"
	case lsutil.ScriptElementKindMemberAccessorVariableElement:
		return "accessor"
	case lsutil.ScriptElementKindConstructorImplementationElement:
		return "constructor"
	case lsutil.ScriptElementKindCallSignatureElement:
		return "call"
	case lsutil.ScriptElementKindIndexSignatureElement:
		return "index"
	case lsutil.ScriptElementKindConstructSignatureElement:
		return "construct"
	case lsutil.ScriptElementKindParameterElement:
		return "parameter"
	case lsutil.ScriptElementKindTypeParameterElement:
		return "type parameter"
	case lsutil.ScriptElementKindPrimitiveType:
		return "primitive type"
	case lsutil.ScriptElementKindLabel:
		return "label"
	case lsutil.ScriptElementKindAlias:
		return "alias"
	case lsutil.ScriptElementKindConstElement:
		return "const"
	case lsutil.ScriptElementKindLetElement:
		return "let"
	case lsutil.ScriptElementKindDirectory:
		return "directory"
	case lsutil.ScriptElementKindExternalModuleName:
		return "external module name"
	case lsutil.ScriptElementKindString:
		return "string"
	case lsutil.ScriptElementKindLink:
		return "link"
	case lsutil.ScriptElementKindLinkName:
		return "link name"
	default:
		return ""
	}
}

// symbolModifiersString mirrors Strada's getSymbolModifiers: joined in stock's
// getNodeModifiers emission order (private, protected, public, static, abstract,
// export, deprecated, ambient, then optional last), NOT lsutil's table order.
func symbolModifiersString(c *checker.Checker, symbol *ast.Symbol) string {
	if symbol == nil {
		return ""
	}
	m := lsutil.GetSymbolModifiers(c, symbol)
	var out []string
	add := func(flag lsutil.ScriptElementKindModifier, name string) {
		if m&flag != 0 {
			out = append(out, name)
		}
	}
	add(lsutil.ScriptElementKindModifierPrivate, "private")
	add(lsutil.ScriptElementKindModifierProtected, "protected")
	add(lsutil.ScriptElementKindModifierPublic, "public")
	add(lsutil.ScriptElementKindModifierStatic, "static")
	add(lsutil.ScriptElementKindModifierAbstract, "abstract")
	add(lsutil.ScriptElementKindModifierExported, "export")
	add(lsutil.ScriptElementKindModifierDeprecated, "deprecated")
	add(lsutil.ScriptElementKindModifierAmbient, "declare")
	add(lsutil.ScriptElementKindModifierOptional, "optional")
	if len(out) == 0 {
		return ""
	}
	result := out[0]
	for _, s := range out[1:] {
		result += "," + s
	}
	return result
}

// docParts joins per-declaration documentation strings the way Strada's
// getJsDocCommentsFromDeclarations segments parts: one "text" part per unique
// declaration comment, "\n" separator parts between.
func docParts(docs []string) []DisplayPart {
	var out []DisplayPart
	for _, d := range docs {
		if d == "" {
			continue
		}
		if len(out) > 0 {
			out = append(out, DisplayPart{Text: "\n", Kind: "text"})
		}
		out = append(out, DisplayPart{Text: d, Kind: "text"})
	}
	return out
}

// documentationCommentParts mirrors symbol.getDocumentationComment(checker):
// per-declaration comments, deduped, "\n"-joined.
func (l *LanguageService) documentationCommentParts(c *checker.Checker, symbol *ast.Symbol) []DisplayPart {
	if symbol == nil {
		return nil
	}
	var docs []string
	seen := map[*ast.Node]bool{}
	for _, decl := range symbol.Declarations {
		if decl == nil || seen[decl] {
			continue
		}
		seen[decl] = true
		if doc := l.getDocumentationFromDeclaration(c, symbol, decl, decl, lsproto.MarkupKindPlainText, true /*commentOnly*/); doc != "" && !slicesContains(docs, doc) {
			docs = append(docs, doc)
		}
	}
	return docParts(docs)
}

func slicesContains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// jsDocTagPayloads mirrors symbol.getJsDocTags(checker) (getJsDocTagsFromDeclarations:
// unique declarations, typedef-skip unless param/return); each tag's text is
// segmented per stock's getCommentDisplayParts (link segments stay flattened).
func (l *LanguageService) jsDocTagPayloads(symbol *ast.Symbol) []JSDocTagPayload {
	if symbol == nil {
		return nil
	}
	var out []JSDocTagPayload
	seen := map[*ast.Node]bool{}
	for _, decl := range symbol.Declarations {
		if decl == nil || seen[decl] {
			continue
		}
		seen[decl] = true
		tags := declarationJSDocTags(decl)
		hasTypedef := core.Some(tags, func(t *ast.Node) bool {
			return t.Kind == ast.KindJSDocTypedefTag || t.Kind == ast.KindJSDocCallbackTag
		})
		hasParamOrReturn := core.Some(tags, func(t *ast.Node) bool {
			return t.Kind == ast.KindJSDocParameterTag || t.Kind == ast.KindJSDocReturnTag
		})
		if hasTypedef && !hasParamOrReturn {
			continue
		}
		for _, tag := range tags {
			out = append(out, JSDocTagPayload{Name: tag.TagName().Text(), Text: jsDocTagTextParts(tag)})
		}
	}
	return out
}

// jsDocTagTextParts mirrors Strada's getCommentDisplayParts.
func jsDocTagTextParts(tag *ast.Node) []DisplayPart {
	comment := scanner.GetTextOfJSDocComment(tag.CommentList())
	var commentParts []DisplayPart
	if comment != "" {
		commentParts = []DisplayPart{{Text: comment, Kind: "text"}}
	}
	addComment := func(s string, nameKind string) []DisplayPart {
		if comment == "" {
			return []DisplayPart{{Text: s, Kind: "text"}}
		}
		if s == "http" || s == "https" {
			return append([]DisplayPart{{Text: s, Kind: "text"}}, commentParts...)
		}
		return append([]DisplayPart{{Text: s, Kind: nameKind}, {Text: " ", Kind: "space"}}, commentParts...)
	}
	switch tag.Kind {
	case ast.KindJSDocParameterTag, ast.KindJSDocPropertyTag:
		if name := tag.Name(); name != nil {
			kind := "parameterName"
			if tag.Kind == ast.KindJSDocPropertyTag {
				kind = "propertyName"
			}
			return addComment(scanner.GetTextOfNode(name), kind)
		}
		return commentParts
	case ast.KindJSDocTypedefTag, ast.KindJSDocCallbackTag:
		if name := tag.Name(); name != nil {
			return addComment(scanner.GetTextOfNode(name), "aliasName")
		}
		return commentParts
	case ast.KindJSDocSeeTag:
		if ne := tag.AsJSDocSeeTag().NameExpression; ne != nil {
			return addComment(scanner.GetTextOfNode(ne), "text")
		}
		return commentParts
	case ast.KindJSDocThrowsTag:
		if te := tag.AsJSDocThrowsTag().TypeExpression; te != nil {
			return addComment(scanner.GetTextOfNode(te), "text")
		}
		return commentParts
	case ast.KindJSDocImplementsTag:
		return addComment(scanner.GetTextOfNode(tag.AsJSDocImplementsTag().ClassName), "text")
	case ast.KindJSDocAugmentsTag:
		return addComment(scanner.GetTextOfNode(tag.AsJSDocAugmentsTag().ClassName), "text")
	case ast.KindJSDocTypeTag:
		return addComment(scanner.GetTextOfNode(tag.AsJSDocTypeTag().TypeExpression), "text")
	case ast.KindJSDocSatisfiesTag:
		return addComment(scanner.GetTextOfNode(tag.AsJSDocSatisfiesTag().TypeExpression), "text")
	case ast.KindJSDocTemplateTag:
		templateTag := tag.AsJSDocTemplateTag()
		var out []DisplayPart
		if templateTag.Constraint != nil {
			out = append(out, DisplayPart{Text: scanner.GetTextOfNode(templateTag.Constraint), Kind: "text"})
		}
		if templateTag.TypeParameters != nil {
			if len(out) > 0 {
				out = append(out, DisplayPart{Text: " ", Kind: "space"})
			}
			for i, tp := range templateTag.TypeParameters.Nodes {
				if i != 0 {
					out = append(out, DisplayPart{Text: ",", Kind: "punctuation"}, DisplayPart{Text: " ", Kind: "space"})
				}
				out = append(out, DisplayPart{Text: scanner.GetTextOfNode(tp), Kind: "typeParameterName"})
			}
		}
		if comment != "" {
			if len(out) > 0 {
				out = append(out, DisplayPart{Text: " ", Kind: "space"})
			}
			out = append(out, commentParts...)
		}
		return out
	default:
		return commentParts
	}
}

// quickInfoDocumentation mirrors the stock display worker's documentation priority
// chain (signature → declaration → alias), comment-only so tags stay structured.
func (l *LanguageService) quickInfoDocumentation(c *checker.Checker, symbol *ast.Symbol, node *ast.Node, declaration *ast.Node) []DisplayPart {
	if node != nil {
		if call := getCallOrNewExpression(node); call != nil {
			if sig := c.GetResolvedSignature(call); sig != nil && sig.Declaration() != nil &&
				(ast.IsCallSignatureDeclaration(sig.Declaration()) || ast.IsConstructSignatureDeclaration(sig.Declaration())) {
				if doc := l.getDocumentationFromDeclaration(c, symbol, sig.Declaration(), node, lsproto.MarkupKindPlainText, true /*commentOnly*/); doc != "" {
					return []DisplayPart{{Text: doc, Kind: "text"}}
				}
			}
		}
	}
	if declaration != nil {
		if doc := l.getDocumentationFromDeclaration(c, symbol, declaration, node, lsproto.MarkupKindPlainText, true /*commentOnly*/); doc != "" {
			return []DisplayPart{{Text: doc, Kind: "text"}}
		}
	}
	if symbol != nil && symbol.Flags&ast.SymbolFlagsAlias != 0 {
		if aliased := c.GetAliasedSymbol(symbol); aliased != nil && aliased != c.GetUnknownSymbol() {
			candidates := []*ast.Symbol{aliased}
			if aliased.ExportSymbol != nil {
				candidates = append(candidates, aliased.ExportSymbol)
			}
			for _, candidate := range candidates {
				decl := core.OrElse(candidate.ValueDeclaration, core.FirstOrNil(candidate.Declarations))
				if decl == nil {
					continue
				}
				if doc := l.getDocumentationFromDeclaration(c, candidate, decl, node, lsproto.MarkupKindPlainText, true /*commentOnly*/); doc != "" {
					return []DisplayPart{{Text: doc, Kind: "text"}}
				}
			}
		}
	}
	return nil
}

// GetQuickInfoForAPI mirrors services.ts getQuickInfoAtPosition.
// maximumHoverLength <= 0 means "undefined" (stock defaults to 500);
// verbosityLevel < 0 means "undefined".
func (l *LanguageService) GetQuickInfoForAPI(ctx context.Context, file *ast.SourceFile, position int, maximumHoverLength int, verbosityLevel int) *QuickInfoPayload {
	node := astnav.GetTouchingPropertyName(file, position)
	if ast.IsSourceFile(node) {
		// Avoid giving quickInfo for the sourceFile as a whole.
		return nil
	}
	c, done := l.program.GetTypeCheckerForFile(ctx, file)
	defer done()

	nodeForQuickInfo := getNodeForQuickInfo(node)
	symbol := getSymbolAtLocationForQuickInfo(c, nodeForQuickInfo)
	span := plainSpanOfNode(nodeForQuickInfo, file)

	maxTruncLen := maximumHoverLength
	if maxTruncLen <= 0 {
		maxTruncLen = 500
	}
	level := verbosityLevel
	if level < 0 {
		level = 0
	}

	if symbol == nil || c.IsUnknownSymbol(symbol) {
		// Stock's type path (no symbol / unknown symbol).
		if !shouldGetType(nodeForQuickInfo) {
			return nil
		}
		t := c.GetTypeAtLocation(nodeForQuickInfo)
		if t == nil {
			return nil
		}
		vc := &checker.VerbosityContext{Level: level, MaxTruncationLength: maxTruncLen}
		display := c.TypeToStringEx(t, getContainerNode(nodeForQuickInfo), typeFormatFlags, vc)
		var canIncrease *bool
		if verbosityLevel >= 0 {
			v := vc.CanIncreaseVerbosity && !vc.Truncated
			canIncrease = &v
		}
		return &QuickInfoPayload{
			Kind:                      "",
			KindModifiers:             "",
			Span:                      span,
			DisplayString:             display,
			Documentation:             l.documentationCommentParts(c, t.Symbol()),
			Tags:                      l.jsDocTagPayloads(t.Symbol()),
			CanIncreaseVerbosityLevel: canIncrease,
		}
	}

	vc := &checker.VerbosityContext{Level: level, MaxTruncationLength: maxTruncLen}
	info := getQuickInfoAndDeclarationAtLocation(c, symbol, nodeForQuickInfo, vc, false /*vsCapability*/, getMeaningFromLocation(nodeForQuickInfo))
	display := info.displayParts.String()
	var canIncrease *bool
	if verbosityLevel >= 0 {
		v := vc.CanIncreaseVerbosity && !vc.Truncated
		canIncrease = &v
	}
	return &QuickInfoPayload{
		Kind:                      symbolKindString(c, symbol, nodeForQuickInfo),
		KindModifiers:             symbolModifiersString(c, symbol),
		Span:                      span,
		DisplayString:             display,
		Documentation:             l.quickInfoDocumentation(c, symbol, nodeForQuickInfo, info.declaration),
		Tags:                      l.jsDocTagPayloads(symbol),
		CanIncreaseVerbosityLevel: canIncrease,
	}
}

// textSpanOfNode mirrors Strada FAR's getTextSpan (string literals shrink by the quotes).
func textSpanOfNode(node *ast.Node, sourceFile *ast.SourceFile) core.TextRange {
	return getRangeOfNode(node, sourceFile, nil)
}

// plainSpanOfNode mirrors Strada's createTextSpanFromNode (no literal shrink):
// quickinfo spans, definition bound spans, and goToDefinition's DefinitionInfo spans.
func plainSpanOfNode(node *ast.Node, sourceFile *ast.SourceFile) core.TextRange {
	return core.NewTextRange(scanner.GetTokenPosOfNode(node, sourceFile, false /*includeJsDoc*/), node.End())
}

// contextSpanOf mirrors Strada's toContextSpan: present only when a context node
// exists and its range differs from the text span.
func contextSpanOf(textSpan core.TextRange, sourceFile *ast.SourceFile, context *ast.Node) (core.TextRange, bool) {
	if context == nil {
		return core.TextRange{}, false
	}
	r := toContextRange(&textSpan, sourceFile, context)
	if r == nil {
		return core.TextRange{}, false
	}
	return *r, true
}

func docSpanWithContext(sourceFile *ast.SourceFile, span core.TextRange, context *ast.Node) DocumentSpanPayload {
	out := DocumentSpanPayload{FileName: sourceFile.FileName(), TextSpan: span}
	if cs, ok := contextSpanOf(span, sourceFile, context); ok {
		out.ContextSpan = cs
		out.HasContextSpan = true
	}
	return out
}

func documentSpanOfNode(node *ast.Node, context *ast.Node) DocumentSpanPayload {
	sourceFile := ast.GetSourceFileOfNode(node)
	return docSpanWithContext(sourceFile, textSpanOfNode(node, sourceFile), context)
}

// definitionDisplayParts runs the classified writer (vsCapability) so definition
// displayParts carry part kinds. Only consumed by references-full.
func (l *LanguageService) definitionDisplayParts(ctx context.Context, symbol *ast.Symbol, originalNode *ast.Node) (out []DisplayPart) {
	// The display pipeline (GetTypeOfSymbolAtLocation and friends) can panic on
	// synthetic symbols whose type never materialized (volar component-meta
	// corpus) — degrade to no parts instead of taking down the session. The
	// simplified references response never reads displayParts.
	defer func() {
		if recover() != nil {
			out = nil
		}
	}()
	element := l.getDefinitionKindAndDisplayParts(ctx, symbol, originalNode, true /*vsCapability*/)
	if element == nil {
		return nil
	}
	out = make([]DisplayPart, 0, len(element.Runs))
	for _, run := range element.Runs {
		out = append(out, DisplayPart{Text: run.Text, Kind: classificationToPartKind(lsproto.ClassificationTypeName(run.ClassificationTypeName))})
	}
	return out
}

// symbolKindString guards the kind computation against the same class of
// display-pipeline panics (synthetic/unmaterialized symbols), degrading to
// Strada's unknown kind ("").
func symbolKindString(c *checker.Checker, symbol *ast.Symbol, location *ast.Node) (kind string) {
	defer func() {
		if recover() != nil {
			kind = ""
		}
	}()
	return scriptElementKindString(lsutil.GetSymbolKind(c, symbol, location))
}

// classificationToPartKind maps VS classification names onto Strada
// SymbolDisplayPart kind strings (best-effort; simplified responses never read these).
func classificationToPartKind(c lsproto.ClassificationTypeName) string {
	switch c {
	case lsproto.ClassificationTypeNameKeyword:
		return "keyword"
	case lsproto.ClassificationTypeNameClassName:
		return "className"
	case lsproto.ClassificationTypeNameInterfaceName:
		return "interfaceName"
	case lsproto.ClassificationTypeNameEnumName:
		return "enumName"
	case lsproto.ClassificationTypeNameModuleName:
		return "moduleName"
	case lsproto.ClassificationTypeNameMethodName:
		return "methodName"
	case lsproto.ClassificationTypeNamePropertyName, lsproto.ClassificationTypeNameFieldName:
		return "propertyName"
	case lsproto.ClassificationTypeNameLocalName:
		return "localName"
	case lsproto.ClassificationTypeNameParameterName:
		return "parameterName"
	case lsproto.ClassificationTypeNameTypeParameterName:
		return "typeParameterName"
	case lsproto.ClassificationTypeNameString:
		return "stringLiteral"
	case lsproto.ClassificationTypeNameOperator:
		return "operator"
	case lsproto.ClassificationTypeNamePunctuation:
		return "punctuation"
	case lsproto.ClassificationTypeNameWhiteSpace:
		return "space"
	default:
		return "text"
	}
}

// definitionInfoForFAR mirrors Strada's definitionToReferencedSymbolDefinitionInfo.
func (l *LanguageService) definitionInfoForFAR(ctx context.Context, c *checker.Checker, def *Definition, originalNode *ast.Node) *DefinitionInfoPayload {
	if def == nil {
		return nil
	}
	switch def.Kind {
	case definitionKindSymbol:
		symbol := def.symbol
		if symbol == nil {
			return nil
		}
		var node *ast.Node
		var declaration *ast.Node
		if len(symbol.Declarations) > 0 {
			declaration = symbol.Declarations[0]
			node = core.OrElse(ast.GetNameOfDeclaration(declaration), declaration)
		} else {
			node = originalNode
		}
		spanNode := node
		if ast.IsComputedPropertyName(node) {
			spanNode = node.Expression()
		}
		sourceFile := ast.GetSourceFileOfNode(spanNode)
		span := textSpanOfNode(spanNode, sourceFile)
		var context *ast.Node
		if declaration != nil {
			context = getContextNode(declaration)
		}
		return &DefinitionInfoPayload{
			DocumentSpanPayload: docSpanWithContext(sourceFile, span, context),
			Kind:                symbolKindString(c, symbol, originalNode),
			Name:                c.SymbolToString(symbol),
			ContainerKind:       strPtr(""),
			ContainerName:       strPtr(""),
			DisplayParts:        l.definitionDisplayParts(ctx, symbol, originalNode),
			HasDisplayParts:     true,
		}
	case definitionKindLabel:
		node := def.node
		if node == nil {
			return nil
		}
		return &DefinitionInfoPayload{
			DocumentSpanPayload: documentSpanOfNode(node, nil),
			Kind:                "label",
			Name:                node.Text(),
			ContainerKind:       strPtr(""),
			ContainerName:       strPtr(""),
			DisplayParts:        []DisplayPart{{Text: node.Text(), Kind: "text"}},
			HasDisplayParts:     true,
		}
	case definitionKindKeyword:
		node := def.node
		if node == nil {
			return nil
		}
		name := scanner.TokenToString(node.Kind)
		return &DefinitionInfoPayload{
			DocumentSpanPayload: documentSpanOfNode(node, nil),
			Kind:                "keyword",
			Name:                name,
			ContainerKind:       strPtr(""),
			ContainerName:       strPtr(""),
			DisplayParts:        []DisplayPart{{Text: name, Kind: "keyword"}},
			HasDisplayParts:     true,
		}
	case definitionKindThis:
		node := def.node
		if node == nil {
			return nil
		}
		parts := []DisplayPart{{Text: "this", Kind: "text"}}
		if symbol := def.symbol; symbol != nil {
			if classified := l.definitionDisplayParts(ctx, symbol, node); classified != nil {
				parts = classified
			}
		}
		return &DefinitionInfoPayload{
			DocumentSpanPayload: documentSpanOfNode(node, nil),
			Kind:                "var",
			Name:                "this",
			ContainerKind:       strPtr(""),
			ContainerName:       strPtr(""),
			DisplayParts:        parts,
			HasDisplayParts:     true,
		}
	case definitionKindString:
		node := def.node
		if node == nil {
			return nil
		}
		return &DefinitionInfoPayload{
			DocumentSpanPayload: documentSpanOfNode(node, nil),
			Kind:                "var",
			Name:                node.Text(),
			ContainerKind:       strPtr(""),
			ContainerName:       strPtr(""),
			DisplayParts:        []DisplayPart{{Text: scanner.GetTextOfNode(node), Kind: "stringLiteral"}},
			HasDisplayParts:     true,
		}
	case definitionKindTripleSlashReference:
		ref := def.tripleSlashFileRef
		if ref == nil {
			return nil
		}
		fileName := ref.reference.FileName
		return &DefinitionInfoPayload{
			DocumentSpanPayload: DocumentSpanPayload{
				FileName: ref.file.FileName(),
				TextSpan: core.NewTextRange(ref.reference.Pos(), ref.reference.End()),
			},
			Kind:            "string",
			Name:            fileName,
			ContainerKind:   strPtr(""),
			ContainerName:   strPtr(""),
			DisplayParts:    []DisplayPart{{Text: "\"" + fileName + "\"", Kind: "stringLiteral"}},
			HasDisplayParts: true,
		}
	}
	return nil
}

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }

// isDefinitionForReference mirrors Strada FAR's isDefinitionForReference.
func isDefinitionForReference(node *ast.Node) bool {
	return node.Kind == ast.KindDefaultKeyword ||
		ast.GetDeclarationFromName(node) != nil ||
		ast.IsLiteralComputedPropertyDeclarationName(node) ||
		(node.Kind == ast.KindConstructorKeyword && ast.IsConstructorDeclaration(node.Parent))
}

// FindReferencesForAPI mirrors findAllReferences.ts findReferencedSymbols.
// Returns nil when stock returns undefined.
func (l *LanguageService) FindReferencesForAPI(ctx context.Context, file *ast.SourceFile, position int) []*ReferencedSymbolPayload {
	node := astnav.GetTouchingPropertyName(file, position)
	sourceFiles := l.program.GetSourceFiles()
	referencedSymbols := l.GetReferencedSymbolsForNode(ctx, position, node, sourceFiles)
	if len(referencedSymbols) == 0 {
		return nil
	}
	c, done := l.program.GetTypeCheckerForFile(ctx, file)
	defer done()
	// Unless the starting node is a declaration, don't attempt to compute isDefinition.
	adjustedNode := getAdjustedLocation(node, false /*forRename*/, file)
	var symbol *ast.Symbol
	if isDefinitionForReference(adjustedNode) {
		symbol = c.GetSymbolAtLocation(adjustedNode)
	}
	out := make([]*ReferencedSymbolPayload, 0, len(referencedSymbols))
	for _, s := range referencedSymbols {
		if s.definition == nil {
			continue
		}
		definition := l.definitionInfoForFAR(ctx, c, s.definition, node)
		if definition == nil {
			continue
		}
		payload := &ReferencedSymbolPayload{Definition: definition}
		for _, entry := range s.References() {
			payload.References = append(payload.References, referenceEntryForAPI(entry, symbol))
		}
		out = append(out, payload)
	}
	// Stock: mapDefined keeps a (possibly empty) array once referencedSymbols is
	// non-empty — only an empty referencedSymbols set maps to undefined above.
	return out
}

// referenceEntryForAPI mirrors Strada's toReferencedSymbolEntry.
func referenceEntryForAPI(entry *ReferenceEntry, symbol *ast.Symbol) *ReferenceEntryPayload {
	var span DocumentSpanPayload
	if entry.kind == entryKindRange {
		span = DocumentSpanPayload{FileName: entry.fileName, TextSpan: *entry.textRange}
	} else {
		span = documentSpanOfNode(entry.node, entry.context)
	}
	out := &ReferenceEntryPayload{DocumentSpanPayload: span}
	if entry.kind == entryKindRange {
		out.IsWriteAccess = false
	} else {
		out.IsWriteAccess = ast.IsWriteAccessForReference(entry.node)
	}
	if entry.kind == entryKindStringLiteral {
		out.IsInString = boolPtr(true)
	}
	if symbol != nil {
		out.IsDefinition = boolPtr(entry.kind != entryKindRange && isDeclarationOfSymbol(entry.node, symbol))
	}
	return out
}

// GetDefinitionAndBoundSpanForAPI mirrors goToDefinition.ts getDefinitionAndBoundSpan.
// Returns nil when stock returns undefined (no definitions).
func (l *LanguageService) GetDefinitionAndBoundSpanForAPI(ctx context.Context, file *ast.SourceFile, position int) *DefinitionAndBoundSpanPayload {
	reference := getReferenceAtPosition(file, position, l.program)
	var definitions []*DefinitionInfoPayload
	if reference != nil && reference.file != nil {
		if reference.reference != nil {
			// Triple-slash / type-reference / lib-reference definition
			// (getDefinitionInfoForFileReference).
			return &DefinitionAndBoundSpanPayload{
				Definitions: []*DefinitionInfoPayload{{
					DocumentSpanPayload: DocumentSpanPayload{FileName: reference.fileName, TextSpan: core.NewTextRange(0, 0)},
					Kind:                "script",
					Name:                reference.reference.FileName,
					Unverified:          boolPtr(reference.unverified),
				}},
				TextSpan: core.NewTextRange(reference.reference.Pos(), reference.reference.End()),
			}
		}
		// Relative module specifier resolved to a file (stock's synthetic
		// FileReference case): a "script" definition at the target, bound span
		// stays on the specifier node below. tsgo's refInfo flag is inverted
		// for this case — stock's unverified is "resolution produced no
		// verified fileName".
		specNode := astnav.GetTouchingToken(file, position)
		name := ""
		if specNode != nil {
			name = specNode.Text()
		}
		definitions = []*DefinitionInfoPayload{{
			DocumentSpanPayload: DocumentSpanPayload{FileName: reference.fileName, TextSpan: core.NewTextRange(0, 0)},
			Kind:                "script",
			Name:                name,
			IsAmbient:           boolPtr(tspath.IsDeclarationFileName(reference.fileName)),
			Unverified:          boolPtr(!reference.unverified),
		}}
	} else {
		node := astnav.GetTouchingPropertyName(file, position)
		if ast.IsSourceFile(node) {
			return nil
		}
		c, done := l.program.GetTypeCheckerForFile(ctx, file)
		defer done()

		definitions = l.definitionInfosAt(ctx, c, file, node)
		if len(definitions) == 0 {
			return nil
		}
	}

	node := astnav.GetTouchingPropertyName(file, position)
	if ast.IsSourceFile(node) {
		return nil
	}
	return &DefinitionAndBoundSpanPayload{
		Definitions: definitions,
		TextSpan:    plainSpanOfNode(node, file),
	}
}

// definitionInfosAt mirrors getDefinitionAtPosition's case analysis (the
// provideDefinitionWorker flow) with stock's createDefinitionInfo* metadata.
func (l *LanguageService) definitionInfosAt(ctx context.Context, c *checker.Checker, file *ast.SourceFile, node *ast.Node) []*DefinitionInfoPayload {
	if node.Kind == ast.KindOverrideKeyword {
		if sym := getSymbolForOverriddenMember(c, node); sym != nil {
			return mapDecls(sym.Declarations, func(decl *ast.Node) *DefinitionInfoPayload {
				return l.createDefinitionInfo(c, decl, decl.Symbol(), node, nil, nil)
			})
		}
	}

	if ast.IsJumpStatementTarget(node) {
		if label := getTargetLabel(node.Parent, node.Text()); label != nil {
			return []*DefinitionInfoPayload{
				l.createDefinitionInfoFromName(c, label, "label", node.Text(), nil, nil, nil, core.TextRange{}),
			}
		}
	}

	if node.Kind == ast.KindCaseKeyword || node.Kind == ast.KindDefaultKeyword && ast.IsDefaultClause(node.Parent) {
		if stmt := ast.FindAncestor(node.Parent, ast.IsSwitchStatement); stmt != nil {
			sourceFile := ast.GetSourceFileOfNode(stmt)
			// createDefinitionInfoFromSwitch: the switch keyword span, with the
			// header (keyword through the parenthesized expression) as context.
			span := scanner.GetRangeOfTokenAtPosition(sourceFile, stmt.Pos())
			out := &DefinitionInfoPayload{
				DocumentSpanPayload: DocumentSpanPayload{FileName: sourceFile.FileName(), TextSpan: span},
				Kind:                "keyword",
				Name:                "switch",
				ContainerName:       strPtr(""),
				IsLocal:             boolPtr(true),
				IsAmbient:           boolPtr(false),
				Unverified:          boolPtr(false),
			}
			if contextSpan := core.NewTextRange(span.Pos(), stmt.AsSwitchStatement().CaseBlock.Pos()); contextSpan != span {
				out.ContextSpan = contextSpan
				out.HasContextSpan = true
			}
			return []*DefinitionInfoPayload{out}
		}
	}

	if node.Kind == ast.KindReturnKeyword || node.Kind == ast.KindYieldKeyword || node.Kind == ast.KindAwaitKeyword {
		if fn := ast.FindAncestor(node, ast.IsFunctionLikeDeclaration); fn != nil {
			// createDefinitionFromSignatureDeclaration
			return []*DefinitionInfoPayload{l.createDefinitionInfo(c, fn, fn.Symbol(), fn, boolPtr(false), nil)}
		}
	}

	declarations := getDeclarationsFromLocation(c, node)
	calledDeclaration := tryGetSignatureDeclaration(c, node)
	if calledDeclaration != nil && !(ast.IsJsxOpeningLikeElement(node.Parent) && isJsxConstructorLike(calledDeclaration)) {
		symbol := definitionSymbolAt(c, node)
		sigInfo := l.createDefinitionInfo(c, calledDeclaration, calledDeclaration.Symbol(), calledDeclaration, boolPtr(false), nil)
		if symbol != nil && core.Some(c.GetRootSymbols(symbol), func(rootSymbol *ast.Symbol) bool {
			return symbolMatchesSignature(rootSymbol, calledDeclaration)
		}) {
			if !ast.IsConstructorDeclaration(calledDeclaration) {
				return []*DefinitionInfoPayload{sigInfo}
			}
			declarations = core.Filter(declarations, func(d *ast.Node) bool {
				return d != calledDeclaration && (ast.IsClassDeclaration(d) || ast.IsClassExpression(d))
			})
		} else {
			declarations = core.Filter(declarations, func(d *ast.Node) bool { return d != calledDeclaration })
		}
		defs := mapDecls(declarations, func(decl *ast.Node) *DefinitionInfoPayload {
			return l.createDefinitionInfo(c, decl, symbol, node, nil, nil)
		})
		// For a 'super()' call, put the signature first, else the declarations first.
		if node.Kind == ast.KindSuperKeyword {
			return append([]*DefinitionInfoPayload{sigInfo}, defs...)
		}
		return append(defs, sigInfo)
	}

	symbol := definitionSymbolAt(c, node)
	return mapDecls(declarations, func(decl *ast.Node) *DefinitionInfoPayload {
		return l.createDefinitionInfo(c, decl, symbol, node, nil, nil)
	})
}

func mapDecls(decls []*ast.Node, f func(*ast.Node) *DefinitionInfoPayload) []*DefinitionInfoPayload {
	out := make([]*DefinitionInfoPayload, 0, len(decls))
	for _, d := range decls {
		out = append(out, f(d))
	}
	return out
}

// definitionSymbolAt resolves the symbol at the location the way stock's getSymbol does
// (alias-resolved, constructor-member special case) for kind/name computation.
func definitionSymbolAt(c *checker.Checker, node *ast.Node) *ast.Symbol {
	node = getDeclarationNameForKeyword(node)
	symbol := c.GetSymbolAtLocation(node)
	if symbol == nil {
		return nil
	}
	if symbol.Flags&ast.SymbolFlagsClass != 0 && symbol.Flags&(ast.SymbolFlagsFunction|ast.SymbolFlagsVariable) == 0 && node.Kind == ast.KindConstructorKeyword {
		if constructor := symbol.Members[ast.InternalSymbolNameConstructor]; constructor != nil {
			symbol = constructor
		}
	}
	if symbol.Flags&ast.SymbolFlagsAlias != 0 {
		if resolved, ok := c.ResolveAlias(symbol); ok {
			symbol = resolved
		}
	}
	return symbol
}

// createDefinitionInfo mirrors Strada's createDefinitionInfo (goToDefinition.ts).
func (l *LanguageService) createDefinitionInfo(c *checker.Checker, declaration *ast.Node, symbol *ast.Symbol, node *ast.Node, unverified *bool, failedAliasResolution *bool) *DefinitionInfoPayload {
	name := ""
	kind := ""
	containerName := ""
	if symbol != nil {
		name = c.SymbolToString(symbol)
		kind = symbolKindString(c, symbol, node)
		if symbol.Parent != nil {
			containerName = c.SymbolToStringEx(symbol.Parent, node, ast.SymbolFlagsAll, checker.SymbolFormatFlagsAllowAnyNodeKind)
		}
	}
	return l.createDefinitionInfoFromName(c, declaration, kind, name, strPtr(containerName), unverified, failedAliasResolution, core.TextRange{})
}

// createDefinitionInfoFromName mirrors Strada's createDefinitionInfoFromName.
func (l *LanguageService) createDefinitionInfoFromName(c *checker.Checker, declaration *ast.Node, kind string, name string, containerName *string, unverified *bool, failedAliasResolution *bool, spanOverride core.TextRange) *DefinitionInfoPayload {
	nameNode := core.OrElse(ast.GetNameOfDeclaration(declaration), declaration)
	sourceFile := ast.GetSourceFileOfNode(nameNode)
	var span core.TextRange
	if spanOverride != (core.TextRange{}) {
		span = spanOverride
	} else if nameNode.Kind == ast.KindEmptyStatement {
		span = core.NewTextRange(nameNode.Pos(), nameNode.Pos())
	} else {
		span = plainSpanOfNode(nameNode, sourceFile)
	}
	return &DefinitionInfoPayload{
		DocumentSpanPayload:   docSpanWithContext(sourceFile, span, getContextNode(declaration)),
		Kind:                  kind,
		Name:                  name,
		ContainerName:         containerName,
		IsLocal:               boolPtr(!isDefinitionVisible(c.GetEmitResolver(), declaration)),
		IsAmbient:             boolPtr(declaration.Flags&ast.NodeFlagsAmbient != 0),
		Unverified:            unverified,
		FailedAliasResolution: failedAliasResolution,
	}
}

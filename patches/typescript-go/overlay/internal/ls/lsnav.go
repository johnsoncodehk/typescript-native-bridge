package ls

// LS navigation payloads for the NAPI bridge (TNB issue #12): stock-services-shaped
// quickinfo / references / definitionAndBoundSpan results computed Go-side, so the
// tsserver path fetches them with one arena call instead of composing them from
// dozens of inner checker RPCs. Every function mirrors its Strada counterpart
// (services.ts getQuickInfoAtPosition, findAllReferences.ts findReferencedSymbols,
// goToDefinition.ts getDefinitionAndBoundSpan) — parity with stock is the contract.

import (
	"context"
	"strings"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/astnav"
	"github.com/microsoft/typescript-go/internal/checker"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/locale"
	"github.com/microsoft/typescript-go/internal/ls/lsutil"
	"github.com/microsoft/typescript-go/internal/lsp/lsproto"
	"github.com/microsoft/typescript-go/internal/nodebuilder"
	"github.com/microsoft/typescript-go/internal/printer"
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

// QuickInfoPayload mirrors Strada's QuickInfo (services/types.ts). DisplayString is
// the flattened display; DisplayParts carries the stock-style classified segments
// (the tsserver quickinfo protocol reports parts, not just the flattened string).
type QuickInfoPayload struct {
	Kind                      string
	KindModifiers             string
	Span                      core.TextRange
	DisplayString             string
	DisplayParts              []DisplayPart
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

// ScriptElementKindString maps lsutil kinds to Strada's ScriptElementKind
// strings (exported for the api package; never map by index — lsutil's iota
// order diverges from Strada's declaration order at JsxAttribute).
func ScriptElementKindString(kind lsutil.ScriptElementKind) string {
	return scriptElementKindString(kind)
}

// ScriptElementKindModifiersText renders a symbol's kindModifiers in Strada's
// SymbolDisplay.getSymbolModifiers order (exported for the api package).
func ScriptElementKindModifiersText(c *checker.Checker, symbol *ast.Symbol) string {
	return lsutil.GetSymbolModifiersText(c, symbol)
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

// symbolModifiersString mirrors Strada's getSymbolModifiers: first-declaration
// modifiers, then the alias target's, insertion-deduped (order is observable:
// "export,declare" direct, "declare,export" ambient alias).
func symbolModifiersString(c *checker.Checker, symbol *ast.Symbol) string {
	if symbol == nil {
		return ""
	}
	return lsutil.GetSymbolModifiersText(c, symbol)
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
	// Stock's getDocumentationComment reads JSDoc from every declaration of the
	// symbol — a transient member symbol can have a nil ValueDeclaration while
	// Declarations still names the real one (e.g. volar template-typed props).
	if symbol != nil {
		for _, decl := range symbol.Declarations {
			if decl == nil || decl == declaration {
				continue
			}
			if doc := l.getDocumentationFromDeclaration(c, symbol, decl, node, lsproto.MarkupKindPlainText, true /*commentOnly*/); doc != "" {
				return []DisplayPart{{Text: doc, Kind: "text"}}
			}
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
	info := getQuickInfoAndDeclarationAtLocation(c, symbol, nodeForQuickInfo, vc, true /*vsCapability*/, getMeaningFromLocation(nodeForQuickInfo))
	display := info.displayParts.String()
	var canIncrease *bool
	if verbosityLevel >= 0 {
		v := vc.CanIncreaseVerbosity && !vc.Truncated
		canIncrease = &v
	}
	displayParts := make([]DisplayPart, 0, len(info.displayParts.GetRuns()))
	for _, run := range info.displayParts.GetRuns() {
		kind := classificationToPartKind(lsproto.ClassificationTypeName(run.ClassificationTypeName))
		// Stock uses a distinct "lineBreak" part kind for newlines.
		if kind == "space" && strings.Contains(run.Text, "\n") {
			kind = "lineBreak"
		}
		displayParts = append(displayParts, DisplayPart{Text: run.Text, Kind: kind})
	}
	return &QuickInfoPayload{
		Kind:                      symbolKindString(c, symbol, nodeForQuickInfo),
		KindModifiers:             symbolModifiersString(c, symbol),
		Span:                      span,
		DisplayString:             display,
		DisplayParts:              displayParts,
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
	case lsproto.ClassificationTypeNameNumber:
		return "numericLiteral"
	case lsproto.ClassificationTypeNameOperator:
		return "operator"
	case lsproto.ClassificationTypeNamePunctuation:
		return "punctuation"
	case lsproto.ClassificationTypeNameWhiteSpace:
		return "space"
	case lsproto.ClassificationTypeNameIdentifier:
		// classificationForSymbol only emits Identifier for TypeAlias/Alias
		// symbols — Strada maps both to aliasName.
		return "aliasName"
		// classificationForSymbol only emits Identifier for TypeAlias/Alias
		// symbols — Strada maps both to aliasName.
		return "aliasName"
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

// ── SignatureHelp (issue #12 batch 2) ─────────────────────────────────────
// Stock SignatureHelpItems computed Go-side (services/signatureHelp.ts shape):
// items with prefix/suffix/separator display parts, parameters with classified
// display parts, documentation and JSDoc tags.

// SignatureHelpPayload mirrors Strada's SignatureHelpItems.
type SignatureHelpPayload struct {
	Items            []*SignatureHelpItemPayload
	ApplicableSpan   core.TextRange
	SelectedItemIndex uint32
	ArgumentIndex    uint32
	ArgumentCount    uint32
}

// SignatureHelpItemPayload mirrors Strada's SignatureHelpItem.
type SignatureHelpItemPayload struct {
	IsVariadic    bool
	Prefix        []DisplayPart
	Suffix        []DisplayPart
	Separator     []DisplayPart
	Parameters    []*SignatureHelpParameterPayload
	Documentation []DisplayPart
	Tags          []JSDocTagPayload
}

// SignatureHelpParameterPayload mirrors Strada's SignatureHelpParameter.
type SignatureHelpParameterPayload struct {
	Name          string
	Documentation []DisplayPart
	DisplayParts  []DisplayPart
	IsOptional    bool
	IsRest        bool
}

// runsToDisplayParts maps VS-classified runs onto Strada part kinds.
func runsToDisplayParts(runs []*lsproto.VSClassifiedTextRun) []DisplayPart {
	if len(runs) == 0 {
		return nil
	}
	out := make([]DisplayPart, 0, len(runs))
	for _, r := range runs {
		out = append(out, DisplayPart{Text: r.Text, Kind: classificationToPartKind(lsproto.ClassificationTypeName(r.ClassificationTypeName))})
	}
	return out
}

// symbolDisplayPartsForCallTarget mirrors stock's symbolToDisplayParts for a
// call target (single classified name part).
func symbolDisplayPartsForCallTarget(c *checker.Checker, symbol *ast.Symbol, enclosing *ast.Node) []DisplayPart {
	if symbol == nil {
		return nil
	}
	text := c.SymbolToStringEx(symbol, enclosing, ast.SymbolFlagsNone, symbolFormatFlags)
	if text == "" {
		return nil
	}
	return []DisplayPart{{Text: text, Kind: classificationToPartKind(classificationForSymbol(symbol))}}
}

// parameterDisplayParts prints one parameter declaration with classified runs
// (mirrors stock's createSignatureHelpParameterForParameter displayParts).
func (l *LanguageService) parameterDisplayParts(param *ast.Symbol, enclosing *ast.Node, sourceFile *ast.SourceFile, c *checker.Checker) []DisplayPart {
	emitContext := printer.NewEmitContext()
	idToSymbol := make(map[*ast.IdentifierNode]*ast.Symbol)
	nb := checker.NewNodeBuilderEx(c, emitContext, idToSymbol)
	node := nb.SymbolToParameterDeclaration(param, enclosing, signatureHelpNodeBuilderFlags, nodebuilder.InternalFlagsNone, nil)
	if node == nil {
		return nil
	}
	p := printer.NewPrinter(printer.PrinterOptions{NewLine: core.NewLineKindLF}, printer.PrintHandlers{}, emitContext)
	p.IdToSymbol = idToSymbol
	dpw := newDisplayPartsWriter(true)
	p.Write(node, sourceFile, dpw, nil)
	return runsToDisplayParts(dpw.GetRuns())
}

// typeParameterListParts prints the type-parameter list "<T, U>" as parts.
func (l *LanguageService) typeParameterListParts(candidate *checker.Signature, enclosing *ast.Node, sourceFile *ast.SourceFile, c *checker.Checker) []DisplayPart {
	if len(candidate.TypeParameters()) == 0 {
		return nil
	}
	out := []DisplayPart{{Text: "<", Kind: "punctuation"}}
	emitContext := printer.NewEmitContext()
	idToSymbol := make(map[*ast.IdentifierNode]*ast.Symbol)
	nb := checker.NewNodeBuilderEx(c, emitContext, idToSymbol)
	p := printer.NewPrinter(printer.PrinterOptions{NewLine: core.NewLineKindLF}, printer.PrintHandlers{}, emitContext)
	p.IdToSymbol = idToSymbol
	for i, tp := range candidate.TypeParameters() {
		if i > 0 {
			out = append(out, DisplayPart{Text: ",", Kind: "punctuation"}, DisplayPart{Text: " ", Kind: "space"})
		}
		node := nb.TypeParameterToDeclaration(tp, enclosing, signatureHelpNodeBuilderFlags, nodebuilder.InternalFlagsNone, nil)
		dpw := newDisplayPartsWriter(true)
		p.Write(node, sourceFile, dpw, nil)
		out = append(out, runsToDisplayParts(dpw.GetRuns())...)
	}
	out = append(out, DisplayPart{Text: ">", Kind: "punctuation"})
	return out
}

// signatureHelpParameterForParam mirrors stock's createSignatureHelpParameterForParameter.
func (l *LanguageService) signatureHelpParameterForParam(param *ast.Symbol, enclosing *ast.Node, sourceFile *ast.SourceFile, c *checker.Checker) *SignatureHelpParameterPayload {
	payload := &SignatureHelpParameterPayload{
		Name:         param.Name,
		DisplayParts: l.parameterDisplayParts(param, enclosing, sourceFile, c),
		IsRest:       param.CheckFlags&ast.CheckFlagsRestParameter != 0,
	}
	if param.CheckFlags&ast.CheckFlagsOptionalParameter != 0 {
		payload.IsOptional = true
	}
	if param.ValueDeclaration != nil {
		if doc := l.getDocumentationFromDeclaration(c, nil, param.ValueDeclaration, nil, lsproto.MarkupKindPlainText, true /*commentOnly*/); doc != "" {
			payload.Documentation = []DisplayPart{{Text: doc, Kind: "text"}}
		}
	}
	if payload.Documentation == nil {
		payload.Documentation = []DisplayPart{}
	}
	return payload
}

var signatureHelpSeparatorParts = []DisplayPart{{Text: ",", Kind: "punctuation"}, {Text: " ", Kind: "space"}}

// signatureHelpItemForCandidate mirrors stock's getSignatureHelpItem.
func (l *LanguageService) signatureHelpItemForCandidate(ctx context.Context, candidate *checker.Signature, callTargetParts []DisplayPart, isTypeParameterList bool, argumentInfo *argumentListInfo, sourceFile *ast.SourceFile, c *checker.Checker) []*SignatureHelpItemPayload {
	enclosing := getEnclosingDeclarationFromInvocation(argumentInfo.invocation)
	suffixDpw := returnTypeToDisplayParts(candidate, c, enclosing, sourceFile, true /*vsCapability*/)

	var documentation []DisplayPart
	var tags []JSDocTagPayload
	if declaration := candidate.Declaration(); declaration != nil {
		if doc := l.getDocumentationFromDeclaration(c, nil, declaration, nil, lsproto.MarkupKindPlainText, true /*commentOnly*/); doc != "" {
			documentation = []DisplayPart{{Text: doc, Kind: "text"}}
		}
		if sym := declaration.Symbol(); sym != nil {
			tags = l.jsDocTagPayloads(sym)
		}
	}
	if documentation == nil {
		documentation = []DisplayPart{}
	}

	expanded := c.GetExpandedParameters(candidate, false)
	isVariadic := func(parameterList []*ast.Symbol) bool {
		if !c.HasEffectiveRestParameter(candidate) {
			return false
		}
		if len(expanded) == 1 {
			return true
		}
		return len(parameterList) != 0 && parameterList[len(parameterList)-1] != nil && parameterList[len(parameterList)-1].CheckFlags&ast.CheckFlagsRestParameter != 0
	}

	out := make([]*SignatureHelpItemPayload, 0, len(expanded))
	if isTypeParameterList {
		typeParameters := candidate.TypeParameters()
		if candidate.Target() != nil {
			typeParameters = candidate.Target().TypeParameters()
		}
		for range expanded {
			params := make([]*SignatureHelpParameterPayload, 0, len(typeParameters))
			for _, tp := range typeParameters {
				param := &SignatureHelpParameterPayload{IsOptional: false, IsRest: false, Documentation: []DisplayPart{}}
				if sym := tp.Symbol(); sym != nil {
					param.Name = sym.Name
					if doc := l.getDocumentationFromDeclaration(c, nil, core.FirstOrNil(sym.Declarations), nil, lsproto.MarkupKindPlainText, true /*commentOnly*/); doc != "" {
						param.Documentation = []DisplayPart{{Text: doc, Kind: "text"}}
					}
				}
				emitContext := printer.NewEmitContext()
				idToSymbol := make(map[*ast.IdentifierNode]*ast.Symbol)
				nb := checker.NewNodeBuilderEx(c, emitContext, idToSymbol)
				p := printer.NewPrinter(printer.PrinterOptions{NewLine: core.NewLineKindLF}, printer.PrintHandlers{}, emitContext)
				p.IdToSymbol = idToSymbol
				node := nb.TypeParameterToDeclaration(tp, enclosing, signatureHelpNodeBuilderFlags, nodebuilder.InternalFlagsNone, nil)
				dpw := newDisplayPartsWriter(true)
				p.Write(node, sourceFile, dpw, nil)
				param.DisplayParts = runsToDisplayParts(dpw.GetRuns())
				params = append(params, param)
			}
			prefix := append(append([]DisplayPart{}, callTargetParts...), DisplayPart{Text: "<", Kind: "punctuation"})
			suffix := append([]DisplayPart{{Text: ">", Kind: "punctuation"}}, runsToDisplayParts(suffixDpw.GetRuns())...)
			out = append(out, &SignatureHelpItemPayload{
				IsVariadic:    false,
				Prefix:        prefix,
				Suffix:        suffix,
				Separator:     signatureHelpSeparatorParts,
				Parameters:    params,
				Documentation: documentation,
				Tags:          tags,
			})
		}
		return out
	}

	for _, parameterList := range expanded {
		params := make([]*SignatureHelpParameterPayload, 0, len(parameterList))
		for _, param := range parameterList {
			params = append(params, l.signatureHelpParameterForParam(param, enclosing, sourceFile, c))
		}
		prefix := append(append(append([]DisplayPart{}, callTargetParts...), l.typeParameterListParts(candidate, enclosing, sourceFile, c)...), DisplayPart{Text: "(", Kind: "punctuation"})
		suffix := append([]DisplayPart{{Text: ")", Kind: "punctuation"}}, runsToDisplayParts(suffixDpw.GetRuns())...)
		out = append(out, &SignatureHelpItemPayload{
			IsVariadic:    isVariadic(parameterList),
			Prefix:        prefix,
			Suffix:        suffix,
			Separator:     signatureHelpSeparatorParts,
			Parameters:    params,
			Documentation: documentation,
			Tags:          tags,
		})
	}
	return out
}

// GetSignatureHelpForAPI mirrors services getSignatureHelpItems (no-triggerReason
// path; triggerReason kinds map onto onlyUseSyntacticOwners/isManuallyInvoked).
// Returns nil when stock returns undefined.
func (l *LanguageService) GetSignatureHelpForAPI(ctx context.Context, file *ast.SourceFile, position int, triggerReason string) *SignatureHelpPayload {
	c, done := l.program.GetTypeCheckerForFile(ctx, file)
	defer done()

	startingToken := astnav.FindPrecedingToken(file, position)
	if startingToken == nil {
		return nil
	}
	onlyUseSyntacticOwners := triggerReason == "characterTyped"
	if onlyUseSyntacticOwners && (IsInString(file, position, startingToken) || isInComment(file, position, startingToken) != nil) {
		return nil
	}
	isManuallyInvoked := triggerReason == "invoked"
	argumentInfo := getContainingArgumentInfo(startingToken, file, c, isManuallyInvoked, position)
	if argumentInfo == nil {
		return nil
	}
	candidateInfo := getCandidateOrTypeInfo(argumentInfo, c, file, startingToken, onlyUseSyntacticOwners)
	if candidateInfo == nil {
		return nil
	}

	invocation := argumentInfo.invocation
	var callTargetSymbol *ast.Symbol
	if invocation.contextualInvocation != nil {
		callTargetSymbol = invocation.contextualInvocation.symbol
	} else {
		callTargetSymbol = c.GetSymbolAtLocation(getExpressionFromInvocation(argumentInfo))
	}
	callTargetParts := symbolDisplayPartsForCallTarget(c, callTargetSymbol, nil)

	if candidateInfo.typeInfo != nil {
		// createTypeHelpItems: type-parameter list help for a symbol.
		typeParameters := c.GetLocalTypeParametersOfClassOrInterfaceOrTypeAlias(candidateInfo.typeInfo)
		if len(typeParameters) == 0 {
			return nil
		}
		return &SignatureHelpPayload{
			ApplicableSpan:   argumentInfo.argumentsSpan,
			SelectedItemIndex: 0,
			ArgumentIndex:    uint32(argumentInfo.argumentIndex),
			ArgumentCount:    uint32(argumentInfo.argumentCount),
		}
	}

	candidates := candidateInfo.candidateInfo.candidates
	resolved := candidateInfo.candidateInfo.resolvedSignature
	payload := &SignatureHelpPayload{
		ApplicableSpan: argumentInfo.argumentsSpan,
		ArgumentIndex:  uint32(argumentInfo.argumentIndex),
		ArgumentCount:  uint32(argumentInfo.argumentCount),
	}
	itemsSeen := 0
	for _, candidate := range candidates {
		items := l.signatureHelpItemForCandidate(ctx, candidate, callTargetParts, argumentInfo.isTypeParameterList, argumentInfo, file, c)
		if candidate == resolved && len(items) > 0 {
			payload.SelectedItemIndex = uint32(itemsSeen)
			if len(items) > 1 {
				count := 0
				for _, item := range items {
					if item.IsVariadic || len(item.Parameters) >= argumentInfo.argumentCount {
						payload.SelectedItemIndex = uint32(itemsSeen + count)
						break
					}
					count++
				}
			}
		}
		itemsSeen += len(items)
		payload.Items = append(payload.Items, items...)
	}
	if len(payload.Items) == 0 {
		return nil
	}
	// Variadic argument-index adjustment (stock signatureHelp.ts).
	selected := payload.Items[payload.SelectedItemIndex]
	if selected.IsVariadic {
		firstRest := -1
		for i, p := range selected.Parameters {
			if p.IsRest {
				firstRest = i
				break
			}
		}
		if firstRest >= 0 && firstRest < len(selected.Parameters)-1 {
			payload.ArgumentIndex = uint32(len(selected.Parameters))
		} else if int(payload.ArgumentIndex) > len(selected.Parameters)-1 {
			payload.ArgumentIndex = uint32(len(selected.Parameters) - 1)
		}
	}
	return payload
}

// ── Rename (issue #12 batch 2) ────────────────────────────────────────────

// RenameInfoPayload mirrors Strada's RenameInfo (success or failure).
type RenameInfoPayload struct {
	CanRename             bool
	FileToRename          string
	DisplayName           string
	FullDisplayName       string
	Kind                  string
	KindModifiers         string
	TriggerSpan           core.TextRange
	LocalizedErrorMessage string
}

// RenameLocationPayload mirrors Strada's RenameLocation entry.
type RenameLocationPayload struct {
	DocumentSpanPayload
	PrefixText string
	SuffixText string
}

// renameTriggerSpan mirrors stock's createTriggerSpanForNode (string literals
// shrink by the quotes).
func renameTriggerSpan(node *ast.Node, sourceFile *ast.SourceFile) core.TextRange {
	span := plainSpanOfNode(node, sourceFile)
	if ast.IsStringLiteralLike(node) && span.Len() > 2 {
		return core.NewTextRange(span.Pos()+1, span.End()-1)
	}
	return span
}

// GetRenameInfoForAPI mirrors services/rename.ts getRenameInfo (identifier /
// string-literal / label paths; module-specifier renames included).
func (l *LanguageService) GetRenameInfoForAPI(ctx context.Context, file *ast.SourceFile, position int, allowRenameOfImportPath bool, providePrefixAndSuffix bool) *RenameInfoPayload {
	node := astnav.GetTouchingPropertyName(file, position)
	node = getAdjustedLocation(node, true /*forRename*/, file)
	if !nodeIsEligibleForRename(node) {
		return &RenameInfoPayload{CanRename: false, LocalizedErrorMessage: "You cannot rename this element."}
	}
	c, done := l.program.GetTypeCheckerForFile(ctx, file)
	defer done()
	symbol := c.GetSymbolAtLocation(node)
	if symbol == nil {
		if ast.IsStringLiteralLike(node) {
			typ := getContextualTypeFromParentOrAncestorTypeNode(node, c)
			if typ != nil && (typ.IsStringLiteral() || (typ.IsUnion() && core.Every(typ.Types(), func(t *checker.Type) bool { return t.IsStringLiteral() }))) {
				return &RenameInfoPayload{CanRename: true, DisplayName: node.Text(), FullDisplayName: node.Text(), Kind: "string", TriggerSpan: renameTriggerSpan(node, file)}
			}
		} else if ast.IsLabelName(node) {
			name := node.Text()
			return &RenameInfoPayload{CanRename: true, DisplayName: name, FullDisplayName: name, Kind: "label", TriggerSpan: renameTriggerSpan(node, file)}
		}
		return &RenameInfoPayload{CanRename: false, LocalizedErrorMessage: "You cannot rename this element."}
	}
	if len(symbol.Declarations) == 0 {
		return &RenameInfoPayload{CanRename: false, LocalizedErrorMessage: "You cannot rename this element."}
	}
	if msg := l.renameBlockedReason(file, node, symbol, c, l.program); msg != nil {
		return &RenameInfoPayload{CanRename: false, LocalizedErrorMessage: msg.Localize(locale.FromContext(ctx))}
	}
	if ast.IsStringLiteralLike(node) && ast.TryGetImportFromModuleSpecifier(node) != nil {
		if !allowRenameOfImportPath {
			return nil
		}
		// Mirrors stock's getRenameInfoForModule.
		if !tspath.IsExternalModuleNameRelative(node.Text()) {
			return &RenameInfoPayload{CanRename: false, LocalizedErrorMessage: "You cannot rename a module via a global import."}
		}
		var moduleSourceFile *ast.SourceFile
		for _, d := range symbol.Declarations {
			if ast.IsSourceFile(d) {
				moduleSourceFile = d.AsSourceFile()
				break
			}
		}
		if moduleSourceFile == nil {
			return &RenameInfoPayload{CanRename: false, LocalizedErrorMessage: "You cannot rename this element."}
		}
		return &RenameInfoPayload{CanRename: true, Kind: "module", DisplayName: node.Text(), FullDisplayName: node.Text(), TriggerSpan: renameTriggerSpan(node, file)}
	}
	var specifierName string
	if (ast.IsIdentifier(node) && node.Parent != nil && (ast.IsImportSpecifier(node.Parent) || ast.IsExportSpecifier(node.Parent)) && node.Parent.Name() == node) || (ast.IsStringLiteralLike(node) && node.Parent != nil && node.Parent.Kind == ast.KindComputedPropertyName) {
		specifierName = scanner.GetTextOfNode(node)
	}
	displayName := specifierName
	if displayName == "" {
		displayName = c.SymbolToString(symbol)
	}
	fullDisplayName := specifierName
	if fullDisplayName == "" {
		fullDisplayName = c.GetFullyQualifiedName(symbol, nil)
	}
	return &RenameInfoPayload{
		CanRename:      true,
		DisplayName:    displayName,
		FullDisplayName: fullDisplayName,
		Kind:           symbolKindString(c, symbol, node),
		KindModifiers:  symbolModifiersString(c, symbol),
		TriggerSpan:    renameTriggerSpan(node, file),
	}
}

// getPrefixAndSuffixForRename mirrors Strada's getPrefixAndSuffixText.
func getPrefixAndSuffixForRename(originalNode *ast.Node, entry *ReferenceEntry, c *checker.Checker) (string, string) {
	if entry.kind == entryKindRange || (!ast.IsIdentifier(originalNode) && !ast.IsStringLiteralLike(originalNode)) {
		return "", ""
	}
	node := entry.node
	parent := node.Parent
	name := originalNode.Text()
	isShorthandAssignment := ast.IsShorthandPropertyAssignment(parent)
	isBindingNoProp := parent != nil && parent.Kind == ast.KindBindingElement && parent.AsBindingElement().PropertyName == nil && parent.Name() == node && parent.AsBindingElement().DotDotDotToken == nil
	if isShorthandAssignment || isBindingNoProp {
		if entry.kind == entryKindSearchedLocalFoundProperty {
			return name + ": ", ""
		}
		if entry.kind == entryKindSearchedPropertyFoundLocal {
			return "", ": " + name
		}
		if isShorthandAssignment {
			grandParent := parent.Parent
			if ast.IsObjectLiteralExpression(grandParent) && ast.IsBinaryExpression(grandParent.Parent) && ast.IsModuleExportsAccessExpression(grandParent.Parent.AsBinaryExpression().Left) {
				return name + ": ", ""
			}
			return "", ": " + name
		}
		return name + ": ", ""
	}
	if parent != nil && ast.IsImportSpecifier(parent) && parent.PropertyName() == nil {
		var originalSymbol *ast.Symbol
		if originalNode.Parent != nil && ast.IsExportSpecifier(originalNode.Parent) {
			originalSymbol = c.GetExportSpecifierLocalTargetSymbol(originalNode.Parent)
		} else {
			originalSymbol = c.GetSymbolAtLocation(originalNode)
		}
		if originalSymbol != nil {
			for _, d := range originalSymbol.Declarations {
				if d == parent {
					return name + " as ", ""
				}
			}
		}
		return "", ""
	}
	if parent != nil && ast.IsExportSpecifier(parent) && parent.PropertyName() == nil {
		if originalNode == entry.node || c.GetSymbolAtLocation(originalNode) == c.GetSymbolAtLocation(entry.node) {
			return name + " as ", ""
		}
		return "", " as " + name
	}
	return "", ""
}

// FindRenameLocationsForAPI mirrors services findRenameLocations.
func (l *LanguageService) FindRenameLocationsForAPI(ctx context.Context, file *ast.SourceFile, position int, findInStrings bool, findInComments bool, providePrefixAndSuffix bool) []*RenameLocationPayload {
	node := astnav.GetTouchingPropertyName(file, position)
	node = getAdjustedLocation(node, true /*forRename*/, file)
	if !nodeIsEligibleForRename(node) {
		return nil
	}
	// JSX intrinsic tag rename: both the opening and closing tag names.
	if ast.IsIdentifier(node) && node.Parent != nil && (ast.IsJsxOpeningElement(node.Parent) || ast.IsJsxClosingElement(node.Parent)) && scanner.IsIntrinsicJsxName(node.Text()) {
		if element := node.Parent.Parent; element != nil {
			var out []*RenameLocationPayload
			for _, tag := range []*ast.Node{element.AsJsxElement().OpeningElement.TagName(), element.AsJsxElement().ClosingElement.TagName()} {
				sourceFile := ast.GetSourceFileOfNode(tag)
				span := plainSpanOfNode(tag, sourceFile)
				out = append(out, &RenameLocationPayload{DocumentSpanPayload: DocumentSpanPayload{FileName: sourceFile.FileName(), TextSpan: span}})
			}
			return out
		}
	}
	// Stock excludes default-library files from rename searches.
	var sourceFiles []*ast.SourceFile
	for _, sf := range l.program.GetSourceFiles() {
		if !l.program.IsSourceFileDefaultLibrary(l.toPath(sf.FileName())) {
			sourceFiles = append(sourceFiles, sf)
		}
	}
	referencedSymbols := l.getReferencedSymbolsForNode(ctx, position, node, l.program, sourceFiles, refOptions{
		findInStrings: findInStrings, findInComments: findInComments, use: referenceUseRename, useAliasesForRename: providePrefixAndSuffix,
	})
	if len(referencedSymbols) == 0 {
		return nil
	}
	c, done := l.program.GetTypeCheckerForFile(ctx, file)
	defer done()
	var out []*RenameLocationPayload
	for _, s := range referencedSymbols {
		for _, entry := range s.References() {
			var span DocumentSpanPayload
			if entry.kind == entryKindRange {
				span = DocumentSpanPayload{FileName: entry.fileName, TextSpan: *entry.textRange}
			} else {
				span = documentSpanOfNode(entry.node, entry.context)
			}
			loc := &RenameLocationPayload{DocumentSpanPayload: span}
			if providePrefixAndSuffix {
				loc.PrefixText, loc.SuffixText = getPrefixAndSuffixForRename(node, entry, c)
			}
			out = append(out, loc)
		}
	}
	return out
}

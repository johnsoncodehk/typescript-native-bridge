package api

// TNB additions to package api, kept out of session.go so its in-place patch
// carries only edits to upstream code.

import (
	"context"
	"encoding/base64"
	"fmt"
	"slices"
	"strings"
	"sync"

	"github.com/microsoft/typescript-go/internal/api/encoder"
	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/astnav"
	"github.com/microsoft/typescript-go/internal/bundled"
	"github.com/microsoft/typescript-go/internal/checker"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/execute/incremental"
	"github.com/microsoft/typescript-go/internal/jsnum"
	"github.com/microsoft/typescript-go/internal/lsp/lsproto"
	"github.com/microsoft/typescript-go/internal/nodebuilder"
	"github.com/microsoft/typescript-go/internal/tspath"
)

// incrementalProgramEntry guards one-time construction of an incremental
// wrapper per program: buildinfo read + changed-files delta computation is
// expensive, so concurrent diagnostic RPCs must share a single build without
// serializing wrapper creation of unrelated projects.
type incrementalProgramEntry struct {
	once    sync.Once
	program *incremental.Program
}

// getIncrementalProgram returns the incremental.Program serving build-state
// diagnostics for an incremental-capable project, creating it on first use
// exactly like the native CLI load path (execute/tsc.go
// performIncrementalCompilation): ReadBuildInfoProgram restores the prior
// per-file state from disk and NewProgram computes the changed-files delta
// against the live program. Non-incremental projects return nil and stay on
// the plain-program path, mirroring the native IsIncremental gate.
func (sd *snapshotData) getIncrementalProgram(program *compiler.Program) *incremental.Program {
	if !program.Options().IsIncremental() {
		return nil
	}
	sd.incrementalProgramsMu.Lock()
	if sd.incrementalPrograms == nil {
		sd.incrementalPrograms = make(map[*compiler.Program]*incrementalProgramEntry)
	}
	entry := sd.incrementalPrograms[program]
	if entry == nil {
		entry = &incrementalProgramEntry{}
		sd.incrementalPrograms[program] = entry
	}
	sd.incrementalProgramsMu.Unlock()
	entry.once.Do(func() {
		host := program.Host()
		oldProgram := incremental.ReadBuildInfoProgram(program.CommandLine(), incremental.NewBuildInfoReader(host), host)
		entry.program = incremental.NewProgram(program, oldProgram, incremental.CreateHost(host), false)
	})
	return entry.program
}

// builderFileGraph returns the builder file graph for the program, serving it
// from the incremental wrapper's snapshot when one exists (programToSnapshot
// already ran the identical per-file hash + referenced-files walk to build
// it — recomputing doubled that whole-program cost per project on warm
// vue-tsc -b runs). Results are memoized per program identity; the graph is
// a pure function of the immutable program.
func (sd *snapshotData) builderFileGraph(program *compiler.Program) []incremental.BuilderFileGraphEntry {
	sd.builderGraphMemoMu.Lock()
	if entries, ok := sd.builderGraphMemo[program]; ok {
		sd.builderGraphMemoMu.Unlock()
		return entries
	}
	sd.builderGraphMemoMu.Unlock()

	var entries []incremental.BuilderFileGraphEntry
	if incrementalProgram := sd.getIncrementalProgram(program); incrementalProgram != nil {
		entries = incrementalProgram.BuilderFileGraph()
	}
	if entries == nil {
		entries = incremental.ComputeBuilderFileGraph(program)
	}

	sd.builderGraphMemoMu.Lock()
	if sd.builderGraphMemo == nil {
		sd.builderGraphMemo = make(map[*compiler.Program][]incremental.BuilderFileGraphEntry)
	}
	sd.builderGraphMemo[program] = entries
	sd.builderGraphMemoMu.Unlock()
	return entries
}

// fullSemanticPass runs (or reuses) a whole-program semantic check on the
// given program, returning per-file diagnostics without noEmit filtering —
// the exact form the incremental builder caches per file. The result is
// memoized on the snapshot; canceled passes are not cached.
func (sd *snapshotData) fullSemanticPass(ctx context.Context, program *compiler.Program) map[*ast.SourceFile][]*ast.Diagnostic {
	for {
		sd.semanticDiagMemoMu.Lock()
		if memo := sd.semanticDiagMemo[program]; memo != nil {
			sd.semanticDiagMemoMu.Unlock()
			return memo
		}
		if inflight := sd.semanticDiagInflight[program]; inflight != nil {
			// Another goroutine (build-mode prefetch or a concurrent RPC) is
			// already running the pass — wait for it and re-check the memo.
			sd.semanticDiagMemoMu.Unlock()
			select {
			case <-inflight:
				continue
			case <-ctx.Done():
				return nil
			}
		}
		done := make(chan struct{})
		if sd.semanticDiagInflight == nil {
			sd.semanticDiagInflight = make(map[*compiler.Program]chan struct{})
		}
		sd.semanticDiagInflight[program] = done
		sd.semanticDiagMemoMu.Unlock()

		result := program.GetSemanticDiagnosticsWithoutNoEmitFiltering(ctx, program.GetSourceFiles())
		sd.semanticDiagMemoMu.Lock()
		if ctx.Err() == nil {
			if sd.semanticDiagMemo == nil {
				sd.semanticDiagMemo = make(map[*compiler.Program]map[*ast.SourceFile][]*ast.Diagnostic)
			}
			sd.semanticDiagMemo[program] = result
		}
		delete(sd.semanticDiagInflight, program)
		sd.semanticDiagMemoMu.Unlock()
		close(done)
		if ctx.Err() != nil {
			return nil
		}
		return result
	}
}

// symbolHasGlobalExports reports whether any declaration of symbol belongs to
// a source file whose module symbol is symbol itself and whose global-exports
// table is non-empty. Stock sets file.symbol.globalExports only for
// `export as namespace` (UMD) modules (bindNamespaceExportDeclaration); tsgo
// keeps the table on the SourceFile (ast.SourceFile.GlobalExports), so the
// wire flag has to be derived here — the JS side installs the globalExports
// accessor exactly when this is true.
func symbolHasGlobalExports(symbol *ast.Symbol) bool {
	for _, decl := range symbol.Declarations {
		sf := ast.GetSourceFileOfNode(decl)
		if sf != nil && sf.Symbol == symbol && len(sf.GlobalExports) > 0 {
			return true
		}
	}
	return false
}

// canonicalProjectOf returns the canonical project recorded for an
// already-registered symbol. Snapshot-scoped TNB batch handlers
// (getSymbolsDeclarations / getParentsOfSymbols) have no project parameter;
// response symbols inherit the source symbol's canonical project.
func (sd *snapshotData) canonicalProjectOf(symbol *ast.Symbol) ProjectID {
	sd.symbolRegistryMu.RLock()
	defer sd.symbolRegistryMu.RUnlock()
	return sd.symbolCanonicalProjects[SymbolHandle(symbol)]
}

func (setup checkerSetup) resolveTypeHandles(ids []TypeID) ([]*checker.Type, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	out := make([]*checker.Type, len(ids))
	for i, id := range ids {
		t, err := setup.resolveTypeHandle(id)
		if err != nil {
			return nil, err
		}
		out[i] = t
	}
	return out, nil
}

// applyOverlayEdits splices a delta push's edits into the session's stored
// overlay text and returns the resulting full content. baseVersion must equal
// the session's count of delta pushes already applied to the file — a
// mismatch means the client and the bridge disagree on the base text, and
// splicing forward would corrupt it silently, so it is an error.
func (s *Session) applyOverlayEdits(path tspath.Path, fileName string, f OpenFileWithContent) (string, error) {
	if f.BaseVersion == nil {
		return "", fmt.Errorf("%w: openFilesWithContent edits for %s missing baseVersion", ErrClientError, fileName)
	}
	if s.overlayVersions == nil {
		s.overlayVersions = make(map[tspath.Path]int)
	}
	version, ok := s.overlayVersions[path]
	if !ok {
		return "", fmt.Errorf("%w: openFilesWithContent edits for %s have no overlay base (full content never sent)", ErrClientError, fileName)
	}
	if *f.BaseVersion != version {
		return "", fmt.Errorf("%w: openFilesWithContent edits for %s baseVersion %d, session holds %d (host/bridge overlay desync)", ErrClientError, fileName, *f.BaseVersion, version)
	}
	base, ok := s.projectSession.OverlayContent(path)
	if !ok {
		return "", fmt.Errorf("%w: openFilesWithContent edits for %s have no overlay base (full content never sent)", ErrClientError, fileName)
	}
	text := base
	for _, e := range f.Edits {
		var err error
		text, err = spliceUTF16(text, e.Start, e.DeleteLength, e.InsertText)
		if err != nil {
			return "", fmt.Errorf("%w: openFilesWithContent edit for %s out of range: %v", ErrClientError, fileName, err)
		}
	}
	s.overlayVersions[path] = version + 1
	return text, nil
}

// spliceUTF16 applies one edit in UTF-16 code units (stock ScriptInfo's
// native domain) to a Go string. Byte offsets are resolved with a single
// rune walk per boundary — astral characters count as two units.
func spliceUTF16(text string, start, deleteLength int, insert string) (string, error) {
	if start < 0 || deleteLength < 0 {
		return "", fmt.Errorf("negative start/deleteLength (%d/%d)", start, deleteLength)
	}
	startByte, ok := utf16UnitOffsetToByteOffset(text, start)
	if !ok {
		return "", fmt.Errorf("start %d beyond text", start)
	}
	endByte, ok := utf16UnitOffsetToByteOffset(text[startByte:], deleteLength)
	if !ok {
		return "", fmt.Errorf("delete end %d beyond text", start+deleteLength)
	}
	var b strings.Builder
	b.Grow(len(text) - endByte + len(insert))
	b.WriteString(text[:startByte])
	b.WriteString(insert)
	b.WriteString(text[startByte+endByte:])
	return b.String(), nil
}

// utf16UnitOffsetToByteOffset converts a UTF-16 code-unit offset to a byte
// offset; ok=false when the text has fewer units.
func utf16UnitOffsetToByteOffset(s string, units int) (int, bool) {
	if units == 0 {
		return 0, true
	}
	u := 0
	for i, r := range s {
		if u >= units {
			return i, true
		}
		if r > 0xFFFF {
			u += 2
		} else {
			u++
		}
	}
	if u == units {
		return len(s), true
	}
	return 0, false
}

// IsDiskStableDeclarationFileName reports whether fileName names a
// declaration file whose on-disk content is stable for the life of the
// process: node_modules .d.ts and the shipped lib set (bundled:// in embed
// builds, LibPath() files on disk in noembed builds). The parse and encode
// caches key off this single predicate — a changed file re-parses into a
// new AST and misses both caches under its new identity.
func IsDiskStableDeclarationFileName(fileName string) bool {
	if !tspath.IsDeclarationFileName(fileName) {
		return false
	}
	if strings.Contains(fileName, "/node_modules/") || strings.HasPrefix(fileName, "bundled://") {
		return true
	}
	return strings.HasPrefix(fileName, bundled.LibPath()+"/")
}

// encodeSourceFileCached encodes a source file AST into the binary wire format,
// memoizing the result for disk-stable declaration files (see encodedSourceFiles).
func (s *Session) encodeSourceFileCached(sourceFile *ast.SourceFile) ([]byte, error) {
	fileName := sourceFile.FileName()
	cacheable := IsDiskStableDeclarationFileName(fileName)
	if cacheable {
		if cached, ok := s.encodedSourceFiles.Load(sourceFile); ok {
			return cached.([]byte), nil
		}
	}
	data, _, err := encoder.EncodeSourceFile(sourceFile)
	if err != nil {
		return nil, err
	}
	if cacheable {
		s.encodedSourceFiles.Store(sourceFile, data)
	}
	return data, nil
}

// handleGetSymbolsInScope returns all symbols visible in scope at a node
// location, filtered by the given SymbolFlags meaning. With params.Dedup it
// returns the GetSymbolsInScopeResponse split shape: full payloads only for
// symbols not previously delivered by a dedup response on this snapshot.
// Scope results are dominated by globals shared across every query location,
// so after the first call per project the response is mostly bare ids.
func (s *Session) handleGetSymbolsInScope(ctx context.Context, params *GetSymbolsInScopeParams) (any, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	location, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if location == nil {
		return nil, nil
	}

	symbols := setup.checker.GetSymbolsInScope(location, ast.SymbolFlags(params.Meaning))
	if !params.Dedup {
		results := make([]*SymbolResponse, len(symbols))
		for i, symbol := range symbols {
			results[i] = setup.newSymbolResponse(symbol)
		}
		return results, nil
	}

	sd := setup.sd
	resp := &GetSymbolsInScopeResponse{}
	// Partition under one lock pass: ids already sent go to Known; the rest
	// are marked sent now and marshalled in full below (newSymbolResponse
	// re-takes the registry lock, so keep the marshal outside this section).
	var fresh []*ast.Symbol
	sd.symbolRegistryMu.Lock()
	for _, symbol := range symbols {
		id := SymbolHandle(symbol)
		if _, sent := sd.scopeSentSymbols[id]; sent {
			resp.Known = append(resp.Known, id)
		} else {
			sd.scopeSentSymbols[id] = struct{}{}
			fresh = append(fresh, symbol)
		}
	}
	sd.symbolRegistryMu.Unlock()
	if len(fresh) > 0 {
		resp.Symbols = make([]*SymbolResponse, len(fresh))
		for i, symbol := range fresh {
			resp.Symbols[i] = sd.newSymbolResponse(symbol, params.Project)
		}
	}
	return resp, nil
}

// handleGetResolvedSignatureForSignatureHelp resolves a call-like expression
// under CheckMode.IsForSignatureHelp (with resolved-signature cache cleared).
// ArgumentCount -1 means undefined → use the call's argument-list length
// (stock apparentArgumentCount === undefined falls back to args.length).
func (s *Session) handleGetResolvedSignatureForSignatureHelp(ctx context.Context, params *GetResolvedSignatureForSignatureHelpParams) (*GetResolvedSignatureForSignatureHelpResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return &GetResolvedSignatureForSignatureHelpResponse{Candidates: []*SignatureResponse{}}, nil
	}

	argCount := int(params.ArgumentCount)
	if argCount < 0 {
		argCount = len(node.Arguments())
	}

	sig, candidates := checker.GetResolvedSignatureForSignatureHelp(node, argCount, setup.checker)
	resp := &GetResolvedSignatureForSignatureHelpResponse{
		Resolved:   setup.newSignatureResponse(sig),
		Candidates: make([]*SignatureResponse, len(candidates)),
	}
	for i, c := range candidates {
		resp.Candidates[i] = setup.newSignatureResponse(c)
	}
	return resp, nil
}

// handleGetExpandedParameters expands a signature's parameters (including
// union/rest expansion). Returns nested SymbolID groups; symbols are
// registered so the client can materialize them via getSymbolsDeclarations.
func (s *Session) handleGetExpandedParameters(ctx context.Context, params *GetExpandedParametersParams) ([][]SymbolID, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	sig, err := setup.resolveSignatureHandle(params.Signature)
	if err != nil {
		return nil, err
	}
	if sig == nil {
		return nil, nil
	}

	groups := setup.checker.GetExpandedParameters(sig, params.SkipUnionExpanding)
	result := make([][]SymbolID, len(groups))
	for i, group := range groups {
		ids := make([]SymbolID, len(group))
		for j, sym := range group {
			ids[j], _ = setup.sd.registerSymbol(sym, setup.projectID)
		}
		result[i] = ids
	}
	return result, nil
}

// handleHasEffectiveRestParameter reports whether a signature has an effective rest parameter.
func (s *Session) handleHasEffectiveRestParameter(ctx context.Context, params *HasEffectiveRestParameterParams) (bool, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return false, err
	}
	defer setup.done()

	sig, err := setup.resolveSignatureHandle(params.Signature)
	if err != nil {
		return false, err
	}
	if sig == nil {
		return false, nil
	}
	return setup.checker.HasEffectiveRestParameter(sig), nil
}

// handleGetLocalTypeParametersOfClassOrInterfaceOrTypeAlias returns the local
// type parameters of a class/interface/type-alias symbol. Empty → nil
// (stock undefined).
func (s *Session) handleGetLocalTypeParametersOfClassOrInterfaceOrTypeAlias(ctx context.Context, params *CheckerSymbolParams) ([]*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	symbol, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}
	if symbol == nil {
		return nil, nil
	}

	tps := setup.checker.GetLocalTypeParametersOfClassOrInterfaceOrTypeAlias(symbol)
	if len(tps) == 0 {
		return nil, nil
	}
	results := make([]*TypeResponse, len(tps))
	for i, t := range tps {
		results[i] = setup.newTypeResponse(t)
	}
	return results, nil
}

// handleGetContextualTypeForObjectLiteralElement returns the contextual type
// for an object-literal element (property/method/shorthand/spread).
func (s *Session) handleGetContextualTypeForObjectLiteralElement(ctx context.Context, params *GetContextualTypeForObjectLiteralElementParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return nil, nil
	}

	t := setup.checker.GetContextualTypeForObjectLiteralElement(node, checker.ContextFlags(params.ContextFlags))
	if t == nil {
		return nil, nil
	}
	return setup.newTypeResponse(t), nil
}

// handleIsOptionalParameter reports whether a parameter declaration is optional
// (TypeChecker.isOptionalParameter in Strada). Logic lives on EmitResolver;
// call through GetEmitResolver like isDeclarationVisible.
func (s *Session) handleIsOptionalParameter(ctx context.Context, params *CheckerNodeParams) (bool, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return false, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return false, err
	}
	if node == nil {
		return false, nil
	}

	return setup.checker.GetEmitResolver().IsOptionalParameter(node), nil
}

// handleIsImplementationOfOverload reports whether a signature declaration is
// the implementation body of an overload set (TypeChecker.isImplementationOfOverload).
func (s *Session) handleIsImplementationOfOverload(ctx context.Context, params *CheckerNodeParams) (bool, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return false, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return false, err
	}
	if node == nil {
		return false, nil
	}

	return setup.checker.IsImplementationOfOverload(node), nil
}

// handleGetParentsOfSymbols batch-resolves symbol parents (registry only —
// identical read to handleGetParentOfSymbol). A nil entry is a confirmed
// "no parent"; the client memoizes it the same way the lazy per-symbol RPC
// would.
func (s *Session) handleGetParentsOfSymbols(_ context.Context, params *GetSymbolsDeclarationsParams) ([]*SymbolResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	results := make([]*SymbolResponse, len(params.Symbols))
	for i, symHandle := range params.Symbols {
		symbol, err := sd.resolveSymbolHandle(symHandle)
		if err != nil {
			return nil, err
		}
		if symbol != nil && symbol.Parent != nil {
			// No project in the params: inherit the source symbol's canonical
			// project (it is always registered — the client got its id from us).
			results[i] = sd.newSymbolResponse(symbol.Parent, sd.canonicalProjectOf(symbol))
		}
	}
	return results, nil
}

// handleGetGlobalExportsOfSymbol returns the values of the global-exports
// table of the source file whose module symbol is params.Symbol — the
// `export as namespace` (UMD) case, where stock surfaces the table as
// file.symbol.globalExports. The wire symbol carries no file handle, so the
// source file is recovered from the symbol's declarations. Results are
// name-sorted for run stability: Go map iteration order is randomized
// (issue #42), and the table is keyed by escaped name, so name order is the
// canonical key order.
func (s *Session) handleGetGlobalExportsOfSymbol(_ context.Context, params *GetSymbolPropertyParams) ([]*SymbolResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}

	symbol, err := sd.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}

	var globalExports ast.SymbolTable
	for _, decl := range symbol.Declarations {
		sf := ast.GetSourceFileOfNode(decl)
		if sf != nil && sf.Symbol == symbol && len(sf.GlobalExports) > 0 {
			globalExports = sf.GlobalExports
			break
		}
	}
	if len(globalExports) == 0 {
		return nil, nil
	}

	symbols := make([]*ast.Symbol, 0, len(globalExports))
	for _, sub := range globalExports {
		symbols = append(symbols, sub)
	}
	slices.SortFunc(symbols, func(a, b *ast.Symbol) int {
		return strings.Compare(a.Name, b.Name)
	})

	results := make([]*SymbolResponse, len(symbols))
	for i, sub := range symbols {
		results[i] = sd.newSymbolResponse(sub, params.Project)
	}
	return results, nil
}

// handleGetSymbolDeclarations resolves a symbol by id and returns its full
// response (id/name/flags PLUS declarations + valueDeclaration). This is the
// lazy-upgrade path for "light" symbols (ambient-module and export-map
// payloads), which omit declarations to keep the wire small. The symbol is
// already registered in the snapshot registry (newLightSymbolResponse called
// registerSymbol), so no checker/project acquisition is required.
func (s *Session) handleGetSymbolDeclarations(_ context.Context, params *GetSymbolPropertyParams) (*SymbolResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	symbol, err := sd.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}
	return sd.newSymbolResponse(symbol, sd.canonicalProjectOf(symbol)), nil
}

// handleGetSymbolsDeclarations batch-resolves declaration payloads for light
// prefetch symbols. Same registry-only path as handleGetSymbolDeclarations.
func (s *Session) handleGetSymbolsDeclarations(_ context.Context, params *GetSymbolsDeclarationsParams) ([]*SymbolResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	results := make([]*SymbolResponse, len(params.Symbols))
	for i, symHandle := range params.Symbols {
		symbol, err := sd.resolveSymbolHandle(symHandle)
		if err != nil {
			return nil, err
		}
		if symbol != nil {
			results[i] = sd.newSymbolResponse(symbol, sd.canonicalProjectOf(symbol))
		}
	}
	return results, nil
}

func (s *Session) handleGetThisTypeOfType(_ context.Context, params *GetTypePropertyParams) (*TypeResponse, error) {
	return s.resolveTypePropertyOfType(params, (*checker.Type).ThisType)
}

// handleGetNonOptionalType returns the type with the optional-type marker removed
// (stock checker getNonOptionalType / removeOptionalTypeMarker).
func (s *Session) handleGetNonOptionalType(ctx context.Context, params *GetNonOptionalTypeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}

	result := setup.checker.GetNonOptionalType(t)
	if result == nil {
		return nil, nil
	}

	return setup.newTypeResponse(result), nil
}

// handleGetUnionType combines types using stock union reduction semantics.
func (s *Session) handleGetUnionType(ctx context.Context, params *GetUnionTypeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	types, err := setup.resolveTypeHandles(params.Types)
	if err != nil {
		return nil, err
	}
	if len(types) == 0 {
		return setup.newTypeResponse(setup.checker.GetNeverType()), nil
	}
	if len(types) == 1 {
		return setup.newTypeResponse(types[0]), nil
	}

	reduction := checker.UnionReduction(params.UnionReduction)
	if reduction < checker.UnionReductionNone || reduction > checker.UnionReductionSubtype {
		return nil, fmt.Errorf("%w: unknown getUnionType unionReduction %d", ErrClientError, params.UnionReduction)
	}
	result := setup.checker.GetUnionTypeEx(types, reduction)
	if result == nil {
		return nil, nil
	}
	return setup.newTypeResponse(result), nil
}

// handleGetPromisedTypeOfPromise returns the awaited value type of a promise-like type.
func (s *Session) handleGetPromisedTypeOfPromise(ctx context.Context, params *CheckerTypeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}

	result := setup.checker.GetPromisedTypeOfPromise(t)
	if result == nil {
		return nil, nil
	}
	return setup.newTypeResponse(result), nil
}

// handleGetAllPossiblePropertiesOfTypes returns merged properties for a union.
func (s *Session) handleGetAllPossiblePropertiesOfTypes(ctx context.Context, params *CheckerTypesParams) ([]*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	types, err := setup.resolveTypeHandles(params.Types)
	if err != nil {
		return nil, err
	}
	if len(types) == 0 {
		return nil, nil
	}

	props := setup.checker.GetAllPossiblePropertiesOfTypes(types)
	if len(props) == 0 {
		return nil, nil
	}

	results := make([]*SymbolResponse, len(props))
	for i, prop := range props {
		results[i] = setup.newSymbolResponse(prop)
	}
	return results, nil
}

// handleIsTypeInvalidDueToUnionDiscriminant mirrors stock checker filtering for union completions.
func (s *Session) handleIsTypeInvalidDueToUnionDiscriminant(ctx context.Context, params *IsTypeInvalidDueToUnionDiscriminantParams) (bool, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return false, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return false, err
	}
	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return false, err
	}
	if node == nil || (node.Kind != ast.KindObjectLiteralExpression && node.Kind != ast.KindJsxAttributes) {
		return false, nil
	}

	return setup.checker.IsTypeInvalidDueToUnionDiscriminant(t, node), nil
}

// handleTypeHasCallOrConstructSignatures reports whether a type is callable/constructable.
func (s *Session) handleTypeHasCallOrConstructSignatures(ctx context.Context, params *CheckerTypeParams) (bool, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return false, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return false, err
	}

	return setup.checker.TypeHasCallOrConstructSignatures(t), nil
}

// handleGetPropertiesForObjectExpression mirrors the whole stock
// Completions.getPropertiesForObjectExpression + getApparentProperties pipeline
// (see typescript-go/internal/ls/completions.go) in one round trip, returning
// every intermediate verdict so the client can seed its per-call caches: the
// stock services code still drives the same sequence of checker calls, but each
// of them becomes a cache hit instead of a synchronous NAPI round trip.
func (s *Session) handleGetPropertiesForObjectExpression(ctx context.Context, params *GetPropertiesForObjectExpressionParams) (*GetPropertiesForObjectExpressionResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	contextualType, err := setup.resolveTypeHandle(params.ContextualType)
	if err != nil {
		return nil, err
	}
	var completionsType *checker.Type
	if params.CompletionsType != 0 {
		completionsType, err = setup.resolveTypeHandle(params.CompletionsType)
		if err != nil {
			return nil, err
		}
	}
	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil || (node.Kind != ast.KindObjectLiteralExpression && node.Kind != ast.KindJsxAttributes) {
		return nil, nil
	}

	ch := setup.checker
	containsNonPublicProperties := func(props []*ast.Symbol) bool {
		for _, p := range props {
			if checker.GetDeclarationModifierFlagsFromSymbol(p)&ast.ModifierFlagsNonPublicAccessibilityModifier != 0 {
				return true
			}
		}
		return false
	}

	var members []*checker.Type
	if contextualType.IsUnion() {
		members = contextualType.Types()
	} else {
		members = []*checker.Type{contextualType}
	}

	resp := &GetPropertiesForObjectExpressionResponse{}
	promiseFiltered := make([]*checker.Type, 0, len(members))
	for _, m := range members {
		promised := ch.GetPromisedTypeOfPromise(m)
		resp.Members = append(resp.Members, &ObjectExpressionMemberResponse{
			Type:         setup.newTypeResponse(m),
			PromisedType: setup.newTypeResponse(promised),
		})
		if promised == nil {
			promiseFiltered = append(promiseFiltered, m)
		}
	}
	promiseFilteredType := ch.GetUnionType(promiseFiltered)
	resp.PromiseFilteredType = setup.newTypeResponse(promiseFilteredType)

	finalType := promiseFilteredType
	hasCompletionsType := completionsType != nil && completionsType != contextualType
	if hasCompletionsType && completionsType.Flags()&checker.TypeFlagsAnyOrUnknown == 0 {
		finalType = ch.GetUnionType([]*checker.Type{promiseFilteredType, completionsType})
		resp.MergedType = setup.newTypeResponse(finalType)
	}

	var properties []*ast.Symbol
	if finalType.IsUnion() {
		finalMembers := finalType.Types()
		filtered := make([]*checker.Type, 0, len(finalMembers))
		for _, m := range finalMembers {
			fm := &ObjectExpressionFinalMemberResponse{Type: setup.newTypeResponse(m)}
			resp.FinalMembers = append(resp.FinalMembers, fm)
			// Stock short-circuits on primitives before any checker call, so
			// skip the verdicts it will never ask for.
			if m.Flags()&checker.TypeFlagsPrimitive != 0 {
				continue
			}
			fm.IsArrayLike = ch.IsArrayLikeType(m)
			fm.InvalidDueToDiscriminant = ch.IsTypeInvalidDueToUnionDiscriminant(m, node)
			fm.HasCallOrConstruct = ch.TypeHasCallOrConstructSignatures(m)
			classNonPublic := false
			if m.IsClass() {
				apparent := ch.GetApparentProperties(m)
				fm.ApparentProperties = make([]*SymbolResponse, len(apparent))
				for i, p := range apparent {
					fm.ApparentProperties[i] = setup.newSymbolResponse(p)
				}
				classNonPublic = containsNonPublicProperties(apparent)
			}
			if fm.IsArrayLike || fm.InvalidDueToDiscriminant || fm.HasCallOrConstruct || classNonPublic {
				continue
			}
			filtered = append(filtered, m)
			resp.FilteredTypes = append(resp.FilteredTypes, fm.Type.Id)
		}
		properties = ch.GetAllPossiblePropertiesOfTypes(filtered)
	} else {
		properties = ch.GetApparentProperties(finalType)
	}
	resp.Properties = make([]*SymbolResponse, len(properties))
	for i, p := range properties {
		resp.Properties[i] = setup.newSymbolResponse(p)
	}
	return resp, nil
}

// handleTypeParameterToDeclaration converts a type parameter Type to its
// TypeParameterDeclaration AST (stock checker typeParameterToDeclaration,
// used by SymbolDisplay to render e.g. "Row extends BaseRow").
func (s *Session) handleTypeParameterToDeclaration(ctx context.Context, params *TypeToTypeNodeParams) (any, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}

	var enclosingDeclaration *ast.Node
	if params.Location != "" {
		enclosingDeclaration, err = setup.sd.resolveNodeHandle(setup.program, params.Location)
		if err != nil {
			return nil, err
		}
	}

	node := setup.checker.TypeParameterToDeclaration(t, enclosingDeclaration, nodebuilder.Flags(params.Flags))
	if node == nil {
		return nil, nil
	}

	data, _, err := encoder.EncodeNode(node, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to encode type parameter declaration: %w", err)
	}

	if s.useBinaryResponses {
		return RawBinary(data), nil
	}
	return &SourceFileResponse{
		Data: base64.StdEncoding.EncodeToString(data),
	}, nil
}

// handleSymbolToTypeParameterDeclarations builds the TypeParameterDeclaration
// nodes of a class/interface/type-alias symbol (stock checker
// symbolToTypeParameterDeclarations, used by SymbolDisplay to render e.g.
// "interface Wrap<W>"). Returns one base64-encoded node per type parameter;
// JSON response regardless of transport since the binary channel carries a
// single blob only.
func (s *Session) handleSymbolToTypeParameterDeclarations(ctx context.Context, params *SymbolToTypeParameterDeclarationsParams) (any, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	symbol, err := setup.sd.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}

	var enclosingDeclaration *ast.Node
	if params.Location != "" {
		enclosingDeclaration, err = setup.sd.resolveNodeHandle(setup.program, params.Location)
		if err != nil {
			return nil, err
		}
	}

	nodes := setup.checker.SymbolToTypeParameterDeclarations(symbol, enclosingDeclaration, nodebuilder.Flags(params.Flags))
	encoded := make([]string, 0, len(nodes))
	for _, node := range nodes {
		data, _, err := encoder.EncodeNode(node, nil)
		if err != nil {
			return nil, fmt.Errorf("failed to encode type parameter declaration: %w", err)
		}
		encoded = append(encoded, base64.StdEncoding.EncodeToString(data))
	}
	return encoded, nil
}

// handleSymbolToParameterDeclaration builds a ParameterDeclaration AST node
// from a parameter symbol (stock checker symbolToParameterDeclaration, used by
// signatureHelp itemInfoForParameters).
func (s *Session) handleSymbolToParameterDeclaration(ctx context.Context, params *SymbolToParameterDeclarationParams) (any, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	symbol, err := setup.sd.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}

	var enclosingDeclaration *ast.Node
	if params.Location != "" {
		enclosingDeclaration, err = setup.sd.resolveNodeHandle(setup.program, params.Location)
		if err != nil {
			return nil, err
		}
	}

	node := setup.checker.SymbolToParameterDeclaration(symbol, enclosingDeclaration, nodebuilder.Flags(params.Flags))
	if node == nil {
		return nil, nil
	}

	data, _, err := encoder.EncodeNode(node, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to encode parameter declaration: %w", err)
	}

	if s.useBinaryResponses {
		return RawBinary(data), nil
	}
	return &SourceFileResponse{
		Data: base64.StdEncoding.EncodeToString(data),
	}, nil
}

// handleSignatureToString converts a Signature to its string representation
// (stock checker signatureToString / signatureToStringEx).
func (s *Session) handleSignatureToString(ctx context.Context, params *SignatureToStringParams) (string, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return "", err
	}
	defer setup.done()

	sig, err := setup.resolveSignatureHandle(params.Signature)
	if err != nil {
		return "", err
	}

	var enclosingDeclaration *ast.Node
	if params.Location != "" {
		enclosingDeclaration, err = setup.sd.resolveNodeHandle(setup.program, params.Location)
		if err != nil {
			return "", err
		}
	}

	return setup.checker.SignatureToStringEx(sig, enclosingDeclaration, checker.TypeFormatFlags(params.Flags), nil), nil
}

// handleIsDeclarationVisible reports whether a declaration node is visible for
// declaration-emit purposes (TypeChecker.isDeclarationVisible in Strada).
func (s *Session) handleIsDeclarationVisible(ctx context.Context, params *CheckerNodeParams) (bool, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return false, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return false, err
	}
	if node == nil {
		return false, nil
	}

	return setup.checker.GetEmitResolver().IsDeclarationVisible(node), nil
}

// handleTryGetThisTypeAt returns the type of `this` at a node location, if any.
func (s *Session) handleTryGetThisTypeAt(ctx context.Context, params *TryGetThisTypeAtParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return nil, nil
	}

	var container *ast.Node
	if params.Container != "" {
		container, err = setup.sd.resolveNodeHandle(setup.program, params.Container)
		if err != nil {
			return nil, err
		}
	}

	t := setup.checker.TryGetThisTypeAtEx(node, params.IncludeGlobalThis, container)
	if t == nil {
		return nil, nil
	}

	return setup.newTypeResponse(t), nil
}

// handleIsValidPropertyAccessForCompletions reports whether a property symbol
// is accessible from a property-access location (completion filtering).
func (s *Session) handleIsValidPropertyAccessForCompletions(ctx context.Context, params *IsValidPropertyAccessForCompletionsParams) (bool, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return false, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return false, err
	}
	if node == nil {
		return false, nil
	}

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return false, err
	}

	symbol, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return false, err
	}
	if symbol == nil {
		return false, nil
	}

	return setup.checker.IsValidPropertyAccessForCompletions(node, t, symbol), nil
}

// handleGetTypeArgumentConstraint returns the constraint type for a type-argument TypeNode.
func (s *Session) handleGetTypeArgumentConstraint(ctx context.Context, params *CheckerNodeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return nil, nil
	}

	t := setup.checker.GetTypeArgumentConstraint(node)
	if t == nil {
		return nil, nil
	}
	return setup.newTypeResponse(t), nil
}

// handleGetExportsAndPropertiesOfModule returns module exports plus export=
// value properties (stock getExportsAndPropertiesOfModule).
func (s *Session) handleGetExportsAndPropertiesOfModule(ctx context.Context, params *CheckerSymbolParams) ([]*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	symbol, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}
	if symbol == nil {
		return nil, nil
	}

	exports := setup.checker.GetExportsAndPropertiesOfModule(symbol)
	results := make([]*SymbolResponse, len(exports))
	for i, exp := range exports {
		results[i] = setup.newSymbolResponse(exp)
	}
	return results, nil
}

// handleGetJsxIntrinsicTagNamesAt returns JSX.IntrinsicElements properties at a location.
func (s *Session) handleGetJsxIntrinsicTagNamesAt(ctx context.Context, params *CheckerNodeParams) ([]*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return nil, nil
	}

	syms := setup.checker.GetJsxIntrinsicTagNamesAt(node)
	results := make([]*SymbolResponse, len(syms))
	for i, sym := range syms {
		results[i] = setup.newSymbolResponse(sym)
	}
	return results, nil
}

// handleIsPropertyAccessible reports whether a property is accessible from a node.
func (s *Session) handleIsPropertyAccessible(ctx context.Context, params *IsPropertyAccessibleParams) (bool, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return false, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return false, err
	}
	if node == nil {
		return false, nil
	}

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return false, err
	}

	symbol, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return false, err
	}
	if symbol == nil {
		return false, nil
	}

	return setup.checker.IsPropertyAccessible(node, params.IsSuper, params.IsWrite, t, symbol), nil
}

// handleGetAccessibleSymbolChain returns an accessible alias chain, or nil when
// no chain exists (stock undefined — not an empty array).
func (s *Session) handleGetAccessibleSymbolChain(ctx context.Context, params *GetAccessibleSymbolChainParams) ([]*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	symbol, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}
	if symbol == nil {
		return nil, nil
	}

	var enclosing *ast.Node
	if params.EnclosingDeclaration != "" {
		enclosing, err = setup.sd.resolveNodeHandle(setup.program, params.EnclosingDeclaration)
		if err != nil {
			return nil, err
		}
	}

	chain := setup.checker.GetAccessibleSymbolChain(symbol, enclosing, ast.SymbolFlags(params.Meaning), params.UseOnlyExternalAliasing)
	// Stock returns undefined when no chain exists — Go may yield nil or empty
	// slice; both must marshal as JSON null so the JS client returns undefined
	// (not []). A real empty chain does not occur for accessible lookups.
	if len(chain) == 0 {
		return nil, nil
	}
	results := make([]*SymbolResponse, len(chain))
	for i, sym := range chain {
		results[i] = setup.newSymbolResponse(sym)
	}
	return results, nil
}

// handleGetContextualTypeForArgumentAtIndex returns the contextual type of a
// call-like argument at the given index.
func (s *Session) handleGetContextualTypeForArgumentAtIndex(ctx context.Context, params *GetContextualTypeForArgumentAtIndexParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return nil, nil
	}

	t := setup.checker.GetContextualTypeForArgumentAtIndex(node, int(params.ArgIndex))
	if t == nil {
		return nil, nil
	}
	return setup.newTypeResponse(t), nil
}

// handleGetContextualTypeForJsxAttribute returns the contextual type of a JSX
// attribute (Go has no contextFlags; LS callers omit flags).
func (s *Session) handleGetContextualTypeForJsxAttribute(ctx context.Context, params *CheckerNodeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return nil, nil
	}

	t := setup.checker.GetContextualTypeForJsxAttribute(node)
	if t == nil {
		return nil, nil
	}
	return setup.newTypeResponse(t), nil
}

// handleIsValidPropertyAccess reports whether a property name is valid on a node.
func (s *Session) handleIsValidPropertyAccess(ctx context.Context, params *IsValidPropertyAccessParams) (bool, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return false, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return false, err
	}
	if node == nil {
		return false, nil
	}

	return setup.checker.IsValidPropertyAccess(node, params.PropertyName), nil
}

// handleGetCandidateSignaturesForStringLiteralCompletions returns candidate
// signatures for string-literal argument completions.
func (s *Session) handleGetCandidateSignaturesForStringLiteralCompletions(ctx context.Context, params *GetCandidateSignaturesForStringLiteralCompletionsParams) ([]*SignatureResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	call, err := setup.sd.resolveNodeHandle(setup.program, params.Call)
	if err != nil {
		return nil, err
	}
	if call == nil {
		return nil, nil
	}

	editing, err := setup.sd.resolveNodeHandle(setup.program, params.EditingArgument)
	if err != nil {
		return nil, err
	}
	if editing == nil {
		return nil, nil
	}

	sigs := setup.checker.GetCandidateSignaturesForStringLiteralCompletions(call, editing)
	results := make([]*SignatureResponse, len(sigs))
	for i, sig := range sigs {
		results[i] = setup.newSignatureResponse(sig)
	}
	return results, nil
}

// handleGetSymbolsOfParameterPropertyDeclaration returns the parameter and
// property symbols for a parameter-property declaration (length-2 array).
func (s *Session) handleGetSymbolsOfParameterPropertyDeclaration(ctx context.Context, params *GetSymbolsOfParameterPropertyDeclarationParams) ([]*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return nil, nil
	}

	paramSym, propSym := setup.checker.GetSymbolsOfParameterPropertyDeclaration(node, params.ParameterName)
	return []*SymbolResponse{
		setup.newSymbolResponse(paramSym),
		setup.newSymbolResponse(propSym),
	}, nil
}

func materializeIndexInfo(setup checkerSetup, info *checker.IndexInfo) *IndexInfoResponse {
	if info == nil {
		return nil
	}
	resp := &IndexInfoResponse{
		KeyType:    *setup.newTypeResponse(info.KeyType()),
		ValueType:  *setup.newTypeResponse(info.ValueType()),
		IsReadonly: info.IsReadonly(),
	}
	if info.Declaration() != nil {
		resp.Declaration = nodeHandleFrom(info.Declaration())
		if sym := setup.checker.GetSymbolOfDeclaration(info.Declaration()); sym != nil {
			resp.Symbol = setup.newSymbolResponse(sym)
		}
	}
	return resp
}

// handleGetAwaitedType returns the awaited type of a promise-like type.
func (s *Session) handleGetAwaitedType(ctx context.Context, params *CheckerTypeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}

	result := setup.checker.GetAwaitedType(t)
	if result == nil {
		return nil, nil
	}
	return setup.newTypeResponse(result), nil
}

// handleGetNullableType returns type with null/undefined flags added.
func (s *Session) handleGetNullableType(ctx context.Context, params *GetNullableTypeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}

	result := setup.checker.GetNullableType(t, checker.TypeFlags(params.Flags))
	if result == nil {
		return nil, nil
	}
	return setup.newTypeResponse(result), nil
}

// handleIsNullableType reports whether a type is nullable.
func (s *Session) handleIsNullableType(ctx context.Context, params *CheckerTypeParams) (bool, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return false, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return false, err
	}
	return setup.checker.IsNullableType(t), nil
}

// handleGetElementTypeOfArrayType returns the element type of an array type.
func (s *Session) handleGetElementTypeOfArrayType(ctx context.Context, params *CheckerTypeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}

	result := setup.checker.GetElementTypeOfArrayType(t)
	if result == nil {
		return nil, nil
	}
	return setup.newTypeResponse(result), nil
}

// handleGetIndexInfoOfType returns the index info for a type by IndexKind.
func (s *Session) handleGetIndexInfoOfType(ctx context.Context, params *GetIndexKindParams) (*IndexInfoResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}

	return materializeIndexInfo(setup, setup.checker.GetIndexInfoOfTypeByKind(t, params.Kind)), nil
}

// handleGetIndexTypeOfTypeForKind returns the index type for a type by IndexKind.
func (s *Session) handleGetIndexTypeOfTypeForKind(ctx context.Context, params *GetIndexKindParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}

	result := setup.checker.GetIndexTypeOfTypeByKind(t, params.Kind)
	if result == nil {
		return nil, nil
	}
	return setup.newTypeResponse(result), nil
}

// handleGetTypeOfPropertyOfType returns the type of a named property on a type.
func (s *Session) handleGetTypeOfPropertyOfType(ctx context.Context, params *GetPropertyOfTypeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}

	result := setup.checker.GetTypeOfPropertyOfType(t, params.Name)
	if result == nil {
		return nil, nil
	}
	return setup.newTypeResponse(result), nil
}

// handleGetTypeOfPropertyOfContextualType returns the type of a named property of a contextual type.
func (s *Session) handleGetTypeOfPropertyOfContextualType(ctx context.Context, params *GetPropertyOfTypeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}

	result := setup.checker.GetTypeOfPropertyOfContextualType(t, params.Name)
	if result == nil {
		return nil, nil
	}
	return setup.newTypeResponse(result), nil
}

// handleFillMissingTypeArguments fills missing type arguments using defaults.
func (s *Session) handleFillMissingTypeArguments(ctx context.Context, params *FillMissingTypeArgumentsParams) ([]*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	typeArgs, err := setup.resolveTypeHandles(params.TypeArguments)
	if err != nil {
		return nil, err
	}
	typeParams, err := setup.resolveTypeHandles(params.TypeParameters)
	if err != nil {
		return nil, err
	}

	filled := setup.checker.FillMissingTypeArguments(typeArgs, typeParams, int(params.MinTypeArgumentCount), params.IsJavaScriptImplicitAny)
	if filled == nil {
		return []*TypeResponse{}, nil
	}
	results := make([]*TypeResponse, len(filled))
	for i, t := range filled {
		results[i] = setup.newTypeResponse(t)
	}
	return results, nil
}

// handleGetWidenedLiteralType returns the widened literal type.
func (s *Session) handleGetWidenedLiteralType(ctx context.Context, params *CheckerTypeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}

	result := setup.checker.GetWidenedLiteralType(t)
	if result == nil {
		return nil, nil
	}
	return setup.newTypeResponse(result), nil
}

// handleGetUnmatchedProperties returns properties on target unmatched by source.
func (s *Session) handleGetUnmatchedProperties(ctx context.Context, params *GetUnmatchedPropertiesParams) ([]*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	source, err := setup.resolveTypeHandle(params.Source)
	if err != nil {
		return nil, err
	}
	target, err := setup.resolveTypeHandle(params.Target)
	if err != nil {
		return nil, err
	}

	props := setup.checker.GetUnmatchedProperties(source, target, params.RequireOptionalProperties, params.MatchDiscriminantProperties)
	results := make([]*SymbolResponse, len(props))
	for i, prop := range props {
		results[i] = setup.newSymbolResponse(prop)
	}
	return results, nil
}

// handleIsEmptyAnonymousObjectType reports whether a type is an empty anonymous object.
func (s *Session) handleIsEmptyAnonymousObjectType(ctx context.Context, params *CheckerTypeParams) (bool, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return false, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return false, err
	}
	return setup.checker.IsEmptyAnonymousObjectType(t), nil
}

// handleIsLibType reports whether a type is declared in a lib file.
func (s *Session) handleIsLibType(ctx context.Context, params *CheckerTypeParams) (bool, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return false, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return false, err
	}
	return setup.checker.IsLibType(t), nil
}

// handleSymbolIsValue reports whether a symbol is a value.
func (s *Session) handleSymbolIsValue(ctx context.Context, params *CheckerSymbolParams) (bool, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return false, err
	}
	defer setup.done()

	symbol, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return false, err
	}
	if symbol == nil {
		return false, nil
	}
	return setup.checker.SymbolIsValue(symbol), nil
}

// handleGetModuleSymbolForSourceFile returns the module symbol bound to an external source file.
func (s *Session) handleGetModuleSymbolForSourceFile(ctx context.Context, params *GetSourceFileParams) (*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	sourceFile := setup.program.GetSourceFile(params.File.ToFileName())
	if sourceFile == nil || sourceFile.Symbol == nil {
		return nil, nil
	}

	return setup.newSymbolResponse(sourceFile.Symbol), nil
}

// handleGetRootSymbols returns the root symbols of a symbol (unwrapping
// synthetic union/intersection properties, spreads, and instantiation targets).
func (s *Session) handleGetRootSymbols(ctx context.Context, params *CheckerSymbolParams) ([]*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	symbol, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}
	if symbol == nil {
		return nil, nil
	}

	roots := setup.checker.GetRootSymbols(symbol)
	results := make([]*SymbolResponse, len(roots))
	for i, root := range roots {
		results[i] = setup.newSymbolResponse(root)
	}

	return results, nil
}

// handleResolveExternalModuleSymbol resolves a module symbol to its export= target
// (with CJS merge), matching stock checker.resolveExternalModuleSymbol.
func (s *Session) handleResolveExternalModuleSymbol(ctx context.Context, params *CheckerSymbolParams) (*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	symbol, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}
	if symbol == nil {
		return nil, nil
	}

	resolved := setup.checker.ResolveExternalModuleSymbol(symbol)
	if resolved == nil {
		return nil, nil
	}

	return setup.newSymbolResponse(resolved), nil
}

// handleEmit runs the program emitter and returns the produced files for the JS
// host to write — keeping --noEmit, Volar output redirection, and build-mode
// writeFile wrapping under the host's control rather than writing from Go.
func (s *Session) handleEmit(ctx context.Context, params *EmitParams) (*EmitResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}
	sourceFile, err := s.resolveOptionalSourceFile(program, params.File)
	if err != nil {
		return nil, err
	}

	// Emit gates stock applies in program.emit, driven by the program's
	// options (which the client host's effective options now feed — CLI-only
	// flags included): --noEmit skips emit outright (forced d.ts emit of
	// referenced projects excepted), --emitDeclarationOnly narrows the default
	// EmitOnly to declarations.
	options := program.Options()
	if options.NoEmit.IsTrue() && !params.ForceDtsEmit {
		return &EmitResponse{EmitSkipped: true}, nil
	}

	emitOnly := compiler.EmitAll
	if params.ForceDtsEmit {
		emitOnly = compiler.EmitOnlyForcedDts
	} else if params.EmitOnly != nil {
		emitOnly = compiler.EmitOnly(*params.EmitOnly)
	} else if options.EmitDeclarationOnly.IsTrue() {
		emitOnly = compiler.EmitOnlyDts
	}

	var mu sync.Mutex
	var outputs []*EmitOutputFile
	result := program.Emit(ctx, compiler.EmitOptions{
		TargetSourceFile: sourceFile,
		EmitOnly:         emitOnly,
		WriteFile: func(fileName string, text string, _ *compiler.WriteFileData) error {
			mu.Lock()
			outputs = append(outputs, &EmitOutputFile{FileName: fileName, Text: text})
			mu.Unlock()
			return nil
		},
	})
	if result == nil {
		return &EmitResponse{EmitSkipped: true}, nil
	}
	return &EmitResponse{
		EmitSkipped:  result.EmitSkipped,
		Diagnostics:  NewDiagnosticResponses(result.Diagnostics),
		EmittedFiles: result.EmittedFiles,
		OutputFiles:  outputs,
	}, nil
}

// handleEmitBuildInfo serializes the project's incremental build state to
// .tsbuildinfo content and returns it for the JS host to write — mirroring
// handleEmit's contract (host owns file I/O). It reuses the execute/incremental
// machinery end to end: the prior buildinfo is read from disk to seed the old
// state (so unchanged-file diagnostics/signatures are reused exactly like
// `tsgo --build`), the snapshot's semantic-diagnostics cache is populated via
// the incremental affected-files path, and snapshotToBuildInfo does the
// serialization. No buildinfo logic is duplicated here.
func (s *Session) handleEmitBuildInfo(ctx context.Context, params *EmitBuildInfoParams) (*EmitResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}

	// Incremental-capable projects serialize the same wrapper that served
	// this run's diagnostic RPCs (getIncrementalProgram): its per-file cache
	// already holds the buildinfo-restored diagnostics plus any re-checked
	// affected files, so no state is rebuilt or re-read here.
	incrementalProgram := sd.getIncrementalProgram(program)
	if incrementalProgram == nil {
		config := program.CommandLine()
		// In `tsc -b` the build flag reaches every project's options via the CLI
		// merge; API projects are parsed from the tsconfig alone, so layer it here.
		// Without it GetBuildInfoFileName resolves to "" for non-incremental
		// projects and no buildinfo would ever be produced in build mode.
		if params.Build && !config.CompilerOptions().Build.IsTrue() {
			buildOptions := config.CompilerOptions().Clone()
			buildOptions.Build = core.TSTrue
			config = config.WithCompilerOptions(buildOptions)
		}
		host := program.Host()
		oldProgram := incremental.ReadBuildInfoProgram(config, incremental.NewBuildInfoReader(host), host)
		incrementalProgram = incremental.NewProgramWithOptions(program, oldProgram, incremental.CreateHost(host), config.CompilerOptions())

		// Reuse the whole-program semantic pass already computed on this live
		// program during this run (getGlobalDiagnostics memoizes it): seed the
		// snapshot's per-file diagnostics cache from it instead of re-checking.
		// GetSemanticDiagnostics below then only performs the incremental
		// affected-files bookkeeping and fills any files the pass didn't cover.
		// Files left uncached would be encoded as check-pending in the buildinfo
		// and defeat up-to-date detection.
		sd.seedFromSemanticDiagMemo(incrementalProgram, program)
	}
	incrementalProgram.GetSemanticDiagnostics(ctx, nil)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}

	// The JS builder owns the emit-pending decision and only issues this RPC
	// when a buildinfo write is due (stock Program.emitBuildInfo also writes
	// unconditionally at this layer). Forcing the write keeps the buildinfo
	// mtime fresh, which the solution builder's up-to-date checks rely on.
	incrementalProgram.MarkBuildInfoEmitPending()

	var mu sync.Mutex
	var outputs []*EmitOutputFile
	result := incrementalProgram.EmitBuildInfoFile(ctx, compiler.EmitOptions{
		WriteFile: func(fileName string, text string, _ *compiler.WriteFileData) error {
			mu.Lock()
			outputs = append(outputs, &EmitOutputFile{FileName: fileName, Text: text})
			mu.Unlock()
			return nil
		},
	})
	if result == nil {
		// Nothing pending: prior buildinfo on disk is already current.
		return &EmitResponse{EmitSkipped: true}, nil
	}
	return &EmitResponse{
		EmitSkipped:  result.EmitSkipped,
		Diagnostics:  NewDiagnosticResponses(result.Diagnostics),
		EmittedFiles: result.EmittedFiles,
		OutputFiles:  outputs,
	}, nil
}

// scriptKindToLanguageKind maps TypeScript ScriptKind values (from the fork
// overlay) to lsproto LanguageKind for host-fed content overrides. When the
// host sends virtual TS for a .vue path, ScriptKind must be honoured — the
// file extension alone is not enough.
func scriptKindToLanguageKind(scriptKind int) lsproto.LanguageKind {
	switch core.ScriptKind(scriptKind) {
	case core.ScriptKindTS:
		return lsproto.LanguageKindTypeScript
	case core.ScriptKindJS:
		return lsproto.LanguageKindJavaScript
	case core.ScriptKindJSX:
		return lsproto.LanguageKindJavaScriptReact
	case core.ScriptKindTSX:
		return lsproto.LanguageKindTypeScriptReact
	case core.ScriptKindJSON:
		return lsproto.LanguageKindJSON
	default:
		return ""
	}
}

// seedFromSemanticDiagMemo seeds an incremental program wrapper's per-file
// diagnostics cache from the memoized whole-program pass, if one was computed
// for this program during this run. No pass is forced here: when the memo is
// absent (emitBuildInfo without prior whole-program diagnostics), the
// incremental wrapper's own affected-files path remains the cheapest route.
func (sd *snapshotData) seedFromSemanticDiagMemo(incrementalProgram *incremental.Program, program *compiler.Program) {
	sd.semanticDiagMemoMu.Lock()
	memo := sd.semanticDiagMemo[program]
	sd.semanticDiagMemoMu.Unlock()
	if memo != nil {
		incrementalProgram.SeedSemanticDiagnostics(memo)
	}
}

// newLightSymbolResponse registers a symbol and returns id/name/flags only (no declarations).
func (sd *snapshotData) newLightSymbolResponse(symbol *ast.Symbol, canonicalProject ProjectID) *LightSymbolResponse {
	if symbol == nil {
		return nil
	}
	id, project := sd.registerSymbol(symbol, canonicalProject)
	resp := &LightSymbolResponse{
		Id:         id,
		Project:    project,
		Name:       symbol.Name,
		Flags:      uint32(symbol.Flags),
		CheckFlags: uint32(symbol.CheckFlags),
	}
	if symbol.Parent != nil {
		resp.Parent = SymbolHandle(symbol.Parent)
		sd.registerSymbol(symbol.Parent, canonicalProject)
	}
	return resp
}

// handleGetBuilderFileGraph returns builder-state metadata for every program
// file in one batch: content-hash version, referenced-file edges, global-scope
// effect and implied module format. The JS-side BuilderProgram (tsslint layer-2
// type-aware cache, solution-build state) consumes this instead of re-deriving
// the graph through per-import checker RPCs — the computation is shared with
// programToSnapshot, so the external builder invalidates exactly like tsgo's
// own --incremental. No semantic pass runs: import resolution is alias-level.
func (s *Session) handleGetBuilderFileGraph(ctx context.Context, params *GetBuilderFileGraphParams) ([]*BuilderFileGraphEntry, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}

	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}

	entries := sd.builderFileGraph(program)
	result := make([]*BuilderFileGraphEntry, len(entries))
	for i := range entries {
		e := &entries[i]
		result[i] = &BuilderFileGraphEntry{
			FileName:           e.File.FileName(),
			Version:            e.Version,
			AffectsGlobalScope: e.AffectsGlobalScope,
			ImpliedNodeFormat:  int32(e.ImpliedNodeFormat),
			Refs:               e.ReferencedFiles,
		}
	}
	return result, nil
}

// handleGetMissingFilePaths returns the paths referenced during program
// creation but not found on disk; the JS watch layer installs watchers on
// them (stock updateMissingFilePathsWatch).
func (s *Session) handleGetMissingFilePaths(ctx context.Context, params *GetProgramInfoParams) ([]string, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}

	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}

	return program.MissingFilePaths(), nil
}

// handleGetFileIncludeReasons returns the stock-shaped include reasons for
// every program file (tsc --explainFiles, FAR non-module references,
// module-specifier reuse). Payload DTOs come from
// internal/compiler/programinfo.go.
func (s *Session) handleGetFileIncludeReasons(ctx context.Context, params *GetProgramInfoParams) ([]*compiler.FileIncludeReasonsForFileWire, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}

	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}

	return program.FileIncludeReasonsWire(), nil
}

// handleGetProgramResolutionInfo returns the program's full resolution state
// (per-file module and type-reference-directive caches plus automatic type
// directive resolutions) for the JS thin program's lazily materialized
// resolvedModules / resolvedTypeReferenceDirectiveNames.
func (s *Session) handleGetProgramResolutionInfo(ctx context.Context, params *GetProgramInfoParams) (*compiler.ResolutionsWire, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}

	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}

	return program.ResolutionsWire(), nil
}

// handleGetClassifiableNames returns the union of every program file's
// binder-collected classifiable names — the pre-filter set the stock v1
// semantic classifier gates identifier classification on.
func (s *Session) handleGetClassifiableNames(ctx context.Context, params *GetProgramInfoParams) ([]string, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}

	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}

	return program.ClassifiableNamesUnion(), nil
}

// handleGetUsesUriStyleNodeCoreModules returns stock's program-level tristate
// for node:-prefixed core-module specifiers (auto-import specifier style).
// nil on the wire is stock's undefined.
func (s *Session) handleGetUsesUriStyleNodeCoreModules(ctx context.Context, params *GetProgramInfoParams) (*bool, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}

	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}

	switch program.AggregateUsesUriStyleNodeCoreModules() {
	case core.TSTrue:
		result := true
		return &result, nil
	case core.TSFalse:
		result := false
		return &result, nil
	default:
		return nil, nil
	}
}

// handleGetAmbientModules returns only ambient module names and light symbols.
// It intentionally avoids the named/default export and importability work done
// by handleGetModuleExportMap.
func (s *Session) handleGetAmbientModules(ctx context.Context, params *GetAmbientModulesParams) (*AmbientModulesResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}

	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}

	return computeAmbientModules(program, sd, params.Project)
}

// handleGetModuleExportMap returns the auto-import export index for every
// external/ambient module in one batch, mirroring stock exportInfoMap populate
// (getDefaultLikeExportInfo + forEachExportAndPropertyOfModule +
// isImportableSymbol). Memoized per program identity on the snapshot, served
// as the self-contained binary codec on the binary transport.
func (s *Session) handleGetModuleExportMap(ctx context.Context, params *GetModuleExportMapParams) (any, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}

	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}

	entry, err := sd.moduleExportMap(ctx, program, params.Project)
	if err != nil {
		return nil, err
	}
	if s.useBinaryResponses {
		return RawBinary(entry.blob), nil
	}
	return entry.resp, nil
}

// handleGetModuleSpecifiersBatch resolves auto-import module specifiers for
// many module symbols in one RPC, mirroring stock getModuleSpecifiersWithCacheInfo.
// With AllModules set, the symbol list comes from the memoized export map —
// completions' Node16/Bundler path otherwise ships the whole map across just
// to feed moduleSymbol ids back in.
func (s *Session) handleGetModuleSpecifiersBatch(ctx context.Context, params *GetModuleSpecifiersBatchParams) (*ModuleSpecifiersBatchResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}

	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}

	importingSourceFile, err := s.resolveOptionalSourceFile(program, params.File)
	if err != nil {
		return nil, err
	}
	if importingSourceFile == nil {
		return &ModuleSpecifiersBatchResponse{}, nil
	}

	moduleSymbols := params.ModuleSymbols
	if params.AllModules {
		entry, err := sd.moduleExportMap(ctx, program, params.Project)
		if err != nil {
			return nil, err
		}
		moduleSymbols = make([]SymbolID, 0, len(entry.resp.Modules))
		for _, mod := range entry.resp.Modules {
			if mod.ModuleSymbol != nil {
				moduleSymbols = append(moduleSymbols, mod.ModuleSymbol.Id)
			}
		}
	}

	preferences := toModuleSpecifiersUserPreferences(params.Preferences)
	return computeModuleSpecifiersBatch(ctx, program, importingSourceFile, moduleSymbols, preferences, sd)
}

func resolutionModeResponse(mode core.ResolutionMode) *ResolutionModeResponse {
	if mode == core.ModuleKindNone {
		return &ResolutionModeResponse{Mode: nil}
	}
	v := int32(mode)
	return &ResolutionModeResponse{Mode: &v}
}

func stringLiteralLikeAtPosition(sourceFile *ast.SourceFile, position int) *ast.Node {
	pm := sourceFile.GetPositionMap()
	pos := pm.UTF16ToUTF8(int(position))
	node := astnav.GetTouchingPropertyName(sourceFile, pos)
	for node != nil {
		if ast.IsStringLiteralLike(node) {
			return node
		}
		node = node.Parent
	}
	return nil
}

// handleGetCompilerOptionsForFile returns effective compiler options for a file,
// including project-reference redirect overrides.
func (s *Session) handleGetCompilerOptionsForFile(ctx context.Context, params *GetDiagnosticsParams) (*core.CompilerOptions, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}
	sourceFile, err := s.resolveOptionalSourceFile(program, params.File)
	if err != nil {
		return nil, err
	}
	if sourceFile == nil {
		return program.Options(), nil
	}
	return program.GetCompilerOptionsForFile(sourceFile), nil
}

func (s *Session) handleGetImpliedNodeFormatForEmit(ctx context.Context, params *GetDiagnosticsParams) (*ResolutionModeResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}
	sourceFile, err := s.resolveOptionalSourceFile(program, params.File)
	if err != nil || sourceFile == nil {
		return nil, err
	}
	return resolutionModeResponse(program.GetImpliedNodeFormatForEmit(sourceFile)), nil
}

func (s *Session) handleGetDefaultResolutionModeForFile(ctx context.Context, params *GetDiagnosticsParams) (*ResolutionModeResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}
	sourceFile, err := s.resolveOptionalSourceFile(program, params.File)
	if err != nil || sourceFile == nil {
		return nil, err
	}
	return resolutionModeResponse(program.GetDefaultResolutionModeForFile(sourceFile)), nil
}

func (s *Session) handleGetEmitModuleFormatOfFile(ctx context.Context, params *GetDiagnosticsParams) (*ModuleKindResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}
	sourceFile, err := s.resolveOptionalSourceFile(program, params.File)
	if err != nil || sourceFile == nil {
		return nil, err
	}
	return &ModuleKindResponse{Kind: int32(program.GetEmitModuleFormatOfFile(sourceFile))}, nil
}

func (s *Session) handleGetModeForUsageLocation(ctx context.Context, params *GetModeForUsageLocationParams) (*ResolutionModeResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}
	sourceFile := program.GetSourceFile(params.File.ToFileName())
	if sourceFile == nil {
		return nil, fmt.Errorf("%w: source file not found: %v", ErrClientError, params.File)
	}
	usage := stringLiteralLikeAtPosition(sourceFile, int(params.Position))
	if usage == nil {
		return resolutionModeResponse(core.ModuleKindNone), nil
	}
	return resolutionModeResponse(program.GetModeForUsageLocation(sourceFile, usage)), nil
}

func (s *Session) handleGetEmitSyntaxForUsageLocation(ctx context.Context, params *GetModeForUsageLocationParams) (*ResolutionModeResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}
	sourceFile := program.GetSourceFile(params.File.ToFileName())
	if sourceFile == nil {
		return nil, fmt.Errorf("%w: source file not found: %v", ErrClientError, params.File)
	}
	usage := stringLiteralLikeAtPosition(sourceFile, int(params.Position))
	if usage == nil {
		return resolutionModeResponse(core.ModuleKindNone), nil
	}
	return resolutionModeResponse(program.GetEmitSyntaxForUsageLocation(sourceFile, usage)), nil
}

func (s *Session) handleGetRedirectTargets(ctx context.Context, params *GetDiagnosticsParams) (*RedirectTargetsResponse, error) {
	sd, err := s.getSnapshotData(params.Snapshot)
	if err != nil {
		return nil, err
	}
	program, err := sd.getProgram(params.Project)
	if err != nil {
		return nil, err
	}
	sourceFile, err := s.resolveOptionalSourceFile(program, params.File)
	if err != nil || sourceFile == nil {
		return nil, err
	}
	targets := program.GetRedirectTargets(sourceFile.Path())
	result := make([]string, len(targets))
	for i, t := range targets {
		result[i] = t
	}
	return &RedirectTargetsResponse{Targets: result}, nil
}

// handleRequiresAddingImplicitUndefined reports whether a parameter needs implicit undefined.
func (s *Session) handleRequiresAddingImplicitUndefined(ctx context.Context, params *CheckerNodeParams) (bool, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return false, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return false, err
	}
	if node == nil {
		return false, nil
	}
	return setup.checker.RequiresAddingImplicitUndefined(node), nil
}

// handleGetTypeOnlyAliasDeclaration returns the type-only alias declaration for a symbol.
func (s *Session) handleGetTypeOnlyAliasDeclaration(ctx context.Context, params *CheckerSymbolParams) (any, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	symbol, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}
	if symbol == nil {
		return nil, nil
	}

	node := setup.checker.GetTypeOnlyAliasDeclaration(symbol)
	if node == nil {
		return nil, nil
	}
	return nodeHandleFrom(node), nil
}

// handleResolveExternalModuleName resolves an external module name to a symbol.
func (s *Session) handleResolveExternalModuleName(ctx context.Context, params *CheckerNodeParams) (*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return nil, nil
	}

	symbol := setup.checker.ResolveExternalModuleName(node)
	if symbol == nil {
		return nil, nil
	}
	return setup.newSymbolResponse(symbol), nil
}

// handleGetPropertySymbolOfDestructuringAssignment returns the property symbol at a destructuring assignment location.
func (s *Session) handleGetPropertySymbolOfDestructuringAssignment(ctx context.Context, params *CheckerNodeParams) (*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return nil, nil
	}

	symbol := setup.checker.GetPropertySymbolOfDestructuringAssignment(node)
	if symbol == nil {
		return nil, nil
	}
	return setup.newSymbolResponse(symbol), nil
}

// handleIsSymbolAccessible reports symbol accessibility from an enclosing declaration.
func (s *Session) handleIsSymbolAccessible(ctx context.Context, params *IsSymbolAccessibleParams) (*SymbolAccessibilityResultResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	symbol, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}
	if symbol == nil {
		return nil, nil
	}

	var enclosing *ast.Node
	if params.EnclosingDeclaration != "" {
		enclosing, err = setup.sd.resolveNodeHandle(setup.program, params.EnclosingDeclaration)
		if err != nil {
			return nil, err
		}
	}

	result := setup.checker.IsSymbolAccessible(symbol, enclosing, ast.SymbolFlags(params.Meaning), params.ShouldComputeAliasesToMakeVisible)
	return &SymbolAccessibilityResultResponse{
		Accessibility:   int32(result.Accessibility),
		ErrorSymbolName: result.ErrorSymbolName,
		ErrorModuleName: result.ErrorModuleName,
	}, nil
}

// handleGetIndexInfosOfIndexSymbol returns index infos for an index symbol.
func (s *Session) handleGetIndexInfosOfIndexSymbol(ctx context.Context, params *GetIndexInfosOfIndexSymbolParams) ([]*IndexInfoResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	symbol, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}
	if symbol == nil {
		return nil, nil
	}

	var siblings []*ast.Symbol
	if len(params.SiblingSymbols) > 0 {
		siblings = make([]*ast.Symbol, len(params.SiblingSymbols))
		for i, id := range params.SiblingSymbols {
			sym, err := setup.resolveSymbolHandle(id)
			if err != nil {
				return nil, err
			}
			siblings[i] = sym
		}
	}

	infos := setup.checker.GetIndexInfosOfIndexSymbol(symbol, siblings)
	results := make([]*IndexInfoResponse, len(infos))
	for i, info := range infos {
		results[i] = materializeIndexInfo(setup, info)
	}
	return results, nil
}

// handleContainsArgumentsReference reports whether a node contains an arguments reference.
func (s *Session) handleContainsArgumentsReference(ctx context.Context, params *CheckerNodeParams) (bool, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return false, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return false, err
	}
	if node == nil {
		return false, nil
	}
	return setup.checker.ContainsArgumentsReference(node), nil
}

// handleGetAugmentedPropertiesOfType returns augmented (apparent) properties of a type.
func (s *Session) handleGetAugmentedPropertiesOfType(ctx context.Context, params *CheckerTypeParams) ([]*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}

	props := setup.checker.GetAugmentedPropertiesOfType(t)
	results := make([]*SymbolResponse, len(props))
	for i, prop := range props {
		results[i] = setup.newSymbolResponse(prop)
	}
	return results, nil
}

func (s *Session) handleGetSuggestedSymbolForNonexistentProperty(ctx context.Context, params *GetSuggestedSymbolForNonexistentPropertyParams) (*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return nil, nil
	}
	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}
	symbol := setup.checker.GetSuggestedSymbolForNonexistentProperty(node, t)
	if symbol == nil {
		return nil, nil
	}
	return setup.newSymbolResponse(symbol), nil
}

func (s *Session) handleGetSuggestedSymbolForNonexistentClassMember(ctx context.Context, params *GetSuggestedSymbolForNonexistentClassMemberParams) (*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}
	symbol := setup.checker.GetSuggestedSymbolForNonexistentClassMember(params.Name, t)
	if symbol == nil {
		return nil, nil
	}
	return setup.newSymbolResponse(symbol), nil
}

func (s *Session) handleGetSuggestedSymbolForNonexistentJSXAttribute(ctx context.Context, params *GetSuggestedSymbolForNonexistentJSXAttributeParams) (*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}
	symbol := setup.checker.GetSuggestedSymbolForNonexistentJSXAttribute(params.Name, t)
	if symbol == nil {
		return nil, nil
	}
	return setup.newSymbolResponse(symbol), nil
}

func (s *Session) handleGetSuggestedSymbolForNonexistentModule(ctx context.Context, params *GetSuggestedSymbolForNonexistentModuleParams) (*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return nil, nil
	}
	mod, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}
	if mod == nil {
		return nil, nil
	}
	symbol := setup.checker.GetSuggestedSymbolForNonexistentModule(node, mod)
	if symbol == nil {
		return nil, nil
	}
	return setup.newSymbolResponse(symbol), nil
}

func (s *Session) encodeBuiltNode(node *ast.Node, what string) (any, error) {
	if node == nil {
		return nil, nil
	}
	data, _, err := encoder.EncodeNode(node, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to encode %s: %w", what, err)
	}
	if s.useBinaryResponses {
		return RawBinary(data), nil
	}
	return &SourceFileResponse{
		Data: base64.StdEncoding.EncodeToString(data),
	}, nil
}

func (s *Session) handleSymbolToExpression(ctx context.Context, params *SymbolToNodeBuilderParams) (any, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	symbol, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}
	var enclosing *ast.Node
	if params.Location != "" {
		enclosing, err = setup.sd.resolveNodeHandle(setup.program, params.Location)
		if err != nil {
			return nil, err
		}
	}
	node := setup.checker.SymbolToExpression(symbol, ast.SymbolFlags(params.Meaning), enclosing, nodebuilder.Flags(params.Flags), nodebuilder.InternalFlags(params.InternalFlags))
	return s.encodeBuiltNode(node, "symbolToExpression")
}

func (s *Session) handleSymbolToNode(ctx context.Context, params *SymbolToNodeBuilderParams) (any, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	symbol, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}
	var enclosing *ast.Node
	if params.Location != "" {
		enclosing, err = setup.sd.resolveNodeHandle(setup.program, params.Location)
		if err != nil {
			return nil, err
		}
	}
	node := setup.checker.SymbolToNode(symbol, ast.SymbolFlags(params.Meaning), enclosing, nodebuilder.Flags(params.Flags), nodebuilder.InternalFlags(params.InternalFlags))
	return s.encodeBuiltNode(node, "symbolToNode")
}

func (s *Session) handleSymbolToEntityName(ctx context.Context, params *SymbolToNodeBuilderParams) (any, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	symbol, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return nil, err
	}
	var enclosing *ast.Node
	if params.Location != "" {
		enclosing, err = setup.sd.resolveNodeHandle(setup.program, params.Location)
		if err != nil {
			return nil, err
		}
	}
	node := setup.checker.SymbolToEntityName(symbol, ast.SymbolFlags(params.Meaning), enclosing, nodebuilder.Flags(params.Flags), nodebuilder.InternalFlags(params.InternalFlags))
	return s.encodeBuiltNode(node, "symbolToEntityName")
}

func (s *Session) handleTypePredicateToTypePredicateNode(ctx context.Context, params *TypePredicateToTypePredicateNodeParams) (any, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	var t *checker.Type
	if params.Type != 0 {
		t, err = setup.resolveTypeHandle(params.Type)
		if err != nil {
			return nil, err
		}
	}
	var enclosing *ast.Node
	if params.Location != "" {
		enclosing, err = setup.sd.resolveNodeHandle(setup.program, params.Location)
		if err != nil {
			return nil, err
		}
	}
	node := setup.checker.TypePredicateToTypePredicateNodeFromParts(
		checker.TypePredicateKind(params.Kind),
		params.ParameterName,
		params.ParameterIndex,
		t,
		enclosing,
		nodebuilder.Flags(params.Flags),
	)
	return s.encodeBuiltNode(node, "typePredicateToTypePredicateNode")
}

func (s *Session) handleIndexInfoToIndexSignatureDeclaration(ctx context.Context, params *IndexInfoToIndexSignatureDeclarationParams) (any, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	keyType, err := setup.resolveTypeHandle(params.KeyType)
	if err != nil {
		return nil, err
	}
	valueType, err := setup.resolveTypeHandle(params.ValueType)
	if err != nil {
		return nil, err
	}
	var declaration *ast.Node
	if params.Declaration != "" {
		declaration, err = setup.sd.resolveNodeHandle(setup.program, params.Declaration)
		if err != nil {
			return nil, err
		}
	}
	var enclosing *ast.Node
	if params.Location != "" {
		enclosing, err = setup.sd.resolveNodeHandle(setup.program, params.Location)
		if err != nil {
			return nil, err
		}
	}
	node := setup.checker.IndexInfoToIndexSignatureDeclaration(
		keyType, valueType, params.IsReadonly, declaration, enclosing, nodebuilder.Flags(params.Flags),
	)
	return s.encodeBuiltNode(node, "indexInfoToIndexSignatureDeclaration")
}

// handleGetExactOptionalProperties returns optional properties that contain the missing type.
func (s *Session) handleGetExactOptionalProperties(ctx context.Context, params *CheckerTypeParams) ([]*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}

	props := setup.checker.GetExactOptionalProperties(t)
	results := make([]*SymbolResponse, len(props))
	for i, prop := range props {
		results[i] = setup.newSymbolResponse(prop)
	}
	return results, nil
}

// handleGetJsxNamespace returns the JSX namespace string for an optional location.
func (s *Session) handleGetJsxNamespace(ctx context.Context, params *CheckerNodeOptionalParams) (string, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return "", err
	}
	defer setup.done()

	var location *ast.Node
	if params.Location != "" {
		location, err = setup.sd.resolveNodeHandle(setup.program, params.Location)
		if err != nil {
			return "", err
		}
	}
	return setup.checker.GetJsxNamespace(location), nil
}

// handleGetJsxFragmentFactory returns the JSX fragment factory name for a location.
func (s *Session) handleGetJsxFragmentFactory(ctx context.Context, params *CheckerNodeParams) (string, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return "", err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return "", err
	}
	if node == nil {
		return "", nil
	}
	return setup.checker.GetJsxFragmentFactory(node), nil
}

// handleGetParameterIdentifierInfoAtPosition returns parameter identifier info at an argument position.
func (s *Session) handleGetParameterIdentifierInfoAtPosition(ctx context.Context, params *GetParameterIdentifierInfoAtPositionParams) (*ParameterIdentifierInfoResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	sig, err := setup.resolveSignatureHandle(params.Signature)
	if err != nil {
		return nil, err
	}
	if sig == nil {
		return nil, nil
	}

	info := setup.checker.GetParameterIdentifierInfoAtPosition(sig, int(params.Position))
	if info == nil {
		return nil, nil
	}
	resp := &ParameterIdentifierInfoResponse{
		ParameterName:   info.ParameterName,
		IsRestParameter: info.IsRestParameter,
	}
	if info.Parameter != nil {
		resp.Parameter = nodeHandleFrom(info.Parameter)
	}
	return resp, nil
}

// handleCreatePromiseType returns Promise<T> for type T.
func (s *Session) handleCreatePromiseType(ctx context.Context, params *CheckerTypeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}
	result := setup.checker.CreatePromiseType(t)
	if result == nil {
		return nil, nil
	}
	return setup.newTypeResponse(result), nil
}

// handleCreateTransientSymbolWithType creates a transient symbol with a pinned type.
func (s *Session) handleCreateTransientSymbolWithType(ctx context.Context, params *CreateTransientSymbolWithTypeParams) (*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	var t *checker.Type
	if params.Type != 0 {
		t, err = setup.resolveTypeHandle(params.Type)
		if err != nil {
			return nil, err
		}
	}
	symbol := setup.checker.CreateTransientSymbolWithType(ast.SymbolFlags(params.Flags), params.Name, t)
	return setup.newSymbolResponse(symbol), nil
}

// handleCreateSignatureFromParts assembles a Signature from parameter symbols + return type.
func (s *Session) handleCreateSignatureFromParts(ctx context.Context, params *CreateSignatureFromPartsParams) (*SignatureResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	parameters := make([]*ast.Symbol, 0, len(params.Parameters))
	for _, id := range params.Parameters {
		sym, err := setup.resolveSymbolHandle(id)
		if err != nil {
			return nil, err
		}
		if sym != nil {
			parameters = append(parameters, sym)
		}
	}
	returnType, err := setup.resolveTypeHandle(params.ReturnType)
	if err != nil {
		return nil, err
	}
	typeParameters, err := setup.resolveTypeHandles(params.TypeParameters)
	if err != nil {
		return nil, err
	}
	var thisParameter *ast.Symbol
	if params.ThisParameter != 0 {
		thisParameter, err = setup.resolveSymbolHandle(params.ThisParameter)
		if err != nil {
			return nil, err
		}
	}
	sig := setup.checker.CreateSignatureFromParts(
		parameters,
		returnType,
		int(params.MinArgumentCount),
		checker.SignatureFlags(params.Flags),
		typeParameters,
		thisParameter,
	)
	return setup.newSignatureResponse(sig), nil
}

// handleCreateAnonymousTypeFromParts assembles an anonymous type from parts.
func (s *Session) handleCreateAnonymousTypeFromParts(ctx context.Context, params *CreateAnonymousTypeFromPartsParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	var symbol *ast.Symbol
	if params.Symbol != 0 {
		symbol, err = setup.resolveSymbolHandle(params.Symbol)
		if err != nil {
			return nil, err
		}
	}
	members := make([]*ast.Symbol, 0, len(params.Members))
	for _, id := range params.Members {
		sym, err := setup.resolveSymbolHandle(id)
		if err != nil {
			return nil, err
		}
		if sym != nil {
			members = append(members, sym)
		}
	}
	callSigs := make([]*checker.Signature, 0, len(params.CallSignatures))
	for _, id := range params.CallSignatures {
		sig, err := setup.resolveSignatureHandle(id)
		if err != nil {
			return nil, err
		}
		if sig != nil {
			callSigs = append(callSigs, sig)
		}
	}
	ctorSigs := make([]*checker.Signature, 0, len(params.ConstructSignatures))
	for _, id := range params.ConstructSignatures {
		sig, err := setup.resolveSignatureHandle(id)
		if err != nil {
			return nil, err
		}
		if sig != nil {
			ctorSigs = append(ctorSigs, sig)
		}
	}
	indexParts := make([]checker.IndexInfoPart, 0, len(params.IndexInfos))
	for _, part := range params.IndexInfos {
		keyType, err := setup.resolveTypeHandle(part.KeyType)
		if err != nil {
			return nil, err
		}
		valueType, err := setup.resolveTypeHandle(part.ValueType)
		if err != nil {
			return nil, err
		}
		indexParts = append(indexParts, checker.IndexInfoPart{
			KeyType:    keyType,
			ValueType:  valueType,
			IsReadonly: part.IsReadonly,
		})
	}
	result := setup.checker.CreateAnonymousTypeFromParts(symbol, members, callSigs, ctorSigs, indexParts)
	if result == nil {
		return nil, nil
	}
	return setup.newTypeResponse(result), nil
}

// handleGetMemberOverrideModifierStatus returns whether a class member needs/has an override modifier.
func (s *Session) handleGetMemberOverrideModifierStatus(ctx context.Context, params *GetMemberOverrideModifierStatusParams) (int32, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return 0, err
	}
	defer setup.done()

	classLike, err := setup.sd.resolveNodeHandle(setup.program, params.ClassLike)
	if err != nil {
		return 0, err
	}
	if classLike == nil {
		return 0, nil
	}
	symbol, err := setup.resolveSymbolHandle(params.Symbol)
	if err != nil {
		return 0, err
	}
	status := setup.checker.GetMemberOverrideModifierStatus(
		classLike,
		symbol,
		params.MemberHasOverride,
		params.MemberHasAbstract,
		params.MemberIsStatic,
		params.MemberHasName,
	)
	return int32(status), nil
}

// handleGetSymbolOfExpando returns the symbol for an expando property assignment target.
func (s *Session) handleGetSymbolOfExpando(ctx context.Context, params *GetSymbolOfExpandoParams) (*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return nil, nil
	}
	symbol := setup.checker.GetSymbolOfExpando(node, params.AllowDeclaration)
	if symbol == nil {
		return nil, nil
	}
	return setup.newSymbolResponse(symbol), nil
}

// handleCollectVisitedTypeParameters walks a type and returns visited type parameters.
func (s *Session) handleCollectVisitedTypeParameters(ctx context.Context, params *CheckerTypeParams) ([]*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}
	visited := setup.checker.CollectVisitedTypeParameters(t)
	if len(visited) == 0 {
		return nil, nil
	}
	results := make([]*TypeResponse, len(visited))
	for i, vt := range visited {
		results[i] = setup.newTypeResponse(vt)
	}
	return results, nil
}

// handleGetIndexInfosAtLocation returns index infos applicable at a property-
// access name (stock getIndexInfosAtLocation). Non-PA-name → null (undefined);
// PA-name with no matches → empty array.
func (s *Session) handleGetIndexInfosAtLocation(ctx context.Context, params *CheckerNodeParams) (any, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return nil, nil
	}

	infos, ok := setup.checker.GetIndexInfosAtLocation(node)
	if !ok {
		// Untyped nil → JSON null → JS undefined (stock non-PA-name semantics).
		return nil, nil
	}

	results := make([]*IndexInfoResponse, len(infos))
	for i, info := range infos {
		results[i] = &IndexInfoResponse{
			KeyType:    *setup.newTypeResponse(info.KeyType()),
			ValueType:  *setup.newTypeResponse(info.ValueType()),
			IsReadonly: info.IsReadonly(),
		}
		if info.Declaration() != nil {
			results[i].Declaration = nodeHandleFrom(info.Declaration())
			if sym := setup.checker.GetSymbolOfDeclaration(info.Declaration()); sym != nil {
				results[i].Symbol = setup.newSymbolResponse(sym)
			}
		}
	}

	return results, nil
}

// handleGetDefaultFromTypeParameter returns the default type of a type
// parameter (undefined when the type is not a type parameter or has no
// default) — stock's checker surface wrapper.
func (s *Session) handleGetDefaultFromTypeParameter(ctx context.Context, params *CheckerTypeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}

	defaultType := setup.checker.GetDefaultFromTypeParameter(t)
	if defaultType == nil {
		return nil, nil
	}

	return setup.newTypeResponse(defaultType), nil
}

// handleGetPrivateIdentifierPropertyOfType resolves a private identifier in
// the lexical scope of the given location, then reads it as a property of the
// left-hand type — stock's (type, name, location) surface.
func (s *Session) handleGetPrivateIdentifierPropertyOfType(ctx context.Context, params *GetPrivateIdentifierPropertyOfTypeParams) (*SymbolResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	node, err := setup.sd.resolveNodeHandle(setup.program, params.Location)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return nil, nil
	}
	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return nil, err
	}

	scoped := setup.checker.LookupSymbolForPrivateIdentifierDeclaration(params.Name, node)
	if scoped == nil {
		return nil, nil
	}
	prop := setup.checker.GetPrivateIdentifierPropertyOfType(t, scoped)
	if prop == nil {
		return nil, nil
	}

	return setup.newSymbolResponse(prop), nil
}

// handleGetRecursionIdentity returns a stable string identity for stock's
// getRecursionIdentity(type) — consumers only ever use it as a Set/Map key,
// so a pointer-stable encoding of the underlying node/symbol/type is enough.
func (s *Session) handleGetRecursionIdentity(ctx context.Context, params *CheckerTypeParams) (string, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return "", err
	}
	defer setup.done()

	t, err := setup.resolveTypeHandle(params.Type)
	if err != nil {
		return "", err
	}

	id := setup.checker.GetRecursionIdentity(t)
	return fmt.Sprintf("%p", id), nil
}

// handleGetTypeArgumentsForResolvedSignature mirrors stock:
// undefined when the signature has no mapper, else the
// (target ?? signature)'s type parameters instantiated by the mapper.
// The result is a pointer so a nil result (stock's "signature has no mapper"
// → undefined) crosses as JSON null instead of the json v2 nil-slice "[]" —
// a mapper with zero type parameters legitimately returns an empty list.
func (s *Session) handleGetTypeArgumentsForResolvedSignature(ctx context.Context, params *CheckerSignatureParams) (*[]*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	sig, err := setup.resolveSignatureHandle(params.Signature)
	if err != nil {
		return nil, err
	}

	typeArgs := setup.checker.GetTypeArgumentsForResolvedSignature(sig)
	if typeArgs == nil {
		return nil, nil
	}
	results := make([]*TypeResponse, len(typeArgs))
	for i, t := range typeArgs {
		results[i] = setup.newTypeResponse(t)
	}
	return &results, nil
}

// handleGetStringLiteralType returns the interned string-literal type for a value.
func (s *Session) handleGetStringLiteralType(ctx context.Context, params *GetLiteralTypeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	value, ok := params.Value.(string)
	if !ok {
		return nil, fmt.Errorf("%w: getStringLiteralType expects a string value", ErrClientError)
	}
	return setup.newTypeResponse(setup.checker.GetStringLiteralType(value)), nil
}

// handleGetNumberLiteralType returns the interned number-literal type for a value.
func (s *Session) handleGetNumberLiteralType(ctx context.Context, params *GetLiteralTypeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	value, ok := params.Value.(float64)
	if !ok {
		return nil, fmt.Errorf("%w: getNumberLiteralType expects a number value", ErrClientError)
	}
	return setup.newTypeResponse(setup.checker.GetNumberLiteralType(jsnum.Number(value))), nil
}

// handleGetBigIntLiteralType returns the interned bigint-literal type for a
// signed decimal string (mirrors literalValueToJSON on the way out).
func (s *Session) handleGetBigIntLiteralType(ctx context.Context, params *GetLiteralTypeParams) (*TypeResponse, error) {
	setup, err := s.setupChecker(ctx, params.Snapshot, params.Project)
	if err != nil {
		return nil, err
	}
	defer setup.done()

	value, ok := params.Value.(string)
	if !ok {
		return nil, fmt.Errorf("%w: getBigIntLiteralType expects a decimal string value", ErrClientError)
	}
	return setup.newTypeResponse(setup.checker.GetBigIntLiteralType(jsnum.ParseValidBigInt(value))), nil
}

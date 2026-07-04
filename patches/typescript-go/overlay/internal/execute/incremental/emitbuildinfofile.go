package incremental

// TNB bridge addition: exposes buildinfo-only emit to the API session
// (internal/api handleEmitBuildInfo) without going through Program.Emit, which
// would also run the JS/d.ts emitters. The stock tsc -b / vue-tsc -b solution
// builder drives buildinfo emit as its own step (BuilderProgram.emitBuildInfo),
// so the bridge needs the same granularity.

import (
	"context"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/core"
)

// NewProgramWithOptions is NewProgram with an explicit compiler-options view
// for build-state decisions. The API bridge uses it to layer command-line-only
// flags (--build) over the tsconfig options its programs were parsed with,
// matching how `tsgo -b` merges CLI options into every project config.
func NewProgramWithOptions(program *compiler.Program, oldProgram *Program, host Host, options *core.CompilerOptions) *Program {
	return &Program{
		snapshot: programToSnapshotWithOptions(program, oldProgram, options, false),
		program:  program,
		host:     host,
	}
}

// MarkBuildInfoEmitPending forces the next EmitBuildInfoFile to serialize and
// return the buildinfo even when the incremental state is unchanged from what
// was read back from disk. The stock JS builder owns the emit-pending decision
// (it always rewrites the buildinfo after a build, refreshing its mtime so
// mtime-based up-to-date checks recover); the bridge mirrors that by forcing
// the write when the JS side has already decided one is due.
func (p *Program) MarkBuildInfoEmitPending() {
	p.snapshot.buildInfoEmitPending.Store(true)
}

// SeedSemanticDiagnostics pre-populates the snapshot's per-file semantic
// diagnostics cache with results already computed on the live program during
// this run (the API session's whole-program diagnostics pass). The entries are
// stored in exactly the form collectSemanticDiagnosticsOfAffectedFiles would
// store them (unfiltered checker diagnostics), including the checkPending
// bookkeeping, so a subsequent GetSemanticDiagnostics only has to handle
// affected-files invalidation instead of re-running the full check.
func (p *Program) SeedSemanticDiagnostics(diagnosticsPerFile map[*ast.SourceFile][]*ast.Diagnostic) {
	p.panicIfNoProgram("SeedSemanticDiagnostics")
	for file, diagnostics := range diagnosticsPerFile {
		p.snapshot.semanticDiagnosticsPerFile.Store(file.Path(), &DiagnosticsOrBuildInfoDiagnosticsWithFileName{diagnostics: diagnostics})
	}
	if p.snapshot.semanticDiagnosticsPerFile.Size() == len(p.program.GetSourceFiles()) && p.snapshot.checkPending && !p.snapshot.options.NoCheck.IsTrue() {
		p.snapshot.checkPending = false
	}
}

// EmitBuildInfoFile emits only the .tsbuildinfo for this program, honoring
// options.WriteFile like Emit does. Returns nil when no buildinfo emit is
// pending (the on-disk buildinfo is already current) or the project has no
// buildinfo path.
func (p *Program) EmitBuildInfoFile(ctx context.Context, options compiler.EmitOptions) *compiler.EmitResult {
	p.panicIfNoProgram("EmitBuildInfoFile")
	return p.emitBuildInfo(ctx, options)
}

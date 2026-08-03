package api

// V8-arena binary transport for the hot query path (part 3). One
// session-scoped, V8-allocated buffer: requests are fixed-shape records at
// offset 0, responses are header + records + packed strings at
// arenaRespOffset. Zero serialization per call on this path; strings are
// interned once per session and cross as uint32 ids. Only the measured hot
// scalar/record query classes ride it — document payloads (updateSnapshot,
// diagnostics, names, builder graph, blobs) stay on the JSON path.
//
// Arena memory is V8-owned (napi_create_buffer): Go writes into it while the
// JS thread blocks in the synchronous NAPI call; no Go pointers escape.
// Sandbox-legal by construction (Electron utility processes included).

import (
	"encoding/binary"
	"fmt"
	"math"
	"unsafe"

	"github.com/microsoft/typescript-go/internal/checker"
)

const (
	// arenaSize is negotiated with the JS side (it allocates the buffer).
	// 4 MiB is ~80x the largest hot-class response we expect (a full property
	// table of a big component type). An oversize response escapes out-of-band
	// as the call's napi return value (the JSON doc) instead of ever
	// overflowing.
	arenaRespOffset    = 1 << 20 // responses begin 1 MiB in
	arenaRespHeaderLen = 16      // kind u8 + pad + payloadLen u32 + newStrOff u32 + newStrLen u32
	arenaReqMax        = 256     // request record + inline strings budget
)

const (
	arenaKindNull   = 0
	arenaKindRecord = 1
	arenaKindError  = 4
)

// strref id for "absent" (a nil slice/map field or missing string).
const arenaAbsent = 0

type arena struct {
	buf     []byte
	strTab  map[string]uint32
	strs    []string
	newStrs []string // strings interned by the current call, announced to JS
	// write cursors for the current call: records and packed arrays grow up
	// from arenaRespOffset, strings grow down from the arena end. A write that
	// would cross the other region fails the encode (JSON escape) instead of
	// corrupting memory.
	recOff  int // record region cursor (after header)
	packOff int // packed-array region cursor (starts after all fixed records)
	strOff  int // string-pack cursor (grows downward from arena end)
	failed  bool
}

// SetArena installs the session's arena from a V8-allocated buffer pointer.
func (s *Session) SetArena(ptr unsafe.Pointer, length int) {
	if length < arenaRespOffset+arenaRespHeaderLen+4096 {
		panic("arena too small")
	}
	s.arena = &arena{
		buf:    unsafe.Slice((*byte)(ptr), length),
		strTab: make(map[string]uint32, 4096),
	}
	s.arena.strs = append(s.arena.strs, "") // id 0 = absent
}

func (a *arena) begin() {
	a.recOff = arenaRespOffset + arenaRespHeaderLen
	a.packOff = arenaRespOffset + arenaRespHeaderLen
	a.strOff = len(a.buf)
	a.newStrs = a.newStrs[:0]
	a.failed = false
}

// rec/pack reserve n bytes in their region. Writers no-op once failed, so an
// oversize encode stops writing where the regions would meet.
func (a *arena) rec(n int) int {
	off := a.recOff
	a.recOff += n
	if a.recOff > a.strOff {
		a.failed = true
	}
	return off
}

func (a *arena) pack(n int) int {
	off := a.packOff
	a.packOff += n
	if a.packOff > a.strOff {
		a.failed = true
	}
	return off
}

func (a *arena) u32(off int, v uint32) {
	if a.failed || off+4 > a.strOff {
		a.failed = true
		return
	}
	binary.LittleEndian.PutUint32(a.buf[off:], v)
}
func (a *arena) u64(off int, v uint64) {
	if a.failed || off+8 > a.strOff {
		a.failed = true
		return
	}
	binary.LittleEndian.PutUint64(a.buf[off:], v)
}
func (a *arena) i32(off int, v int32) { a.u32(off, uint32(v)) }
func (a *arena) f64(off int, v float64) {
	a.u64(off, math.Float64bits(v))
}
func (a *arena) b(off int, v byte) {
	if a.failed || off+1 > a.strOff {
		a.failed = true
		return
	}
	a.buf[off] = v
}

// intern dedups a string into the session table; id 1-based (0 = absent).
func (a *arena) intern(s string) uint32 {
	if s == "" {
		return arenaAbsent
	}
	if id, ok := a.strTab[s]; ok {
		return id
	}
	id := uint32(len(a.strs))
	a.strTab[s] = id
	a.strs = append(a.strs, s)
	a.newStrs = append(a.newStrs, s)
	return id
}

// writeStr packs bytes into the string region (grows down from the arena end)
// and returns (off,len) for strrefs.
func (a *arena) writeStr(s string) (uint32, uint32) {
	a.strOff -= len(s)
	if a.strOff < a.recOff || a.strOff < a.packOff {
		a.failed = true
		return 0, 0
	}
	copy(a.buf[a.strOff:], s)
	return uint32(a.strOff), uint32(len(s))
}

// strref for interned strings: 32-bit id (or arenaAbsent). Raw strings use the
// (off,len) form and are also interned so repeats cross as ids.
func (a *arena) str(s string) uint32 { return a.intern(s) }

// ── Request decoding ─────────────────────────────────────────────────────

type arenaReq struct{ a *arena }

func (r arenaReq) u64(off int) uint64 { return binary.LittleEndian.Uint64(r.a.buf[off:]) }
func (r arenaReq) u32(off int) uint32 { return binary.LittleEndian.Uint32(r.a.buf[off:]) }
func (r arenaReq) i32(off int) int32  { return int32(r.u32(off)) }
func (r arenaReq) u8(off int) uint32  { return uint32(r.a.buf[off]) }
func (r arenaReq) str(off int) string {
	o, n := r.u32(off), r.u32(off+4)
	if n == 0 {
		return ""
	}
	return string(r.a.buf[o : o+n : o+n])
}

// nodeHandle decodes (index u32, kind u32, path str) into the "index.kind.path"
// handle string resolveNodeHandle expects.
func (r arenaReq) nodeHandle(off int) string {
	idx := r.u32(off)
	kind := r.u32(off + 4)
	path := r.str(off + 8)
	return fmt.Sprintf("%d.%d.%s", idx, kind, path)
}

// symbolIDs decodes a (ptr,count) array of u64 symbol ids at off.
func (r arenaReq) symbolIDs(off int) []SymbolID {
	count := r.u32(off + 4)
	if count == 0 {
		return nil
	}
	p := r.u32(off)
	ids := make([]SymbolID, count)
	for i := range ids {
		ids[i] = SymbolID(r.u64(int(p) + 8*i))
	}
	return ids
}

// ── Response framing ─────────────────────────────────────────────────────

// finish writes the response header and the newStrings block. payloadLen
// covers [arenaRespOffset+16, newStringsStart).
func (a *arena) finish(kind byte) {
	// newStrings block: [count u32][(len u32)(bytes)…]
	nsOff := max(a.recOff, a.packOff)
	a.u32(nsOff, uint32(len(a.newStrs)))
	p := nsOff + 4
	for _, s := range a.newStrs {
		if p+4+len(s) > a.strOff {
			a.failed = true
			return
		}
		a.u32(p, uint32(len(s)))
		copy(a.buf[p+4:], s)
		p += 4 + len(s)
	}
	if a.failed {
		return
	}
	nsLen := p - nsOff
	a.b(arenaRespOffset, kind)
	a.u32(arenaRespOffset+4, uint32(nsOff-(arenaRespOffset+arenaRespHeaderLen)))
	a.u32(arenaRespOffset+8, uint32(nsOff))
	a.u32(arenaRespOffset+12, uint32(nsLen))
}

func (a *arena) finishError(msg string) {
	a.rewindStrings()
	a.begin()
	o, n := a.writeStr(msg)
	off := a.rec(8)
	a.u32(off, o)
	a.u32(off+4, n)
	a.finish(arenaKindError)
}

// rewindStrings drops strings interned by the current call that were never
// announced to JS (abandoned encode), keeping id assignment in lockstep with
// the JS-side table. Ids are sequential, so truncation is exact.
func (a *arena) rewindStrings() {
	for _, s := range a.newStrs {
		delete(a.strTab, s)
	}
	a.strs = a.strs[:len(a.strs)-len(a.newStrs)]
	a.newStrs = a.newStrs[:0]
}

// ── Record encoders ──────────────────────────────────────────────────────

// Array fields are (dataOff u32, count u32) with the elements allocated from
// the pack region — after ALL fixed records, so the JS side reads records at
// a fixed stride.

func (a *arena) u32Array(off int, vals []uint32) {
	a.u32(off, 0)
	a.u32(off+4, uint32(len(vals)))
	if len(vals) == 0 {
		return
	}
	p := a.pack(4 * len(vals))
	a.u32(off, uint32(p))
	for i, v := range vals {
		a.u32(p+4*i, v)
	}
}

func (a *arena) typeIDs(off int, vals []TypeID) {
	a.u32(off, 0)
	a.u32(off+4, uint32(len(vals)))
	if len(vals) == 0 {
		return
	}
	p := a.pack(4 * len(vals))
	a.u32(off, uint32(p))
	for i, v := range vals {
		a.u32(p+4*i, uint32(v))
	}
}

func (a *arena) strArray(off int, vals []string) {
	a.u32(off, 0)
	a.u32(off+4, uint32(len(vals)))
	if len(vals) == 0 {
		return
	}
	p := a.pack(4 * len(vals))
	a.u32(off, uint32(p))
	for i, v := range vals {
		a.u32(p+4*i, a.str(v))
	}
}

func (a *arena) u8Array(off int, vals []checker.ElementFlags) {
	a.u32(off, 0)
	a.u32(off+4, uint32(len(vals)))
	if len(vals) == 0 {
		return
	}
	p := a.pack(len(vals))
	a.u32(off, uint32(p))
	for i, v := range vals {
		a.b(p+i, byte(v))
	}
}

func (a *arena) nodeHandleRec(off int, h NodeHandle) {
	if h == "" { // absent → the zero record JS reads as the "0.0." sentinel
		a.u32(off, 0)
		a.u32(off+4, 0)
		a.u32(off+8, 0)
		a.u32(off+12, 0)
		return
	}
	idx, kind, path := parseNodeHandleParts(h)
	a.u32(off, uint32(idx))
	a.u32(off+4, uint32(kind))
	a.u32(off+8, a.str(path))
	a.u32(off+12, 0)
}

// nodeHandleArray writes a (ptr u32, count u32) descriptor at off and packs
// count 16-byte handle records; nil elements become zero records (the JS
// "0.0." null sentinel) so sparse arrays keep their holes positional.
func (a *arena) nodeHandleArray(off int, vals []*NodeHandle) {
	a.u32(off, 0)
	a.u32(off+4, uint32(len(vals)))
	if len(vals) == 0 {
		return
	}
	p := a.pack(16 * len(vals))
	a.u32(off, uint32(p))
	for i, v := range vals {
		var h NodeHandle
		if v != nil {
			h = *v
		}
		a.nodeHandleRec(p+16*i, h)
	}
}

// parseNodeHandleParts splits "index.kind.path" without the error path (the
// encoder wrote it, so it is well-formed).
func parseNodeHandleParts(h NodeHandle) (uint64, uint64, string) {
	s := string(h)
	i := 0
	var idx, kind uint64
	j := 0
	for ; i < len(s) && s[i] != '.'; i++ {
		idx = idx*10 + uint64(s[i]-'0')
	}
	i++
	for j = i; j < len(s) && s[j] != '.'; j++ {
		kind = kind*10 + uint64(s[j]-'0')
	}
	return idx, kind, s[j+1:]
}

// encodeTypeResponse writes a TypeResponse record (152 bytes fixed).
func (a *arena) encodeTypeResponse(r *TypeResponse) {
	off := a.rec(152)
	a.u32(off+0, uint32(r.Id))
	a.u32(off+4, r.Flags)
	a.u32(off+8, r.ObjectFlags)
	a.u32(off+12, uint32(r.Target))
	a.u32(off+16, uint32(r.FreshType))
	a.u32(off+20, uint32(r.RegularType))
	a.u32(off+24, uint32(r.ObjectType))
	a.u32(off+28, uint32(r.IndexType))
	a.u32(off+32, uint32(r.CheckType))
	a.u32(off+36, uint32(r.ExtendsType))
	a.u32(off+40, uint32(r.BaseType))
	a.u32(off+44, uint32(r.SubstConstraint))
	a.u64(off+48, uint64(r.Symbol))
	a.u64(off+56, uint64(r.AliasSymbol))
	var f2 byte
	if r.IsThisType {
		f2 |= 1
	}
	if r.FixedLength != nil {
		f2 |= 2
		a.i32(off+64, int32(*r.FixedLength))
	}
	// readonly is tri-state (absent / false / true): JSON emits it whenever the
	// pointer is non-nil — mutable tuples included (bit2 present, bit3 value).
	if r.TupleReadonly != nil {
		f2 |= 4
		if *r.TupleReadonly {
			f2 |= 8
		}
	}
	a.b(off+68, f2)
	// value: 0 absent, 1 string, 2 number(f64), 3 bool — bigint literals
	// already crossed literalValueToJSON as decimal strings (kind 1).
	switch v := r.Value.(type) {
	case nil:
		a.b(off+69, 0)
	case string:
		a.b(off+69, 1)
		a.u32(off+72, a.str(v))
	case float64:
		a.b(off+69, 2)
		a.f64(off+80, v)
	case bool:
		a.b(off+69, 3)
		// The arena buffer is reused across calls without zeroing: write the
		// value byte unconditionally or a `false` reads back a stale 1.
		a.b(off+80, 0)
		if v {
			a.b(off+80, 1)
		}
	default:
		a.b(off+69, 0)
	}
	a.u32(off+88, a.str(r.IntrinsicName))
	a.typeIDs(off+92, r.TypeParameters)
	a.typeIDs(off+100, r.OuterTypeParameters)
	a.typeIDs(off+108, r.LocalTypeParameters)
	a.typeIDs(off+116, r.AliasTypeArguments)
	a.strArray(off+124, r.Texts)
	a.u8Array(off+132, r.ElementFlags)
	a.nodeHandleArray(off+140, r.LabeledElementDeclarations)
	// offset map (u32 unless noted):
	//   0 id / 4 flags / 8 objectFlags / 12 target / 16 freshType / 20 regularType
	//   24 objectType / 28 indexType / 32 checkType / 36 extendsType / 40 baseType
	//   44 substConstraint / 48 symbol u64 / 56 aliasSymbol u64 / 64 fixedLength i32
	//   68 flags2 / 69 valueKind / 70-71 pad / 72 valueStr u32 / 76 pad
	//   80 valueF64 f64 / 88 intrinsicName / 92 typeParameters / 100 outer
	//   108 local / 116 aliasTypeArguments / 124 texts / 132 elementFlags
	//   140 labeledElementDeclarations / 148-151 pad
}

// encodeSymbolResponse writes a SymbolResponse record (72 bytes fixed).
func (a *arena) encodeSymbolResponse(r *SymbolResponse) {
	a.encodeSymbolResponseAt(a.rec(72), r)
}

// encodeSymbolResponseAt writes a SymbolResponse record at off (pack region).
func (a *arena) encodeSymbolResponseAt(off int, r *SymbolResponse) {
	a.u64(off+0, uint64(r.Id))
	a.u32(off+8, a.str(string(r.Project)))
	a.u32(off+12, a.str(r.Name))
	a.u32(off+16, r.Flags)
	a.u32(off+20, r.CheckFlags)
	a.u32(off+24, 0)
	a.u32(off+28, uint32(len(r.Declarations)))
	if len(r.Declarations) > 0 {
		p := a.pack(16 * len(r.Declarations))
		a.u32(off+24, uint32(p))
		for i, d := range r.Declarations {
			a.nodeHandleRec(p+16*i, d)
		}
	}
	a.nodeHandleRec(off+32, r.ValueDeclaration)
	a.u64(off+48, uint64(r.Parent))
	a.u64(off+56, uint64(r.ExportSymbol))
}

// encodeSignatureResponse writes a SignatureResponse record (64 bytes fixed).
func (a *arena) encodeSignatureResponse(r *SignatureResponse) {
	off := a.rec(64)
	a.u64(off+0, uint64(r.Id))
	a.u32(off+8, r.Flags)
	a.nodeHandleRec(off+12, r.Declaration)
	a.typeIDs(off+28, r.TypeParameters)
	a.u32(off+36, 0)
	a.u32(off+40, uint32(len(r.Parameters)))
	if len(r.Parameters) > 0 {
		p := a.pack(8 * len(r.Parameters))
		a.u32(off+36, uint32(p))
		for i, v := range r.Parameters {
			a.u64(p+8*i, uint64(v))
		}
	}
	a.u64(off+44, uint64(r.ThisParameter))
	a.u64(off+52, uint64(r.Target))
}

// ── LS navigation payloads (issue #12) ─────────────────────────────────────
// The arena buffer is reused without zeroing: every defined field is written
// unconditionally (stale bytes must never read back as data).

const (
	quickinfoRecordSize        = 48
	displayPartRecordSize      = 8
	tagRecordSize              = 12
	definitionRecordSize       = 48
	referenceEntryRecordSize   = 24
	referencedSymbolRecordSize = 56
	dabsRecordSize             = 16
)

// displayParts writes a (ptr,count) pair of {text strId, kind strId} records.
func (a *arena) displayParts(off int, parts []DisplayPartResponse) {
	a.u32(off, 0)
	a.u32(off+4, uint32(len(parts)))
	if len(parts) == 0 {
		return
	}
	p := a.pack(displayPartRecordSize * len(parts))
	a.u32(off, uint32(p))
	for i, part := range parts {
		a.u32(p+displayPartRecordSize*i, a.str(part.Text))
		a.u32(p+displayPartRecordSize*i+4, a.str(part.Kind))
	}
}

// encodeQuickinfoResponse writes a QuickinfoResponse record (48 bytes fixed).
func (a *arena) encodeQuickinfoResponse(r *QuickinfoResponse) {
	off := a.rec(quickinfoRecordSize)
	a.u32(off+0, a.str(r.Kind))
	a.u32(off+4, a.str(r.KindModifiers))
	a.u32(off+8, r.Start)
	a.u32(off+12, r.Length)
	a.u32(off+16, a.str(r.DisplayString))
	a.displayParts(off+20, r.Documentation)
	a.u32(off+28, 0)
	a.u32(off+32, uint32(len(r.Tags)))
	if len(r.Tags) > 0 {
		p := a.pack(tagRecordSize * len(r.Tags))
		a.u32(off+28, uint32(p))
		for i, t := range r.Tags {
			a.u32(p+tagRecordSize*i, a.str(t.Name))
			a.displayParts(p+tagRecordSize*i+4, t.Text)
		}
	}
	var flags byte
	if r.CanIncreaseVerbosityLevel != nil {
		flags |= 1
		if *r.CanIncreaseVerbosityLevel {
			flags |= 2
		}
	}
	a.b(off+36, flags)
	a.b(off+37, 0)
	a.b(off+38, 0)
	a.b(off+39, 0)
	a.displayParts(off+40, r.DisplayParts)
	// offset map (u32 unless noted):
	//   0 kind / 4 kindModifiers / 8 start / 12 length / 16 displayString
	//   20 documentation (ptr,count) / 28 tags (ptr,count) / 36 flags u8 / 37-39 pad
	//   40 displayParts (ptr,count)
}

// encodeDefinitionInfoResponse writes a DefinitionInfoResponse record (48 bytes)
// at off (inline in a parent record or in a pack-region run).
func (a *arena) encodeDefinitionInfoResponse(off int, r *DefinitionInfoResponse) {
	a.u32(off+0, a.str(r.FileName))
	a.u32(off+4, r.Start)
	a.u32(off+8, r.Length)
	var contextStart, contextLength uint32
	if r.ContextStart != nil {
		contextStart = *r.ContextStart
	}
	if r.ContextLength != nil {
		contextLength = *r.ContextLength
	}
	a.u32(off+12, contextStart)
	a.u32(off+16, contextLength)
	a.u32(off+20, a.str(r.Kind))
	a.u32(off+24, a.str(r.Name))
	var containerKind, containerName string
	if r.ContainerKind != nil {
		containerKind = *r.ContainerKind
	}
	if r.ContainerName != nil {
		containerName = *r.ContainerName
	}
	a.u32(off+28, a.str(containerKind))
	a.u32(off+32, a.str(containerName))
	a.displayParts(off+36, r.DisplayParts)
	var f1, f2 byte
	if r.ContextStart != nil {
		f1 |= 1
	}
	if r.ContainerKind != nil {
		f1 |= 2
	}
	if r.ContainerName != nil {
		f1 |= 4
	}
	if r.Unverified != nil {
		f1 |= 8
		if *r.Unverified {
			f2 |= 1
		}
	}
	if r.IsLocal != nil {
		f1 |= 16
		if *r.IsLocal {
			f2 |= 2
		}
	}
	if r.IsAmbient != nil {
		f1 |= 32
		if *r.IsAmbient {
			f2 |= 4
		}
	}
	if r.FailedAliasResolution != nil {
		f1 |= 64
		if *r.FailedAliasResolution {
			f2 |= 8
		}
	}
	a.b(off+44, f1)
	a.b(off+45, f2)
	a.b(off+46, 0)
	a.b(off+47, 0)
	// offset map (u32 unless noted):
	//   0 file / 4 start / 8 length / 12 contextStart / 16 contextLength
	//   20 kind / 24 name / 28 containerKind / 32 containerName
	//   36 displayParts (ptr,count) / 44 presenceFlags u8 / 45 valueFlags u8 / 46-47 pad
}

// zeroDefinitionInfo zeroes an inline definition slot (nil definition in a
// referenced-symbol record) so stale buffer contents never read back as data.
func (a *arena) zeroDefinitionInfo(off int) {
	for i := 0; i < definitionRecordSize; i += 4 {
		a.u32(off+i, 0)
	}
}

// encodeReferenceEntryResponse writes a ReferenceEntryResponse record (24 bytes).
func (a *arena) encodeReferenceEntryResponse(off int, r *ReferenceEntryResponse) {
	a.u32(off+0, a.str(r.FileName))
	a.u32(off+4, r.Start)
	a.u32(off+8, r.Length)
	var contextStart, contextLength uint32
	if r.ContextStart != nil {
		contextStart = *r.ContextStart
	}
	if r.ContextLength != nil {
		contextLength = *r.ContextLength
	}
	a.u32(off+12, contextStart)
	a.u32(off+16, contextLength)
	var flags byte
	if r.ContextStart != nil {
		flags |= 1
	}
	if r.IsWriteAccess {
		flags |= 2
	}
	if r.IsDefinition != nil {
		flags |= 4
		if *r.IsDefinition {
			flags |= 8
		}
	}
	if r.IsInString != nil && *r.IsInString {
		flags |= 16
	}
	a.b(off+20, flags)
	a.b(off+21, 0)
	a.b(off+22, 0)
	a.b(off+23, 0)
	// offset map: 0 file / 4 start / 8 length / 12 contextStart / 16 contextLength
	//   20 flags u8 (bit0 hasContext, bit1 isWriteAccess, bit2 hasIsDefinition,
	//   bit3 isDefinition, bit4 isInString) / 21-23 pad
}

// encodeReferencedSymbolResponse writes a ReferencedSymbolResponse record
// (56 bytes: inline definition at +0..47, references (ptr,count) at +48).
func (a *arena) encodeReferencedSymbolResponse(r *ReferencedSymbolResponse) {
	off := a.rec(referencedSymbolRecordSize)
	if r.Definition != nil {
		a.encodeDefinitionInfoResponse(off, r.Definition)
	} else {
		a.zeroDefinitionInfo(off)
	}
	a.u32(off+48, 0)
	a.u32(off+52, uint32(len(r.References)))
	if len(r.References) > 0 {
		p := a.pack(referenceEntryRecordSize * len(r.References))
		a.u32(off+48, uint32(p))
		for i, e := range r.References {
			a.encodeReferenceEntryResponse(p+referenceEntryRecordSize*i, e)
		}
	}
}

// encodeDefinitionAndBoundSpanResponse writes a DefinitionAndBoundSpanResponse
// record (16 bytes: span start/length, definitions (ptr,count)).
func (a *arena) encodeDefinitionAndBoundSpanResponse(r *DefinitionAndBoundSpanResponse) {
	off := a.rec(dabsRecordSize)
	a.u32(off+0, r.Start)
	a.u32(off+4, r.Length)
	a.u32(off+8, 0)
	a.u32(off+12, uint32(len(r.Definitions)))
	if len(r.Definitions) > 0 {
		p := a.pack(definitionRecordSize * len(r.Definitions))
		a.u32(off+8, uint32(p))
		for i, d := range r.Definitions {
			a.encodeDefinitionInfoResponse(p+definitionRecordSize*i, d)
		}
	}
}

const jsdocTagRecordSize = 8

const ambientModuleRecordSize = 40

// encodeJSDocTag writes a JSDocTagInfo record ({name strId, text strId}, 8 bytes).
func (a *arena) encodeJSDocTag(t *JSDocTagInfo) {
	off := a.rec(jsdocTagRecordSize)
	a.u32(off+0, a.str(t.Name))
	a.u32(off+4, a.str(t.Text))
}

// zeroSymbolRecord zeroes one 72-byte symbol slot (a nil element in a symbols run
// reads back as JS null — getSymbolsDeclarations/getParentsOfSymbols holes).
func (a *arena) zeroSymbolRecord(off int) {
	for i := 0; i < 72; i += 4 {
		a.u32(off+i, 0)
	}
}

// encodeLightSymbol writes a LightSymbolResponse record (32 bytes fixed).
func (a *arena) encodeLightSymbol(off int, s *LightSymbolResponse) {
	if s == nil {
		for i := 0; i < 32; i += 4 {
			a.u32(off+i, 0)
		}
		return
	}
	a.u64(off+0, uint64(s.Id))
	a.u32(off+8, a.str(string(s.Project)))
	a.u32(off+12, a.str(s.Name))
	a.u32(off+16, s.Flags)
	a.u32(off+20, s.CheckFlags)
	a.u64(off+24, uint64(s.Parent))
}

// encodeAmbientModule writes an AmbientModuleResponse record (40 bytes:
// moduleName strId, pad, inline 32-byte light symbol).
func (a *arena) encodeAmbientModule(off int, m *AmbientModuleResponse) {
	a.u32(off+0, a.str(m.ModuleName))
	a.u32(off+4, 0)
	a.encodeLightSymbol(off+8, m.ModuleSymbol)
}

// encodeAmbientModulesResponse writes an AmbientModulesResponse as a single
// 8-byte record {modules ptr, modules count} with 40-byte module records packed.
func (a *arena) encodeAmbientModulesResponse(r *AmbientModulesResponse) {
	off := a.rec(8)
	a.u32(off+0, 0)
	a.u32(off+4, uint32(len(r.Modules)))
	if len(r.Modules) > 0 {
		p := a.pack(ambientModuleRecordSize * len(r.Modules))
		a.u32(off+0, uint32(p))
		for i, m := range r.Modules {
			a.encodeAmbientModule(p+ambientModuleRecordSize*i, m)
		}
	}
}

// encodeExpandedParameters writes a [][]SymbolID as an outer (ptr,count) array
// of inner (ptr,count) u64 runs (the getExpandedParameters result).
func (a *arena) encodeExpandedParameters(v [][]SymbolID) {
	off := a.rec(8)
	a.u32(off+0, 0)
	a.u32(off+4, uint32(len(v)))
	if len(v) == 0 {
		a.finish(arenaKindRecord)
		return
	}
	// Like records(): the pack region starts after all fixed records.
	a.packOff = a.recOff
	p := a.pack(8 * len(v))
	a.u32(off+0, uint32(p))
	for i, inner := range v {
		a.u32(p+8*i, 0)
		a.u32(p+8*i+4, uint32(len(inner)))
		if len(inner) > 0 {
			q := a.pack(8 * len(inner))
			a.u32(p+8*i, uint32(q))
			for j, id := range inner {
				a.u64(q+8*j, uint64(id))
			}
		}
	}
	a.finish(arenaKindRecord)
}

// ── Completions (issue #12) ───────────────────────────────────────────────

const (
	completionInfoRecordSize  = 32
	completionEntryRecordSize = 88
)

// encodeCompletionEntry writes a CompletionEntryResponse record (88 bytes fixed).
func (a *arena) encodeCompletionEntry(off int, r *CompletionEntryResponse) {
	a.u32(off+0, a.str(r.Name))
	a.u32(off+4, a.str(r.ElementKind))
	a.u32(off+8, a.str(r.KindModifiers))
	a.u32(off+12, a.str(strVal(r.SortText)))
	a.u32(off+16, a.str(strVal(r.InsertText)))
	a.u32(off+20, a.str(strVal(r.FilterText)))
	a.u32(off+24, a.str(r.Source))
	a.u32(off+28, a.str(strVal(r.Detail)))
	var ldDetail, ldDesc string
	if r.LabelDetails != nil {
		ldDetail = strVal(r.LabelDetails.Detail)
		ldDesc = strVal(r.LabelDetails.Description)
	}
	a.u32(off+32, a.str(ldDetail))
	a.u32(off+36, a.str(ldDesc))
	var repStart, repLen uint32
	if r.ReplacementStart != nil {
		repStart = *r.ReplacementStart
	}
	if r.ReplacementLength != nil {
		repLen = *r.ReplacementLength
	}
	a.u32(off+40, repStart)
	a.u32(off+44, repLen)
	a.strArray(off+48, r.CommitCharacters)
	a.u32(off+56, 0)
	if r.Symbol != nil {
		p := a.pack(72)
		a.u32(off+56, uint32(p))
		a.encodeSymbolResponseAt(p, r.Symbol)
	}
	a.u32(off+60, r.Kind)
	var flags byte
	if r.HasAction != nil && *r.HasAction {
		flags |= 1
	}
	if r.IsRecommended != nil && *r.IsRecommended {
		flags |= 2
	}
	if r.ReplacementStart != nil {
		flags |= 4
	}
	if r.LabelDetails != nil {
		flags |= 8
	}
	if r.Symbol != nil {
		flags |= 16
	}
	var dataExportName, dataFileName, dataModuleSpecifier string
	if r.Data != nil {
		flags |= 32
		dataExportName = r.Data.ExportName
		dataFileName = r.Data.FileName
		dataModuleSpecifier = r.Data.ModuleSpecifier
	}
	if r.IsPackageJsonImport != nil && *r.IsPackageJsonImport {
		flags |= 64
	}
	a.b(off+64, flags)
	a.b(off+65, 0)
	a.b(off+66, 0)
	a.b(off+67, 0)
	a.u32(off+68, a.str(dataModuleSpecifier))
	a.u32(off+72, a.str(dataExportName))
	a.u32(off+76, a.str(dataFileName))
	a.displayParts(off+80, r.SourceDisplay)
	// offset map (u32 unless noted):
	//   0 name / 4 elementKind / 8 kindModifiers / 12 sortText / 16 insertText
	//   20 filterText / 24 source / 28 detail / 32 labelDetail.detail
	//   36 labelDetail.description / 40 replacementStart / 44 replacementLength
	//   48 commitCharacters (ptr,count) / 56 symbolPtr / 60 kindU32 / 64 flags u8
	//   65-67 pad / 68 dataModuleSpecifier / 72 dataExportName / 76 dataFileName
	//   80 sourceDisplay (ptr,count of {text,kind} records)
}

// encodeCompletionsResponse writes a CompletionInfoResponse record (32 bytes).
func (a *arena) encodeCompletionsResponse(r *CompletionInfoResponse) {
	off := a.rec(completionInfoRecordSize)
	var f1, f2 byte
	if r.IsGlobalCompletion {
		f1 |= 1
	}
	if r.IsMemberCompletion {
		f1 |= 2
	}
	if r.IsNewIdentifierLocation {
		f1 |= 4
	}
	if r.IsIncomplete {
		f1 |= 8
	}
	if r.Flags != nil {
		f2 |= 1
	}
	if r.OptionalSpanStart != nil {
		f2 |= 2
	}
	if r.DefaultCommitCharacters != nil {
		f2 |= 4
	}
	a.b(off+0, f1)
	a.b(off+1, f2)
	a.b(off+2, 0)
	a.b(off+3, 0)
	var flagsField, spanStart, spanLen uint32
	if r.Flags != nil {
		flagsField = *r.Flags
	}
	if r.OptionalSpanStart != nil {
		spanStart = *r.OptionalSpanStart
	}
	if r.OptionalSpanLength != nil {
		spanLen = *r.OptionalSpanLength
	}
	a.u32(off+4, flagsField)
	a.u32(off+8, spanStart)
	a.u32(off+12, spanLen)
	a.strArray(off+16, r.DefaultCommitCharacters)
	a.u32(off+24, 0)
	a.u32(off+28, uint32(len(r.Entries)))
	if len(r.Entries) > 0 {
		p := a.pack(completionEntryRecordSize * len(r.Entries))
		a.u32(off+24, uint32(p))
		for i, e := range r.Entries {
			a.encodeCompletionEntry(p+completionEntryRecordSize*i, e)
		}
	}
	// offset map: 0-1 flags / 2-3 pad / 4 flagsField / 8 optionalSpanStart
	//   12 optionalSpanLength / 16 defaultCommitCharacters (ptr,count) / 24 entries (ptr,count)
}

// strVal dereferences an optional string ("" when nil).
func strVal(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// ── SignatureHelp (issue #12 batch 2) ─────────────────────────────────────

const (
	signatureHelpItemRecordSize      = 52
	signatureHelpParameterRecordSize = 24
	signatureHelpTopRecordSize       = 28
)

// encodeSignatureHelpParameter writes a SignatureHelpParameterResponse record
// (24 bytes: name strId, documentation (ptr,count), displayParts (ptr,count), flags).
func (a *arena) encodeSignatureHelpParameter(off int, p *SignatureHelpParameterResponse) {
	a.u32(off+0, a.str(p.Name))
	a.displayParts(off+4, p.Documentation)
	a.displayParts(off+12, p.DisplayParts)
	var flags byte
	if p.IsOptional {
		flags |= 1
	}
	if p.IsRest {
		flags |= 2
	}
	a.b(off+20, flags)
	a.b(off+21, 0)
	a.b(off+22, 0)
	a.b(off+23, 0)
}

// encodeSignatureHelpItem writes a SignatureHelpItemResponse record (48 bytes).
func (a *arena) encodeSignatureHelpItem(off int, r *SignatureHelpItemResponse) {
	a.displayParts(off+0, r.Prefix)
	a.displayParts(off+8, r.Suffix)
	a.displayParts(off+16, r.Separator)
	a.u32(off+24, 0)
	a.u32(off+28, uint32(len(r.Parameters)))
	if len(r.Parameters) > 0 {
		p := a.pack(signatureHelpParameterRecordSize * len(r.Parameters))
		a.u32(off+24, uint32(p))
		for i, param := range r.Parameters {
			a.encodeSignatureHelpParameter(p+signatureHelpParameterRecordSize*i, param)
		}
	}
	a.displayParts(off+32, r.Documentation)
	a.u32(off+40, 0)
	a.u32(off+44, uint32(len(r.Tags)))
	if len(r.Tags) > 0 {
		p := a.pack(tagRecordSize * len(r.Tags))
		a.u32(off+40, uint32(p))
		for i, t := range r.Tags {
			a.u32(p+tagRecordSize*i, a.str(t.Name))
			a.displayParts(p+tagRecordSize*i+4, t.Text)
		}
	}
	var flags byte
	if r.IsVariadic {
		flags |= 1
	}
	a.b(off+48, flags)
	a.b(off+49, 0)
	a.b(off+50, 0)
	a.b(off+51, 0)
	// offset map: 0 prefix / 8 suffix / 16 separator (each (ptr,count))
	//   24 parameters (ptr,count) / 32 documentation (ptr,count) / 40 tags (ptr,count)
	//   48 flags u8 / 49-51 pad
}

// encodeSignatureHelpItemsResponse writes a SignatureHelpItemsResponse record (28 bytes).
func (a *arena) encodeSignatureHelpItemsResponse(r *SignatureHelpItemsResponse) {
	off := a.rec(signatureHelpTopRecordSize)
	a.u32(off+0, r.ApplicableSpan.Start)
	a.u32(off+4, r.ApplicableSpan.Length)
	a.u32(off+8, r.SelectedItemIndex)
	a.u32(off+12, r.ArgumentIndex)
	a.u32(off+16, r.ArgumentCount)
	a.u32(off+20, 0)
	a.u32(off+24, uint32(len(r.Items)))
	if len(r.Items) > 0 {
		p := a.pack(signatureHelpItemRecordSize * len(r.Items))
		a.u32(off+20, uint32(p))
		for i, item := range r.Items {
			a.encodeSignatureHelpItem(p+signatureHelpItemRecordSize*i, item)
		}
	}
}

// ── Rename (issue #12 batch 2) ────────────────────────────────────────────

const (
	renameInfoRecordSize     = 36
	renameLocationRecordSize = 32
)

// encodeRenameInfoResponse writes a RenameInfoResponse record (36 bytes).
func (a *arena) encodeRenameInfoResponse(r *RenameInfoResponse) {
	off := a.rec(renameInfoRecordSize)
	var flags byte
	if r.CanRename {
		flags |= 1
	}
	if r.KindModifiers != nil {
		flags |= 2
	}
	a.b(off+0, flags)
	a.b(off+1, 0)
	a.b(off+2, 0)
	a.b(off+3, 0)
	a.u32(off+4, a.str(r.FileToRename))
	a.u32(off+8, a.str(r.DisplayName))
	a.u32(off+12, a.str(r.FullDisplayName))
	a.u32(off+16, a.str(r.Kind))
	a.u32(off+20, a.str(strVal(r.KindModifiers)))
	var spanStart, spanLen uint32
	if r.TriggerSpan != nil {
		spanStart = r.TriggerSpan.Start
		spanLen = r.TriggerSpan.Length
	}
	a.u32(off+24, spanStart)
	a.u32(off+28, spanLen)
	a.u32(off+32, a.str(r.LocalizedErrorMessage))
	// offset map: 0 flags / 4 fileToRename / 8 displayName / 12 fullDisplayName
	//   16 kind / 20 kindModifiers / 24 triggerSpanStart / 28 triggerSpanLength / 32 localizedErrorMessage
}

// encodeRenameLocationResponse writes a RenameLocationResponse record (32 bytes).
func (a *arena) encodeRenameLocationResponse(off int, r *RenameLocationResponse) {
	a.u32(off+0, a.str(r.FileName))
	a.u32(off+4, r.Start)
	a.u32(off+8, r.Length)
	var contextStart, contextLength uint32
	if r.ContextStart != nil {
		contextStart = *r.ContextStart
	}
	if r.ContextLength != nil {
		contextLength = *r.ContextLength
	}
	a.u32(off+12, contextStart)
	a.u32(off+16, contextLength)
	a.u32(off+20, a.str(r.PrefixText))
	a.u32(off+24, a.str(r.SuffixText))
	var flags byte
	if r.ContextStart != nil {
		flags |= 1
	}
	a.b(off+28, flags)
	a.b(off+29, 0)
	a.b(off+30, 0)
	a.b(off+31, 0)
}

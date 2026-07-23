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
	// offset map (u32 unless noted):
	//   0 id / 4 flags / 8 objectFlags / 12 target / 16 freshType / 20 regularType
	//   24 objectType / 28 indexType / 32 checkType / 36 extendsType / 40 baseType
	//   44 substConstraint / 48 symbol u64 / 56 aliasSymbol u64 / 64 fixedLength i32
	//   68 flags2 / 69 valueKind / 70-71 pad / 72 valueStr u32 / 76 pad
	//   80 valueF64 f64 / 88 intrinsicName / 92 typeParameters / 100 outer
	//   108 local / 116 aliasTypeArguments / 124 texts / 132 elementFlags
	//   140-151 reserved
}

// encodeSymbolResponse writes a SymbolResponse record (72 bytes fixed).
func (a *arena) encodeSymbolResponse(r *SymbolResponse) {
	off := a.rec(72)
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

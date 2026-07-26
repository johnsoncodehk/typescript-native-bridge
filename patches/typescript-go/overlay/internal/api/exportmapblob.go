package api

import "encoding/binary"

// Binary codec for the export map (getModuleExportMap over BridgeCallBinary).
// Little-endian; symbol ids are snapshot-registry handles (u64), strings are
// blob-local ids into the trailing table (0 = absent). The blob is
// self-contained — unlike the arena it carries its own string table, so the
// cold, unbounded populate payload never contends with the hot-query arena
// (measured at ~7MB JSON for a large node_modules project vs the arena's 3MB
// capacity).
//
//	header:  u32 version(1) | u32 strCount | u32 moduleCount | u32 reserved
//	modules: 48B head + optional 44B defaultExport + namedCount × 40B
//	symbol:  u64 id | u32 name | u32 flags | u32 checkFlags | u64 parent | u32 project
//	strings: strCount × (u32 len + bytes)
const exportMapBlobVersion = 1

type exportMapBlobWriter struct {
	buf    []byte
	strs   []string
	strIds map[string]uint32
}

func (w *exportMapBlobWriter) strId(s string) uint32 {
	if s == "" {
		return 0
	}
	if id, ok := w.strIds[s]; ok {
		return id
	}
	id := uint32(len(w.strs))
	w.strs = append(w.strs, s)
	w.strIds[s] = id
	return id
}

func (w *exportMapBlobWriter) u32(v uint32) { w.buf = binary.LittleEndian.AppendUint32(w.buf, v) }
func (w *exportMapBlobWriter) u64(v uint64) { w.buf = binary.LittleEndian.AppendUint64(w.buf, v) }

// symbol: u64 id | u32 name | u32 flags | u32 checkFlags | u64 parent | u32 project
// (32B; absent fields are zero). project/parent keep the wire identical to the JSON
// LightSymbolResponse — symbols materialized from the blob need a canonical
// project for follow-up .exports/.parent lookups.
func (w *exportMapBlobWriter) symbol(s *LightSymbolResponse) {
	if s == nil {
		w.u64(0)
		w.u32(0)
		w.u32(0)
		w.u32(0)
		w.u64(0)
		w.u32(0)
		return
	}
	w.u64(uint64(s.Id))
	w.u32(w.strId(s.Name))
	w.u32(s.Flags)
	w.u32(s.CheckFlags)
	w.u64(uint64(s.Parent))
	w.u32(w.strId(string(s.Project)))
}

func encodeModuleExportMapBlob(resp *ModuleExportMapResponse) []byte {
	w := &exportMapBlobWriter{strs: []string{""}, strIds: make(map[string]uint32)}
	w.u32(exportMapBlobVersion)
	w.u32(0) // strCount, backpatched below
	w.u32(uint32(len(resp.Modules)))
	w.u32(0) // reserved
	for _, mod := range resp.Modules {
		w.symbol(mod.ModuleSymbol)
		w.u32(w.strId(mod.ModuleName))
		w.u32(w.strId(mod.ModuleFileName))
		w.u32(uint32(len(mod.NamedExports)))
		if mod.DefaultExport != nil {
			w.u32(1)
			w.symbol(mod.DefaultExport.Symbol)
			w.u32(w.strId(mod.DefaultExport.TableKey))
			w.u32(uint32(mod.DefaultExport.ExportKind))
			w.u32(mod.DefaultExport.TargetFlags)
		} else {
			w.u32(0)
		}
		for _, exp := range mod.NamedExports {
			w.symbol(exp.Symbol)
			w.u32(w.strId(exp.Key))
			w.u32(exp.TargetFlags)
		}
	}
	for _, s := range w.strs {
		w.u32(uint32(len(s)))
		w.buf = append(w.buf, s...)
	}
	binary.LittleEndian.PutUint32(w.buf[4:], uint32(len(w.strs)))
	return w.buf
}

package checker

// TNB additions to package checker, kept out of checker.go so its in-place patch
// carries only edits to upstream code.

import (
	"sync"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/collections"
)

// resolvedPropertiesCache is a program-level memo for the member list of a
// union/intersection type. Checkers are pooled by lifetime (diagnostics, query,
// API) and each owns its own type store, so the per-type resolvedProperties
// field on UnionOrIntersectionType is recomputed once per checker lifetime.
// Only results whose symbols are all real declaration symbols (no
// SymbolFlagsTransient) are shared: synthetic union/intersection properties
// carry per-checker valueSymbolLinks (containingType, resolvedType) and must
// never cross a checker boundary.
type ResolvedPropertiesCache struct {
	mu    sync.Mutex
	items map[CacheHashKey][]*ast.Symbol
}

func (m *ResolvedPropertiesCache) load(key CacheHashKey) []*ast.Symbol {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.items[key]
}

func (m *ResolvedPropertiesCache) storeIfShareable(key CacheHashKey, props []*ast.Symbol) {
	if !resolvedPropertiesShareable(props) {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.items == nil {
		m.items = make(map[CacheHashKey][]*ast.Symbol)
	}
	m.items[key] = props
}

// resolvedPropertiesShareable reports whether every symbol is a real
// declaration symbol (safe to reuse across checkers). Synthetic
// union/intersection properties are marked SymbolFlagsTransient and hold
// per-checker valueSymbolLinks.
func resolvedPropertiesShareable(props []*ast.Symbol) bool {
	for _, prop := range props {
		if prop.Flags&ast.SymbolFlagsTransient != 0 {
			return false
		}
	}
	return true
}

type resolvedPropertiesCacheProvider interface {
	GetResolvedPropertiesCache() *ResolvedPropertiesCache
}

func (c *Checker) getResolvedPropertiesCache() *ResolvedPropertiesCache {
	if provider, ok := c.program.(resolvedPropertiesCacheProvider); ok {
		return provider.GetResolvedPropertiesCache()
	}
	return nil
}

// resolvedPropertiesProgramKey returns a cross-checker-stable key for a
// union/intersection type whose constituents are all plain binder symbols
// (non-generic named types). The second result is false when no stable key
// exists, in which case the result must stay in the per-checker memo.
func (c *Checker) resolvedPropertiesProgramKey(t *Type) (CacheHashKey, bool) {
	d := t.AsUnionOrIntersectionType()
	var b keyBuilder
	if t.flags&TypeFlagsIntersection != 0 {
		b.writeByte('&')
	} else {
		b.writeByte('|')
	}
	for _, current := range d.types {
		if current.symbol == nil || current.symbol.Flags&ast.SymbolFlagsTransient != 0 {
			return CacheHashKey{}, false
		}
		// A constituent whose identity is not fully captured by its declaration
		// symbol (a generic instantiation, mapped type, or other instantiated
		// type) cannot be keyed stably across checkers: distinct instantiations
		// share one symbol and would collide in the program-level cache, serving
		// the wrong member list (e.g. `Partial<{}>` vs `Partial<{ x: string }>`).
		if current.objectFlags&(ObjectFlagsReference|ObjectFlagsMapped|ObjectFlagsInstantiated) != 0 {
			return CacheHashKey{}, false
		}
		b.writeSymbol(current.symbol)
	}
	return b.hash(), true
}

func (c *Checker) computePropertiesOfUnionOrIntersectionType(t *Type, d *UnionOrIntersectionType) []*ast.Symbol {
	var checked collections.Set[string]
	props := []*ast.Symbol{}
	for _, current := range d.types {
		for _, prop := range c.getPropertiesOfType(current) {
			if !checked.Has(prop.Name) {
				checked.Add(prop.Name)
				combinedProp := c.getPropertyOfUnionOrIntersectionType(t, prop.Name, t.flags&TypeFlagsIntersection != 0 /*skipObjectFunctionPropertyAugment*/)
				if combinedProp != nil {
					props = append(props, combinedProp)
				}
			}
		}
		// The properties of a union type are those that are present in all constituent types, so
		// we only need to check the properties of the first type without index signature
		if t.flags&TypeFlagsUnion != 0 && len(c.getIndexInfosOfType(current)) == 0 {
			break
		}
	}
	return props
}

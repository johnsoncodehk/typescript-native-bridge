/**
 * Decode batched binary source-file payloads from getSourceFiles RPC.
 * Lint uses the sync API; this stub satisfies the async build until a full
 * decoder is wired.
 */
export function decodeSourceFilesBatch(_data: Uint8Array): (Uint8Array | undefined)[] {
    throw new Error("decodeSourceFilesBatch is not implemented; use sync getSourceFile");
}

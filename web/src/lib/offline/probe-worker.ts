/// <reference lib="webworker" />
// Tiny dedicated worker: answers whether OPFS sync access handles exist here. FileSystemFileHandle.createSyncAccessHandle
// is only exposed in dedicated workers, so the main thread cannot test it itself (see probeSyncAccess in opfs.ts).
const scope = self as unknown as DedicatedWorkerGlobalScope;
const h = (scope as unknown as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle;
scope.postMessage({ type: 'opfs-probe', sync: Boolean(h && 'createSyncAccessHandle' in h.prototype && scope.navigator.storage?.getDirectory) });
scope.close();

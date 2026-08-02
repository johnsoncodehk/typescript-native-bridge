// GC-at-mark helper for tools/triage-generation-retention.mjs — --require'd
// into the tsserver child via NODE_OPTIONS. Counts `definition` responses on
// stdout; at each configured mark (TNB_GC_MARKS, comma-separated response
// numbers) forces two major GCs through the inspector and appends the
// post-GC memoryUsage to TNB_MEMLOG_FILE. Post-GC heapUsed is the exact
// retained size, so a per-generation leak (a closure pinning a program
// generation island onto a process-global object) shows up as a rising
// mark series.
//
// Env:
//   TNB_GC_MARKS     comma-separated definition-response numbers to GC at
//   TNB_MEMLOG_FILE  output log path (driver polls it for GCMARK lines)
const fs = require('fs');
const inspector = require('inspector');

if (process.env.TNB_GC_MARKS && process.env.TNB_MEMLOG_FILE) {
    const marks = new Set(process.env.TNB_GC_MARKS.split(',').map(Number).filter(n => n > 0));
    const logFile = process.env.TNB_MEMLOG_FILE;
    const session = new inspector.Session();
    session.connect();
    const collectGarbage = () => new Promise((res, rej) =>
        session.post('HeapProfiler.collectGarbage', {}, e => (e ? rej(e) : res())));
    let count = 0;
    // Response JSON can split across stdout writes; keep a rolling tail so
    // the marker substring is matched across chunk boundaries.
    let tail = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = function (chunk, ...rest) {
        const text = tail + String(chunk);
        const hits = text.split('"command":"definition"').length - 1;
        for (let i = 0; i < hits; i++) {
            count++;
            if (marks.has(count)) {
                const n = count;
                collectGarbage()
                    .then(collectGarbage)
                    .then(() => {
                        const mu = process.memoryUsage();
                        fs.appendFileSync(logFile, `GCMARK def=${n} heapUsed=${mu.heapUsed} heapTotal=${mu.heapTotal} rss=${mu.rss} external=${mu.external}\n`);
                    })
                    .catch(err => fs.appendFileSync(logFile, `GCMARK def=${n} ERROR ${err && err.message}\n`));
            }
        }
        tail = text.slice(-64);
        return origWrite(chunk, ...rest);
    };
}

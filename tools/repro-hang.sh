#!/bin/zsh
# Reproduce / regression-test the vitest orphan + ResetStdio signal storm.
# Usage:
#   VOLAR_DIR=~/Desktop/volar/vue ./tools/repro-hang.sh          # regression (guard on)
#   REPRO=1 VOLAR_DIR=... ./tools/repro-hang.sh                # repro (guard off)
# Prefer a real TTY, or: script -q /dev/null zsh tools/repro-hang.sh
set -u

VOLAR_DIR="${VOLAR_DIR:?set VOLAR_DIR to the volar repo root}"
export TNB_TRACE_RPC="${TNB_TRACE_RPC:-1}"
export GOGC=5

if [[ "${REPRO:-}" == "1" ]]; then
	export TNB_SKIP_ASYNC_PREEMPT_OFF=1
	echo "repro-hang: REPRO mode — guard disabled"
else
	unset TNB_SKIP_ASYNC_PREEMPT_OFF
	echo "repro-hang: regression mode — guard enabled"
fi

for i in {1..60}; do
	rm -f /tmp/tnb-rpc.log
	( cd "$VOLAR_DIR/packages/language-server" && pnpm exec vitest run ) &
	parent=$!
	sleep $(( (RANDOM % 70 + 10) / 10.0 ))
	worker=$(pgrep -P "$parent" -f 'forks\.js' 2>/dev/null | head -1)
	if [[ -z "${worker:-}" ]]; then
		worker=$(pgrep -f 'vitest.*forks' | grep -v "$parent" | head -1)
	fi
	kill -KILL "$parent" 2>/dev/null
	[[ -n "${worker:-}" ]] && kill -TERM "$worker" 2>/dev/null
	sleep 5
	if [[ -n "${worker:-}" ]] && ps -p "$worker" >/dev/null 2>&1; then
		cpu=$(ps -o %cpu= -p "$worker" | tr -d ' ')
		echo "iter $i: REPRODUCED — worker $worker cpu=${cpu}%"
		sample "$worker" 3 -file "/tmp/tnb-hang-$i.txt" 2>/dev/null || true
		echo "stack: /tmp/tnb-hang-$i.txt ; trace: /tmp/tnb-rpc.log"
		exit 1
	fi
	echo "iter $i: clean"
	pkill -f 'vitest.*forks' 2>/dev/null || true
done
echo "60 iterations clean"
exit 0

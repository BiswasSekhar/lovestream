// Node.js polyfills needed by simple-peer (readable-stream)
import { Buffer } from 'buffer';
import process from 'process';

globalThis.Buffer = Buffer;
globalThis.process = process;

if (!globalThis.electron) {
	globalThis.electron = {
		platform: null,
		nativeVlc: null,
	};
}

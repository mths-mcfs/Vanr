// Extraction worker: the PDF parser and the zip run off the server thread, with a deadline (the
// caller ends the Worker when the deadline passes).
import { extractPages } from "./drive-extract-core";

declare const self: Worker;

self.onmessage = async (e: MessageEvent<{ bytes: Uint8Array; type: string }>) => {
  try {
    postMessage({ ok: true, pages: await extractPages(e.data.bytes, e.data.type) });
  } catch (err) {
    postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};

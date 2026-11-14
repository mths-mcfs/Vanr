import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  generateUpdateKeys,
  signManifest,
  verifyManifest,
} from "@vanr/engine/runner-update";
import { TEST_UPDATE_PUBLIC_KEY, TEST_UPDATE_SEED } from "./testing/update-keys";
import { checkUpdate, rollbackUpdate, UpdateError, update } from "./update";

// Signed updater (F5-3.3-P0-01). A local server serves the manifest and the bundle; each test sets up
// what the server offers. The installed runner is a file that prints its version, like the real bundle.
const dir = mkdtempSync(join(tmpdir(), "runner-update-"));
let offer: { manifest: Record<string, unknown> | null; bundle: Uint8Array } = {
  manifest: null,
  bundle: new Uint8Array(),
};
let server: ReturnType<typeof Bun.serve>;
let base = "";

const script = (version: string) =>
  new TextEncoder().encode(`if (process.argv[2] === "version") console.log(${JSON.stringify(version)});\n`);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function serve(
  version: string,
  opts: { seed?: string | null; bytes?: Uint8Array; signVersion?: string } = {},
) {
  const bytes = opts.bytes ?? script(version);
  const signed = { version: opts.signVersion ?? version, sha256: sha(bytes), size: bytes.byteLength };
  const seed = opts.seed === undefined ? TEST_UPDATE_SEED : opts.seed;
  offer = {
    manifest: {
      version,
      sha256: signed.sha256,
      size: signed.size,
      url: "/runner/r.mjs",
      ...(seed ? { signature: signManifest(signed, seed) } : {}),
    },
    bundle: bytes,
  };
}

function installed(version: string): string {
  const path = join(dir, `runner-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(path, script(version));
  return path;
}

const opts = (bundlePath: string | null, current = "0.2.0") => ({
  server: base,
  bundlePath,
  current,
  publicKey: TEST_UPDATE_PUBLIC_KEY,
});

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof UpdateError) return err.code;
    throw err;
  }
  return "installed";
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/v1/runners/runner/latest")
        return offer.manifest ? Response.json(offer.manifest) : new Response("no", { status: 404 });
      if (path === "/runner/r.mjs") return new Response(offer.bundle);
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("Ed25519 signature: checks with the right key and fails with another, with tampered bytes or without a signature", () => {
  const m = { version: "1.2.3", sha256: "a".repeat(64), size: 10, url: "/x" };
  const signature = signManifest(m, TEST_UPDATE_SEED);
  expect(verifyManifest({ ...m, signature }, TEST_UPDATE_PUBLIC_KEY)).toBe(true);
  expect(verifyManifest({ ...m, signature }, generateUpdateKeys().publicKey)).toBe(false);
  expect(verifyManifest({ ...m, version: "1.2.4", signature }, TEST_UPDATE_PUBLIC_KEY)).toBe(false);
  expect(verifyManifest({ ...m, size: 11, signature }, TEST_UPDATE_PUBLIC_KEY)).toBe(false);
  expect(verifyManifest(m, TEST_UPDATE_PUBLIC_KEY)).toBe(false);
  expect(verifyManifest({ ...m, signature: "AAAA" }, TEST_UPDATE_PUBLIC_KEY)).toBe(false);
  expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(() => compareVersions("1.0", "1.0.0")).toThrow();
});

test("signed new version: downloads, checks, runs `version` and swaps the bundle (the old one stays in .prev)", async () => {
  const path = installed("0.2.0");
  serve("0.3.0");
  expect(await update(opts(path))).toBe("0.3.0");
  expect(readFileSync(path, "utf8")).toContain('"0.3.0"');
  expect(readFileSync(`${path}.prev`, "utf8")).toContain('"0.2.0"');
  expect(existsSync(`${path}.new`)).toBe(false);
  // Go back to the previous one.
  expect(rollbackUpdate(path)).toBe(true);
  expect(readFileSync(path, "utf8")).toContain('"0.2.0"');
});

test("attack: a manifest signed with another key is rejected and nothing is swapped", async () => {
  const path = installed("0.2.0");
  serve("0.3.0", { seed: generateUpdateKeys().seed });
  expect(await refusal(update(opts(path)))).toBe("bad_signature");
  expect(readFileSync(path, "utf8")).toContain('"0.2.0"');
  expect(existsSync(`${path}.prev`)).toBe(false);
});

test("attack: a manifest without a signature is rejected", async () => {
  const path = installed("0.2.0");
  serve("0.3.0", { seed: null });
  expect(await refusal(update(opts(path)))).toBe("unsigned");
  expect(readFileSync(path, "utf8")).toContain('"0.2.0"');
});

test("attack: an older version (downgrade), even when properly signed, is rejected", async () => {
  const path = installed("0.2.0");
  serve("0.1.9");
  expect(await refusal(update(opts(path)))).toBe("downgrade");
  expect(readFileSync(path, "utf8")).toContain('"0.2.0"');
  // The same version does not reinstall.
  serve("0.2.0");
  expect(await checkUpdate(opts(path))).toBeNull();
});

test("attack: manifest version swapped after signing (new label, signature of the old one)", async () => {
  const path = installed("0.2.0");
  serve("9.0.0", { signVersion: "0.1.0" });
  expect(await refusal(update(opts(path)))).toBe("bad_signature");
});

test("attack: a bundle different from the signed one (sha256 or size) is rejected before writing", async () => {
  const path = installed("0.2.0");
  serve("0.3.0");
  offer.bundle = script("0.3.0").map((b, i) => (i === 0 ? b ^ 1 : b));
  expect(await refusal(update(opts(path)))).toBe("bad_bundle");
  expect(readFileSync(path, "utf8")).toContain('"0.2.0"');
  expect(existsSync(`${path}.new`)).toBe(false);
});

test("a signed bundle that does not start (or reports another version) does not take the place of the current one", async () => {
  const path = installed("0.2.0");
  serve("0.3.0", { bytes: script("0.2.5") });
  expect(await refusal(update(opts(path)))).toBe("broken_bundle");
  expect(readFileSync(path, "utf8")).toContain('"0.2.0"');
  expect(existsSync(`${path}.new`)).toBe(false);
});

test("running from source, the updater swaps nothing; a server without a key says there is no update", async () => {
  serve("0.3.0");
  expect(await refusal(update(opts(null)))).toBe("not_installed");
  offer.manifest = null;
  expect(await refusal(update(opts(installed("0.2.0"))))).toBe("off");
});

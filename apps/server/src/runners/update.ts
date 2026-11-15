// Runner update: the server signs the manifest of the bundle it serves itself
// with the RUNNER_SIGNING_KEY seed. Without the key, there is no manifest (404) nor a hint in `welcome`: the
// runner stays on its version and install.sh keeps working with the sha256.
import { compareVersions, signManifest, type UpdateManifest } from "@vanr/engine/runner-update";
import { PRODUCT } from "@vanr/product";
import { RUNNER_VERSION } from "@vanr/runner/config";
import type { AppDeps } from "../context";
import { runnerBundle } from "./install";

export async function latestManifest(deps: AppDeps): Promise<UpdateManifest | null> {
  const signing = deps.config.runnerSigning;
  if (!signing) return null;
  const bundle = await runnerBundle();
  const signed = { version: RUNNER_VERSION, sha256: bundle.sha256, size: bundle.bytes.byteLength };
  return {
    ...signed,
    url: `/runner/${PRODUCT.runnerName}.mjs`,
    signature: signManifest(signed, signing.seed),
  };
}

/** Update hint for `welcome` when the connected runner is older than the one served. */
export async function offeredUpdate(
  deps: AppDeps,
  version: string,
): Promise<{ update?: { version: string } }> {
  if (!deps.config.runnerSigning) return {};
  try {
    return compareVersions(RUNNER_VERSION, version) > 0 ? { update: { version: RUNNER_VERSION } } : {};
  } catch {
    // A version outside the x.y.z format: offers nothing (a runner without the updater gets the protocol rejection).
    return {};
  }
}

// Updater key pair for tests only (the seed is public on purpose). The test server signs with
// RUNNER_SIGNING_KEY = TEST_UPDATE_SEED and the test runner checks with the public key from here.
import { createHash } from "node:crypto";
import { publicKeyFor } from "@vanr/engine/runner-update";

export const TEST_UPDATE_SEED = createHash("sha256").update("vanr-runner-update-test-key").digest("base64");
export const TEST_UPDATE_PUBLIC_KEY = publicKeyFor(TEST_UPDATE_SEED);

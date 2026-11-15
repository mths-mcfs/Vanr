// The product's name in one place: the web app, the server, the runner and the emails read it from here.

export const PRODUCT = {
  name: "Vanr",
  slug: "vanr",
  /** Prefix of the localStorage keys. */
  storagePrefix: "vanr.",
  /** Name of the runner binary and of its config folder on the customer's host. */
  runnerName: "vanr-runner",
  runnerDir: ".vanr-runner",
} as const;

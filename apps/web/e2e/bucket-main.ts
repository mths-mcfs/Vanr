// The child behind the `bucket` fixture: the server's own S3 test double (apps/server/test/fake-s3.ts)
// on a free local port. Playwright runs under Node, and the double is built on Bun.serve, so it runs
// in its own Bun process. It prints its endpoint and bucket as one JSON line, then serves until it is
// killed or its parent goes away (stdin closes).
//
// The double is imported by a computed path: it is the server's code, typed with the server's
// settings, not the web's DOM ones.
type FakeS3 = { endpoint: string; bucket: string; stop(): void };
const source = new URL("../../server/test/fake-s3.ts", import.meta.url).pathname;
const { startFakeS3 } = (await import(source)) as { startFakeS3: (bucket: string) => FakeS3 };

const bucket = startFakeS3("journey-files");
console.log(JSON.stringify({ endpoint: bucket.endpoint, bucket: bucket.bucket }));
const leave = () => {
  bucket.stop();
  process.exit(0);
};
process.on("SIGTERM", leave);
process.stdin.on("end", leave);
process.stdin.on("close", leave);
process.stdin.resume();

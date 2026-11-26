// @vanr/client/testing: an in-memory server, a scriptable socket and a manual clock, for tests and for
// developing against the client before a real server is running.
export { ManualClock } from "../clock.ts";
export { createFakeServer, type FakeServer, type FakeServerOptions, type FakeState } from "./fake-server.ts";
export { FakeSocket, fakeSockets } from "./fake-socket.ts";

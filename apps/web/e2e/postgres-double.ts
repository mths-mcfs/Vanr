// A customer's Postgres on a local port for the journeys: an in-memory PGlite behind the Postgres wire
// protocol, with one table of customers whose email column the server should suggest hiding. Nothing
// leaves the machine; it speaks plain text, which a server outside production accepts.
import { createServer } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

export interface PostgresDouble {
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === "object") resolve(address.port);
        else reject(new Error("no port"));
      });
    });
  });
}

export async function startPostgresDouble(): Promise<PostgresDouble> {
  const db = await PGlite.create();
  await db.exec(`
    create table customers (id serial primary key, name text not null, email text not null);
    insert into customers (name, email) values ('Ada Lindqvist', 'ada@shop.example');
  `);
  const host = "127.0.0.1";
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, host, port, maxConnections: 4 });
  await server.start();
  return {
    host,
    port,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}

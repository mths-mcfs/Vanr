// A customer's Postgres on a local port for the journeys: an in-memory PGlite behind the Postgres wire
// protocol, with one table of customers whose card number column the server should suggest hiding. Nothing
// leaves the machine; it speaks plain text, which a server outside production accepts.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

export interface PostgresDouble {
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

export async function startPostgresDouble(): Promise<PostgresDouble> {
  const db = await PGlite.create();
  try {
    await db.exec(`
      create table customers (id serial primary key, name text not null, card_number text not null);
      insert into customers (name, card_number) values ('Ada Lindqvist', '4000 0000 0000 0002');
    `);
    // Port 0: the socket takes a free port as it binds, so no other worker can take it in between.
    const server = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0, maxConnections: 4 });
    await server.start();
    const [host = "", port = ""] = server.getServerConn().split(":");
    return {
      host,
      port: Number(port),
      async stop() {
        try {
          await server.stop();
        } finally {
          await db.close();
        }
      },
    };
  } catch (error) {
    // Nothing reaches the journey: what was opened is closed here, and the first error is the one thrown.
    await db.close().catch(() => {});
    throw error;
  }
}

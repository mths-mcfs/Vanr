// Single instance: with a real Postgres, only one server per database. The runtime marks every active run
// in the database as failed at boot (runtime.start) and there is no run lease nor pub/sub between processes;
// a second instance would bring down the first one's runs. The session lock holds while its connection lives.
import postgres from "postgres";

/** Fixed key of the instance's `pg_try_advisory_lock` (it holds per database). */
export const INSTANCE_LOCK = 7_310_012;

export class InstanceLocked extends Error {
  constructor() {
    super(
      `A server instance already runs on this database (advisory lock ${INSTANCE_LOCK} is held). ` +
        "The server runs as a single instance: stop the other one before starting this one.",
    );
    this.name = "InstanceLocked";
  }
}

export interface InstanceLock {
  release(): Promise<void>;
}

/**
 * Takes the lock on a connection of its own, with no lifetime nor idle limit (postgres-js recycles
 * connections by default, and recycling would release the lock). Held: `InstanceLocked`. If the connection
 * drops while the server is up, the lock is lost and `onLost` tells.
 */
export async function holdInstanceLock(url: string, onLost: () => void = () => {}): Promise<InstanceLock> {
  let releasing = false;
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
    onnotice: () => {},
    connection: { application_name: "vanr_instance" },
    onclose: () => {
      if (!releasing) onLost();
    },
  });
  let ok = false;
  try {
    const [row] = await sql<{ ok: boolean }[]>`select pg_try_advisory_lock(${INSTANCE_LOCK}) as ok`;
    ok = row?.ok === true;
  } finally {
    if (!ok) {
      releasing = true;
      await sql.end({ timeout: 5 });
    }
  }
  if (!ok) throw new InstanceLocked();
  return {
    async release() {
      if (releasing) return;
      releasing = true;
      // Closing the session releases the lock; the explicit unlock only does it sooner.
      await sql`select pg_advisory_unlock(${INSTANCE_LOCK})`.catch(() => null);
      await sql.end({ timeout: 5 });
    },
  };
}

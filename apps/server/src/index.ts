import { loadConfig } from "./config";
import { log } from "./logger";
import { startServer } from "./server";

if (import.meta.main) {
  const config = loadConfig(process.env);
  const running = await startServer({
    config,
    extraOrigins: config.trustedOrigins,
    onInstanceLockLost: () => {
      log.error("server.instance_lock_lost");
      process.exit(1);
    },
  });
  const shutdown = async () => {
    log.info("server.stopping");
    await running.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Dev-server port fallback.
 *
 * On macOS a server bound to `localhost` (`::1`) does NOT collide with one bound
 * to the unspecified address (`::` / `0.0.0.0`), so two dev servers can silently
 * share a port number without an `EADDRINUSE`. To behave like `next dev` — pick
 * the next free port and tell the user — we probe with a throwaway server bound
 * to the *unspecified* address (the strict check that conflicts with any holder
 * of the port), incrementing until one is free.
 */
import net from "net";

/**
 * Resolve to the first free port at or after `startPort` (probing up to
 * `maxAttempts` higher). Falls back to `startPort` if none is found, so the real
 * `listen()` still surfaces a clear error.
 */
export function findAvailablePort(
  startPort: number,
  maxAttempts = 10,
): Promise<number> {
  return new Promise((resolve) => {
    const attempt = (port: number, tries: number) => {
      const tester = net.createServer();
      tester.once("error", (err: NodeJS.ErrnoException) => {
        tester.close();
        if (err.code === "EADDRINUSE" && tries < maxAttempts) {
          attempt(port + 1, tries + 1);
        } else {
          resolve(startPort);
        }
      });
      tester.once("listening", () => {
        tester.close(() => resolve(port));
      });
      // No host → binds the unspecified address, the strict availability check.
      tester.listen(port);
    };
    attempt(startPort, 0);
  });
}

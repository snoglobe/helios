import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";

interface CallbackResult {
  code: string;
  state: string;
}

interface CallbackServer {
  port: number;
  result: Promise<CallbackResult>;
}

/** Wait for the server to be listening and return the assigned port. */
function getServerPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    // If already listening, address is available immediately
    const addr = server.address();
    if (addr && typeof addr === "object" && addr.port) {
      resolve(addr.port);
      return;
    }
    server.on("listening", () => {
      const a = server.address();
      const port = typeof a === "object" && a ? a.port : 0;
      if (port) resolve(port);
      else reject(new Error("Failed to bind callback server to any port"));
    });
    server.on("error", reject);
  });
}

/**
 * Local HTTP server for OAuth callback.
 * Listens on 127.0.0.1 for the redirect from the OAuth provider.
 */
export async function startCallbackServer(
  expectedState: string,
  path: string,
  port: number,
): Promise<CallbackServer> {
  const app = new Hono();
  let server: Server | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (server) {
      server.close();
      server = null;
    }
  };

  const result = new Promise<CallbackResult>((resolve, reject) => {
    app.get(path, (c) => {
      const code = c.req.query("code");
      const state = c.req.query("state");
      const error = c.req.query("error");
      const errorDescription = c.req.query("error_description");

      if (error) {
        setTimeout(cleanup, 100);
        reject(
          new Error(
            `OAuth error: ${error}${errorDescription ? ` - ${errorDescription}` : ""}`,
          ),
        );
        return c.html(
          "<html><body><h1>Authentication failed</h1><p>You can close this tab.</p></body></html>",
        );
      }

      if (!code || !state) {
        setTimeout(cleanup, 100);
        reject(new Error("Missing code or state in callback"));
        return c.html(
          "<html><body><h1>Authentication failed</h1><p>Missing parameters.</p></body></html>",
        );
      }

      if (state !== expectedState) {
        setTimeout(cleanup, 100);
        reject(new Error("State mismatch — possible CSRF attack"));
        return c.html(
          "<html><body><h1>Authentication failed</h1><p>Invalid state.</p></body></html>",
        );
      }

      setTimeout(cleanup, 100);
      resolve({ code, state });

      return c.html(
        "<html><body><h1>Authenticated!</h1><p>You can close this tab and return to Helios.</p></body></html>",
      );
    });

    // Timeout after 5 minutes
    timeoutTimer = setTimeout(() => {
      cleanup();
      reject(new Error("OAuth callback timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });

  server = serve({
    fetch: app.fetch,
    port,
    hostname: "127.0.0.1",
  }) as unknown as Server;

  const actualPort = await getServerPort(server);

  return { port: actualPort, result };
}

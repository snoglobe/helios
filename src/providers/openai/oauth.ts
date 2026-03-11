import { randomBytes, createHash } from "node:crypto";
import { exec } from "node:child_process";
import type { AuthManager } from "../auth/auth-manager.js";
import { startCallbackServer } from "./callback-server.js";
import { shellQuote } from "../../ui/format.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455; // Must match OpenAI's registered redirect URI
const CALLBACK_PATH = "/auth/callback";

/** Callback for displaying the auth URL — callers set this to route through the TUI. */
export type AuthUrlCallback = (url: string) => void;

/**
 * OpenAI OAuth 2.0 + PKCE flow.
 * Authenticates via ChatGPT Plus/Pro subscription.
 */
export class OpenAIOAuth {
  /** Set by the TUI layer to display the auth URL inline instead of writing to stderr. */
  onAuthUrl: AuthUrlCallback | null = null;

  constructor(private authManager: AuthManager) {}

  async login(): Promise<void> {
    const { verifier, challenge } = generatePKCE();
    const state = randomBytes(32).toString("hex");

    // Start callback server on the registered port (OpenAI only allows localhost:1455)
    const { port, result: codePromise } = await startCallbackServer(state, CALLBACK_PATH, CALLBACK_PORT);
    const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;

    const authUrl = buildAuthUrl(challenge, state, redirectUri);

    // Display the URL — through TUI if available, stderr otherwise
    if (this.onAuthUrl) {
      this.onAuthUrl(authUrl);
    } else {
      process.stderr.write(`\n[helios] OpenAI auth: ${authUrl}\n`);
      process.stderr.write(`[helios] If your browser doesn't open, copy the URL above.\n`);
    }

    // Try to open browser — non-fatal if it fails
    openBrowser(authUrl, this.onAuthUrl);

    // Wait for callback
    const { code } = await codePromise;

    // Exchange code for tokens
    const tokens = await exchangeCode(code, verifier, redirectUri);

    // Store
    await this.authManager.setOAuthTokens(
      "openai",
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresAt,
    );
  }

  async refresh(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }> {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token refresh failed: ${resp.status} ${text}`);
    }

    const data = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

function buildAuthUrl(challenge: string, state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed: ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

function openBrowser(url: string, onAuthUrl: AuthUrlCallback | null): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} ${shellQuote(url)}`, (err) => {
    if (err) {
      const msg = `Could not open browser. Open this URL manually:\n${url}`;
      if (onAuthUrl) {
        onAuthUrl(msg);
      } else {
        process.stderr.write(`[helios] ${msg}\n`);
      }
    }
  });
}

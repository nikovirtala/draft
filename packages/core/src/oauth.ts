import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * OAuth 2.1 with PKCE for Kiro Remote's MCP endpoint, as a native app: Dynamic Client
 * Registration with a loopback redirect, the browser for sign-in, and tokens kept in a
 * `SecretStore` (Electron safeStorage in the desktop app). The MCP SDK's `auth()` runs discovery
 * (RFC 9728, RFC 8414), registration (RFC 7591), the authorization request with S256 PKCE and the
 * code exchange; this provider supplies storage, the browser and the loopback listener.
 *
 * kiro-remote registers `http://127.0.0.1/callback` and matches any port on it (its clients.ts
 * loopbackRedirectMatches), so the redirect URI is registered once and each sign-in listens on an
 * ephemeral port.
 *
 * Nothing here logs a token, a code, a verifier or a state.
 */

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string | null): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string | null): Promise<void> {
    if (value === null) this.values.delete(key);
    else this.values.set(key, value);
  }
}

export const LOOPBACK_REDIRECT = "http://127.0.0.1/callback";

interface Stored {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** When the tokens were saved, to tell when the access token expires. */
  savedAt?: number;
}

export interface KiroOAuthOptions {
  /** The protected resource: the Kiro Remote MCP endpoint. */
  serverUrl: string;
  store: SecretStore;
  /** Opens the authorization URL in the user's browser. */
  openBrowser: (url: string) => Promise<void>;
  /** How long to wait for the user to finish signing in. */
  timeoutMs?: number;
  now?: () => number;
  fetch?: typeof fetch;
}

export class KiroOAuth implements OAuthClientProvider {
  private port: number | null = null;
  private verifier: string | null = null;
  private expectedState: string | null = null;
  private readonly key: string;
  private readonly now: () => number;

  constructor(private readonly o: KiroOAuthOptions) {
    this.key = `kiro-remote-oauth:${new URL(o.serverUrl).origin}`;
    this.now = o.now ?? Date.now;
  }

  get redirectUrl(): string {
    return this.port === null ? LOOPBACK_REDIRECT : `http://127.0.0.1:${this.port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "draft",
      redirect_uris: [LOOPBACK_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    this.expectedState = randomBytes(16).toString("base64url");
    return this.expectedState;
  }

  private async read(): Promise<Stored> {
    const raw = await this.o.store.get(this.key);
    return raw === null ? {} : (JSON.parse(raw) as Stored);
  }

  private async write(s: Stored): Promise<void> {
    await this.o.store.set(this.key, JSON.stringify(s));
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.read()).client;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.write({ ...(await this.read()), client: info });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.read()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.write({ ...(await this.read()), tokens, savedAt: this.now() });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.o.openBrowser(url.toString());
  }

  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }

  codeVerifier(): string {
    if (this.verifier === null) throw new Error("no PKCE code verifier for this sign-in");
    return this.verifier;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const s = await this.read();
    if (scope === "all") await this.o.store.set(this.key, null);
    else if (scope === "client") await this.write({ ...s, client: undefined });
    else if (scope === "tokens") await this.write({ ...s, tokens: undefined, savedAt: undefined });
    else if (scope === "verifier") this.verifier = null;
  }

  /** Whether stored tokens exist and the access token has at least `marginMs` left. */
  async hasFreshToken(marginMs = 60_000): Promise<boolean> {
    const s = await this.read();
    if (s.tokens === undefined) return false;
    if (s.tokens.expires_in === undefined || s.savedAt === undefined) return true;
    return s.savedAt + s.tokens.expires_in * 1000 - marginMs > this.now();
  }

  /**
   * A valid access token: the stored one while it is fresh, else a refreshed one, else a new
   * sign-in in the browser.
   */
  async accessToken(): Promise<string> {
    if (!(await this.hasFreshToken())) await this.authorize();
    const t = await this.tokens();
    if (t === undefined) throw new Error("Kiro Remote sign-in did not produce a token");
    return t.access_token;
  }

  /** Runs `auth()`: a refresh when possible, otherwise the browser sign-in with a loopback redirect. */
  async authorize(): Promise<void> {
    const listener = await startLoopback();
    this.port = listener.port;
    try {
      const fetchFn = this.o.fetch;
      const first = await auth(this, {
        serverUrl: this.o.serverUrl,
        ...(fetchFn ? { fetchFn } : {}),
      });
      if (first === "AUTHORIZED") return;
      const { code, state } = await listener.next(this.o.timeoutMs ?? 5 * 60_000);
      if (this.expectedState === null || state !== this.expectedState) {
        throw new Error("Kiro Remote sign-in returned an unexpected state");
      }
      const second = await auth(this, {
        serverUrl: this.o.serverUrl,
        authorizationCode: code,
        ...(fetchFn ? { fetchFn } : {}),
      });
      if (second !== "AUTHORIZED") throw new Error("Kiro Remote sign-in did not complete");
    } finally {
      this.port = null;
      this.verifier = null;
      this.expectedState = null;
      listener.close();
    }
  }
}

/** A one-shot loopback listener on 127.0.0.1 and an ephemeral port. */
async function startLoopback(): Promise<{
  port: number;
  next(timeoutMs: number): Promise<{ code: string; state: string | null }>;
  close(): void;
}> {
  // The browser may come back before anyone waits (a fast or scripted sign-in), so the first
  // outcome is kept until `next` asks for it.
  type Outcome =
    | { ok: true; value: { code: string; state: string | null } }
    | { ok: false; error: Error };
  let outcome: Outcome | null = null;
  let settle: ((o: Outcome) => void) | null = null;
  const done = (o: Outcome) => {
    if (outcome !== null) return;
    outcome = o;
    settle?.(o);
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      code === null
        ? "<p>Sign-in failed. You can close this tab and try again from draft.</p>"
        : "<p>Signed in to Kiro Remote. You can close this tab and return to draft.</p>",
    );
    if (code !== null) done({ ok: true, value: { code, state: url.searchParams.get("state") } });
    else done({ ok: false, error: new Error(`Kiro Remote sign-in failed: ${error ?? "no code"}`) });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    next(timeoutMs) {
      return new Promise((resolve, reject) => {
        const finish = (o: Outcome) => (o.ok ? resolve(o.value) : reject(o.error));
        if (outcome !== null) return finish(outcome);
        const t = setTimeout(() => reject(new Error("Kiro Remote sign-in timed out")), timeoutMs);
        settle = (o) => {
          clearTimeout(t);
          finish(o);
        };
      });
    },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}

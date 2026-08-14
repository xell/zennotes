import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { CloudAuthDeepLinkRequest } from "./deep-links";

const LOOPBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/auth/callback";
const COMPLETE_PATH = "/auth/complete";
const FAILED_PATH = "/auth/failed";
const CALLBACK_LIFETIME_MS = 5 * 60 * 1000;

type CloudAuthCallback = (request: CloudAuthDeepLinkRequest) => Promise<void>;

export class CloudAuthLoopbackServer {
  private server: Server | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private callbackUrl: string | null = null;
  private callbackConsumed = false;
  private completion: "success" | "failure" | null = null;

  async start(onCallback: CloudAuthCallback): Promise<string> {
    await this.stop();

    const server = createServer((request, response) => {
      void this.handleRequest(
        request.method ?? "",
        request.url ?? "",
        request.headers.host ?? "",
        response,
        onCallback,
      );
    });
    this.server = server;
    this.callbackConsumed = false;
    this.completion = null;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(0, LOOPBACK_HOST, () => {
        server.off("error", onError);
        resolve();
      });
    });

    const address = server.address() as AddressInfo;
    this.callbackUrl = `http://${LOOPBACK_HOST}:${address.port}${CALLBACK_PATH}`;
    server.unref();

    this.expiryTimer = setTimeout(() => {
      void this.stop();
    }, CALLBACK_LIFETIME_MS);
    this.expiryTimer.unref();

    return this.callbackUrl;
  }

  async stop(): Promise<void> {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }

    const server = this.server;
    this.server = null;
    this.callbackUrl = null;
    this.completion = null;
    if (!server?.listening) return;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  }

  private async handleRequest(
    method: string,
    requestUrl: string,
    host: string,
    response: ServerResponse,
    onCallback: CloudAuthCallback,
  ): Promise<void> {
    const callbackUrl = this.callbackUrl;
    if (!callbackUrl) {
      this.respond(response, 410, "This ZenNotes sign-in request has expired.");
      return;
    }

    if (method !== "GET") {
      response.setHeader("Allow", "GET");
      this.respond(response, 405, "Only GET is allowed.");
      return;
    }

    const expectedUrl = new URL(callbackUrl);
    if (host !== expectedUrl.host || !requestUrl.startsWith("/")) {
      this.respond(response, 400, "Invalid ZenNotes callback.");
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(requestUrl, callbackUrl);
    } catch {
      this.respond(response, 400, "Invalid ZenNotes callback.");
      return;
    }

    if (parsed.origin !== expectedUrl.origin) {
      this.respond(response, 404, "ZenNotes callback not found.");
      return;
    }

    const completion = this.completion;
    const completionPath =
      completion === "success"
        ? COMPLETE_PATH
        : completion === "failure"
          ? FAILED_PATH
          : null;
    if (
      completionPath &&
      completion !== null &&
      parsed.pathname === completionPath &&
      parsed.search === ""
    ) {
      void this.stop();
      this.respond(
        response,
        completion === "success" ? 200 : 400,
        completionPage(completion),
        "text/html; charset=utf-8",
      );
      return;
    }

    if (parsed.pathname !== CALLBACK_PATH) {
      this.respond(response, 404, "ZenNotes callback not found.");
      return;
    }

    const codeValues = parsed.searchParams.getAll("code");
    const stateValues = parsed.searchParams.getAll("state");
    const parameterNames = [...parsed.searchParams.keys()];
    const code = codeValues[0] ?? "";
    const state = stateValues[0] ?? "";
    if (
      parameterNames.length !== 2 ||
      codeValues.length !== 1 ||
      stateValues.length !== 1 ||
      !/^[A-Za-z0-9]+$/.test(code) ||
      code.length > 256 ||
      !/^[A-Za-z0-9._-]+$/.test(state) ||
      state.length > 128
    ) {
      this.respond(response, 400, "Invalid ZenNotes callback.");
      return;
    }

    if (this.callbackConsumed) {
      this.respond(
        response,
        410,
        "This ZenNotes sign-in request was already used.",
      );
      return;
    }
    this.callbackConsumed = true;

    try {
      await onCallback({ code, state });
      this.completion = "success";
      this.redirect(response, COMPLETE_PATH);
    } catch {
      this.completion = "failure";
      this.redirect(response, FAILED_PATH);
    }
  }

  private redirect(response: ServerResponse, pathname: string): void {
    response.writeHead(303, {
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; base-uri 'none'; form-action 'none'",
      Location: pathname,
      "X-Content-Type-Options": "nosniff",
    });
    response.end();
  }

  private respond(
    response: ServerResponse,
    status: number,
    body: string,
    contentType = "text/plain; charset=utf-8",
  ): void {
    const contentSecurityPolicy = contentType.startsWith("text/html")
      ? "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
      : "default-src 'none'; base-uri 'none'; form-action 'none'";
    response.writeHead(status, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": contentSecurityPolicy,
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  }
}

function completionPage(completion: "success" | "failure"): string {
  const succeeded = completion === "success";
  const title = succeeded
    ? "ZenNotes is connected"
    : "ZenNotes could not complete sign-in";
  const description = succeeded
    ? "Your account is ready on this device."
    : "Return to ZenNotes and start the connection again.";
  const status = succeeded ? "Connected" : "Sign-in failed";
  const symbol = succeeded ? "✓" : "!";
  const markColor = succeeded ? "#d9763f" : "#a8463a";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: #f5f0e6; color: #28241f; }
    main { width: min(100%, 520px); border: 1px solid rgba(80, 67, 52, .18); border-radius: 24px; padding: 40px; background: rgba(255, 252, 246, .82); box-shadow: 0 24px 70px rgba(63, 48, 34, .10); }
    .mark { width: 48px; height: 48px; display: grid; place-items: center; border-radius: 14px; background: ${markColor}; color: white; font-size: 24px; font-weight: 700; }
    .eyebrow { margin: 28px 0 10px; color: #9a6a45; font-size: 12px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; }
    h1 { margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: clamp(34px, 7vw, 48px); line-height: 1.05; letter-spacing: -.025em; }
    .description { margin: 18px 0 0; color: #756b60; font-size: 17px; line-height: 1.6; }
    .hint { margin-top: 32px; padding-top: 22px; border-top: 1px solid rgba(80, 67, 52, .14); color: #8b8175; font-size: 14px; line-height: 1.5; }
    @media (prefers-color-scheme: dark) {
      body { background: #121313; color: #ead8b4; }
      main { border-color: rgba(214, 188, 145, .16); background: #1d1f1f; box-shadow: 0 28px 80px rgba(0, 0, 0, .32); }
      .eyebrow { color: #d9874b; }
      .description { color: #aa9b88; }
      .hint { border-color: rgba(214, 188, 145, .14); color: #8d8274; }
    }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">${symbol}</div>
    <p class="eyebrow">${status}</p>
    <h1>${title}</h1>
    <p class="description">${description}</p>
    <p class="hint">You can close this tab and return to the app.</p>
  </main>
</body>
</html>`;
}

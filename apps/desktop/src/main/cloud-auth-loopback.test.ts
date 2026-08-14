import { describe, expect, it, vi } from "vitest";
import { CloudAuthLoopbackServer } from "./cloud-auth-loopback";

describe("CloudAuthLoopbackServer", () => {
  it("receives one valid callback on an ephemeral IPv4 loopback port", async () => {
    const server = new CloudAuthLoopbackServer();
    const onCallback = vi.fn(async () => {});
    const callbackUrl = await server.start(onCallback);

    expect(callbackUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/auth\/callback$/,
    );

    const response = await fetch(
      `${callbackUrl}?code=OneTimeCode123&state=fixed-state`,
    );

    expect(response.status).toBe(200);
    expect(response.url).toBe(callbackUrl.replace("/callback", "/complete"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "style-src 'unsafe-inline'",
    );
    expect(await response.text()).toContain("ZenNotes is connected");
    expect(onCallback).toHaveBeenCalledOnce();
    expect(onCallback).toHaveBeenCalledWith({
      code: "OneTimeCode123",
      state: "fixed-state",
    });

    await expect(fetch(callbackUrl)).rejects.toThrow();
  });

  it("rejects malformed requests without consuming the callback", async () => {
    const server = new CloudAuthLoopbackServer();
    const onCallback = vi.fn(async () => {});
    const callbackUrl = await server.start(onCallback);

    expect((await fetch(`${callbackUrl}/wrong`)).status).toBe(404);
    expect(
      (await fetch(`${callbackUrl}?code=first&code=second&state=fixed-state`))
        .status,
    ).toBe(400);
    expect(
      (await fetch(`${callbackUrl}?code=valid&state=has%20spaces`)).status,
    ).toBe(400);
    expect(
      (
        await fetch(callbackUrl, {
          method: "POST",
        })
      ).status,
    ).toBe(405);
    expect(onCallback).not.toHaveBeenCalled();

    const validResponse = await fetch(
      `${callbackUrl}?code=OneTimeCode123&state=fixed-state`,
    );
    expect(validResponse.status).toBe(200);
    expect(onCallback).toHaveBeenCalledOnce();
  });

  it("can be stopped repeatedly", async () => {
    const server = new CloudAuthLoopbackServer();
    const callbackUrl = await server.start(async () => {});

    await server.stop();
    await server.stop();

    await expect(fetch(callbackUrl)).rejects.toThrow();
  });

  it("shows a clean failure page when token exchange fails", async () => {
    const server = new CloudAuthLoopbackServer();
    const callbackUrl = await server.start(async () => {
      throw new Error("exchange rejected");
    });

    const response = await fetch(
      `${callbackUrl}?code=OneTimeCode123&state=fixed-state`,
    );

    expect(response.status).toBe(400);
    expect(response.url).toBe(callbackUrl.replace("/callback", "/failed"));
    expect(await response.text()).toContain(
      "ZenNotes could not complete sign-in",
    );
  });
});

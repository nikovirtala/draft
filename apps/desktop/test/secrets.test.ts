import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for Electron's safeStorage: "encryption" is a reversible prefix, enough to check
// that only the asynchronous API is used and that what it writes reads back.
const state = { available: true, reEncrypt: false, syncCalls: 0 };
vi.mock("electron", () => {
  const sync = () => {
    state.syncCalls += 1;
    throw new Error("the synchronous safeStorage API is deprecated");
  };
  return {
    safeStorage: {
      isEncryptionAvailable: sync,
      encryptString: sync,
      decryptString: sync,
      isAsyncEncryptionAvailable: async () => state.available,
      encryptStringAsync: async (text: string) => Buffer.from(`enc:${text}`),
      decryptStringAsync: async (data: Buffer) => {
        const text = data.toString();
        if (!text.startsWith("enc:")) throw new Error("not ours");
        return { result: text.slice(4), shouldReEncrypt: state.reEncrypt };
      },
    },
  };
});

const { SafeStorageSecretStore } = await import("../src/main/secrets.ts");

describe("SafeStorageSecretStore", () => {
  let path: string;
  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), "draft-secrets-")), "secrets.bin");
    Object.assign(state, { available: true, reEncrypt: false, syncCalls: 0 });
  });

  it("stores and reads back a secret with the asynchronous API only", async () => {
    await new SafeStorageSecretStore(path).set("token", "abc");
    expect(readFileSync(path, "utf8")).toBe('enc:{"token":"abc"}');
    expect(await new SafeStorageSecretStore(path).get("token")).toBe("abc");
    expect(state.syncCalls).toBe(0);
  });

  it("reads a file the synchronous API wrote, and re-encrypts when told to", async () => {
    writeFileSync(path, 'enc:{"token":"old"}');
    state.reEncrypt = true;
    const store = new SafeStorageSecretStore(path);
    expect(await store.get("token")).toBe("old");
    expect(readFileSync(path, "utf8")).toBe('enc:{"token":"old"}');
  });

  it("keeps the last of two quick writes", async () => {
    const store = new SafeStorageSecretStore(path);
    await Promise.all([store.set("a", "1"), store.set("b", "2")]);
    expect(JSON.parse(readFileSync(path, "utf8").slice(4))).toEqual({ a: "1", b: "2" });
  });

  it("writes nothing without encryption, keeping secrets for this run", async () => {
    state.available = false;
    const store = new SafeStorageSecretStore(path);
    await store.set("token", "abc");
    expect(existsSync(path)).toBe(false);
    expect(await store.get("token")).toBe("abc");
  });

  it("starts empty when the file can't be decrypted", async () => {
    writeFileSync(path, "garbage");
    expect(await new SafeStorageSecretStore(path).get("token")).toBeNull();
  });
});

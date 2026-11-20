import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SecretStore } from "@nikovirtala/draft-core";
import { safeStorage } from "electron";

/**
 * Secrets (Kiro Remote OAuth tokens) encrypted with Electron safeStorage: the OS keychain on
 * macOS, DPAPI on Windows, and the secret service on Linux. The file holds only ciphertext. If
 * encryption isn't available (a Linux desktop without a keyring), nothing is written to disk and
 * secrets last for this run only.
 */
export class SafeStorageSecretStore implements SecretStore {
  private cache: Record<string, string> | null = null;

  constructor(private readonly path: string) {}

  private load(): Record<string, string> {
    if (this.cache !== null) return this.cache;
    this.cache = {};
    if (safeStorage.isEncryptionAvailable() && existsSync(this.path)) {
      try {
        this.cache = JSON.parse(safeStorage.decryptString(readFileSync(this.path))) as Record<
          string,
          string
        >;
      } catch {
        this.cache = {};
      }
    }
    return this.cache;
  }

  async get(key: string): Promise<string | null> {
    return this.load()[key] ?? null;
  }

  async set(key: string, value: string | null): Promise<void> {
    const all = this.load();
    if (value === null) delete all[key];
    else all[key] = value;
    if (!safeStorage.isEncryptionAvailable()) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(all)), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

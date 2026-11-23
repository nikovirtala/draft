import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SecretStore } from "@nikovirtala/draft-core";
import { safeStorage } from "electron";

/**
 * Secrets (Kiro Remote OAuth tokens) encrypted with Electron safeStorage: the OS keychain on
 * macOS, DPAPI on Windows, and the secret service on Linux. The file holds only ciphertext. If
 * encryption isn't available (a Linux desktop without a keyring), nothing is written to disk and
 * secrets last for this run only.
 *
 * It uses safeStorage's asynchronous API, which replaces the synchronous one Electron
 * deprecated. A file the synchronous API wrote decrypts with it, and when safeStorage says the
 * key has changed (`shouldReEncrypt`), the secrets are written again with the current key.
 */
export class SafeStorageSecretStore implements SecretStore {
  private cache: Promise<Record<string, string>> | null = null;
  /** Writes run one after another, so two quick `set`s can't leave the older one on disk. */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private load(): Promise<Record<string, string>> {
    this.cache ??= this.read();
    return this.cache;
  }

  private async read(): Promise<Record<string, string>> {
    if (!existsSync(this.path) || !(await safeStorage.isAsyncEncryptionAvailable())) return {};
    try {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
        await readFile(this.path),
      );
      const all = JSON.parse(result) as Record<string, string>;
      if (shouldReEncrypt) await this.write(all);
      return all;
    } catch {
      return {};
    }
  }

  private write(all: Record<string, string>): Promise<void> {
    const text = JSON.stringify(all);
    this.writing = this.writing.then(async () => {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return;
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, await safeStorage.encryptStringAsync(text), { mode: 0o600 });
      await rename(tmp, this.path);
    });
    return this.writing;
  }

  async get(key: string): Promise<string | null> {
    return (await this.load())[key] ?? null;
  }

  async set(key: string, value: string | null): Promise<void> {
    const all = await this.load();
    if (value === null) delete all[key];
    else all[key] = value;
    await this.write(all);
  }
}

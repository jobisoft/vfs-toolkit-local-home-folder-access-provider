/**
 * background.js - Native-messaging VFS provider for vfs-toolkit
 *
 * Relays all file/folder operations to a local native app via Mozilla's
 * native messaging. The native app maps VFS paths onto the real file
 * system, defaulting to the user's home directory as the root.
 *
 * Protocol (both directions use 4-byte LE length prefix + UTF-8 JSON):
 *   Request  → { requestId, cmd, ...args }
 *   Response ← { requestId, ok: true,  partial: bool, result }
 *            | { requestId, ok: false, error, errorCode? }
 *
 * Large files are transferred in chunks to stay under Mozilla's 1 MB
 * native-messaging limit (~700 KB of binary data per message):
 *
 *   Read  – the native app sends N messages with partial:true followed by a
 *            final message with partial:false.  The JS side accumulates and
 *            reassembles them before resolving the promise.
 *
 *   Write – the JS side splits large blobs and sends them as sequential
 *            writeFile messages sharing an uploadId.  All but the last carry
 *            more:true so the native app knows to buffer them.
 */

import { VfsProviderImplementation } from './vendor/vfs-provider.mjs';

const NATIVE_APP = 'expose_home_folder_host';
const CONNECTIONS_KEY = 'vfs-toolkit-connections';

/** Raw binary bytes per native-messaging message (700 KB → ~933 KB base64). */
const CHUNK_SIZE = 700 * 1024;

// ── Binary / base64 helpers ────────────────────────────────────────────────────

/** Encode a Uint8Array as a base64 string without O(n²) string concatenation. */
function bytesToBase64(bytes) {
  let binary = '';
  const BLOCK = 8192;
  for (let i = 0; i < bytes.byteLength; i += BLOCK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BLOCK));
  }
  return btoa(binary);
}

/** Decode a base64 string into a Uint8Array. */
function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ── Provider implementation ────────────────────────────────────────────────────

class NativeFsVfsProvider extends VfsProviderImplementation {
  /** Active native messaging port, or null if disconnected. */
  #port = null;

  /**
   * Pending requests: requestId → { resolve, reject, chunks: null | Array }
   *
   * chunks is null for commands that always produce a single response.
   * For readFile it is initialised to [] on the first partial message and
   * accumulates { content, name?, type?, lastModified? } objects until the
   * final (partial:false) message arrives.
   */
  #pending = new Map();

  // ── Native messaging ─────────────────────────────────────────────────────────

  #connect() {
    this.#port = browser.runtime.connectNative(NATIVE_APP);

    this.#port.onMessage.addListener(msg => {
      const pending = this.#pending.get(msg.requestId);
      if (!pending) return;

      if (!msg.ok) {
        this.#pending.delete(msg.requestId);
        pending.reject(Object.assign(new Error(msg.error), { code: msg.errorCode }));
        return;
      }

      if (msg.partial) {
        // Accumulate chunk; keep the pending entry alive.
        if (!pending.chunks) pending.chunks = [];
        pending.chunks.push(msg.result);
        return;
      }

      // Final (or only) response.
      this.#pending.delete(msg.requestId);
      if (pending.chunks) {
        // Caller receives all chunks + final result bundled together.
        pending.resolve({ _chunks: [...pending.chunks, msg.result] });
      } else {
        pending.resolve(msg.result);
      }
    });

    this.#port.onDisconnect.addListener(port => {
      this.#port = null;
      const reason = port.error?.message ?? 'disconnected';
      for (const [, { reject }] of this.#pending) {
        reject(new Error(`Native app ${reason}`));
      }
      this.#pending.clear();
      setTimeout(() => this.#connect(), 2000);
    });
  }

  /** Send one message to the native app; returns a Promise for its response. */
  #send(requestId, cmd, args = {}) {
    return new Promise((resolve, reject) => {
      if (!this.#port) {
        reject(Object.assign(new Error('Native app not connected'), {
          code: 'E:PROVIDER',
          details: {
            id: 'native-app-not-connected',
            title: browser.i18n.getMessage('errorNativeNotConnectedTitle'),
            description: browser.i18n.getMessage('errorNativeNotConnectedDesc', [browser.i18n.getMessage('extensionName')]),
          },
        }));
        return;
      }
      this.#pending.set(requestId, { resolve, reject, chunks: null });
      this.#port.postMessage({ requestId, cmd, ...args });
    });
  }

  // ── Auth helper ──────────────────────────────────────────────────────────────

  async #assertAuth(storageId) {
    const rv = await browser.storage.local.get({ [CONNECTIONS_KEY]: [] });
    const known = rv[CONNECTIONS_KEY].some(c => c.storageId === storageId);
    if (!known) throw Object.assign(new Error('Unauthorized storageId'), { code: 'E:AUTH' });
  }

  // ── VFS provider handlers ────────────────────────────────────────────────────

  async onCancel(canceledRequestId) {
    const pending = this.#pending.get(canceledRequestId);
    if (pending) {
      this.#pending.delete(canceledRequestId);
      pending.reject(new Error('Cancelled'));
    }
  }

  async onStorageUsage(storageId) {
    await this.#assertAuth(storageId);
    return this.#send(`storageUsage-${crypto.randomUUID()}`, 'storageUsage');
  }

  async onList(requestId, storageId, path) {
    await this.#assertAuth(storageId);
    const rv = await browser.storage.local.get({ 'vfs-toolkit-local-show-hidden': false });
    return this.#send(requestId, 'list', { path, showHidden: rv['vfs-toolkit-local-show-hidden'] });
  }

  async onReadFile(requestId, storageId, path) {
    await this.#assertAuth(storageId);
    const result = await this.#send(requestId, 'readFile', { path });

    let name, type, lastModified, bytes;

    if (result._chunks) {
      // Reassemble chunked response.
      const first = result._chunks[0];
      name = first.name;
      type = first.type;
      lastModified = first.lastModified;

      const parts = result._chunks.map(c => base64ToBytes(c.content));
      const totalLen = parts.reduce((sum, p) => sum + p.byteLength, 0);
      bytes = new Uint8Array(totalLen);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
    } else {
      name = result.name;
      type = result.type;
      lastModified = result.lastModified;
      bytes = base64ToBytes(result.content);
    }

    return new File([bytes], name, { type, lastModified });
  }

  async onWriteFile(requestId, storageId, path, file, overwrite) {
    await this.#assertAuth(storageId);
    const blob = file instanceof Blob ? file : new Blob([], { type: 'application/octet-stream' });
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (bytes.byteLength <= CHUNK_SIZE) {
      // Small file: single message, no chunking.
      await this.#send(requestId, 'writeFile', {
        path, overwrite, content: bytesToBase64(bytes),
      });
      return;
    }

    // Large file: split into sequential chunks sharing an uploadId.
    const uploadId = requestId;
    for (let offset = 0, idx = 0; offset < bytes.byteLength; offset += CHUNK_SIZE, idx++) {
      const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
      const more = offset + CHUNK_SIZE < bytes.byteLength;
      const chunkRequestId = idx === 0 ? requestId : `${requestId}_c${idx}`;
      // await each chunk so we don't flood the native app's stdin buffer.
      await this.#send(chunkRequestId, 'writeFile', {
        path, overwrite, uploadId, more, content: bytesToBase64(chunk),
      });
    }
  }

  async onAddFolder(requestId, storageId, path) {
    await this.#assertAuth(storageId);
    await this.#send(requestId, 'addFolder', { path });
  }

  async onMoveFile(requestId, storageId, oldPath, newPath, overwrite) {
    await this.#assertAuth(storageId);
    await this.#send(requestId, 'moveFile', { oldPath, newPath, overwrite });
  }

  async onMoveFolder(requestId, storageId, oldPath, newPath, merge) {
    await this.#assertAuth(storageId);
    await this.#send(requestId, 'moveFolder', { oldPath, newPath, merge });
  }

  async onCopyFile(requestId, storageId, oldPath, newPath, overwrite) {
    await this.#assertAuth(storageId);
    await this.#send(requestId, 'copyFile', { oldPath, newPath, overwrite });
  }

  async onCopyFolder(requestId, storageId, oldPath, newPath, merge) {
    await this.#assertAuth(storageId);
    await this.#send(requestId, 'copyFolder', { oldPath, newPath, merge });
  }

  async onDeleteFile(requestId, storageId, path) {
    await this.#assertAuth(storageId);
    await this.#send(requestId, 'deleteFile', { path });
  }

  async onDeleteFolder(requestId, storageId, path) {
    await this.#assertAuth(storageId);
    await this.#send(requestId, 'deleteFolder', { path });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  init() {
    this.#connect();
    super.init();
  }
}

// ── Start ──────────────────────────────────────────────────────────────────────

const provider = new NativeFsVfsProvider({
  name: browser.i18n.getMessage('providerName'),
  setupPath: '/setup/setup.html',
  setupWidth: 520,
  setupHeight: 500,
  configPath: '/config/config.html',
  configWidth: 520,
  configHeight: 400,
});

provider.init();

browser.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') browser.runtime.openOptionsPage();
});

// When the "show hidden files" config changes, tell all open pickers to refresh.
browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !('vfs-toolkit-local-show-hidden' in changes)) return;
  const rv = await browser.storage.local.get({ [CONNECTIONS_KEY]: [] });
  for (const conn of rv[CONNECTIONS_KEY]) {
    provider.reportStorageChange(conn.storageId, ['/']);
  }
});

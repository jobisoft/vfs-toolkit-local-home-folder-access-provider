import { localizeDocument } from '../vendor/i18n.mjs';

localizeDocument();

const VFS_TOOLKIT_LINK = "https://github.com/thunderbird/webext-support/tree/master/modules/vfs-toolkit";

// Set P1 via innerHTML to preserve the <strong> substitutions from the locale
document.getElementById('intro-p1').innerHTML = browser.i18n.getMessage('optionsIntroP1', [
  browser.i18n.getMessage('termVFS'),
  browser.i18n.getMessage('termNativeMessaging'),
  VFS_TOOLKIT_LINK,
]);

const CONNECTIONS_KEY = 'vfs-toolkit-connections';
const NATIVE_APP = 'expose_home_folder_host';

// ── Dynamic ZIP builder ────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (const b of data) crc = CRC_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries) {
  // entries: Array of { name: string, data: Uint8Array }
  const enc = new TextEncoder();
  const u16 = (v, dv, o) => dv.setUint16(o, v, true);
  const u32 = (v, dv, o) => dv.setUint32(o, v, true);

  const localParts = [];
  const centralParts = [];
  let dataOffset = 0;

  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);

    // Local file header (30 bytes + filename)
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    u32(0x04034b50, lv, 0);       // signature
    u16(20, lv, 4);       // version needed
    u16(0, lv, 6);       // flags
    u16(0, lv, 8);       // compression: STORE
    u16(0, lv, 10);      // mod time
    u16(0, lv, 12);      // mod date
    u32(crc, lv, 14);      // CRC-32
    u32(data.length, lv, 18);     // compressed size
    u32(data.length, lv, 22);     // uncompressed size
    u16(nameBytes.length, lv, 26); // filename length
    u16(0, lv, 28);      // extra field length
    local.set(nameBytes, 30);

    localParts.push(local, data);

    // Central directory entry (46 bytes + filename)
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    u32(0x02014b50, cv, 0);       // signature
    u16(20, cv, 4);       // version made by
    u16(20, cv, 6);       // version needed
    u16(0, cv, 8);       // flags
    u16(0, cv, 10);      // compression: STORE
    u16(0, cv, 12);      // mod time
    u16(0, cv, 14);      // mod date
    u32(crc, cv, 16);      // CRC-32
    u32(data.length, cv, 20);     // compressed size
    u32(data.length, cv, 24);     // uncompressed size
    u16(nameBytes.length, cv, 28); // filename length
    u16(0, cv, 30);      // extra field length
    u16(0, cv, 32);      // file comment length
    u16(0, cv, 34);      // disk number start
    u16(0, cv, 36);      // internal attributes
    u32(0, cv, 38);      // external attributes
    u32(dataOffset, cv, 42);      // local header offset
    cd.set(nameBytes, 46);

    centralParts.push(cd);
    dataOffset += local.length + data.length;
  }

  // End of central directory record
  const cdSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  u32(0x06054b50, ev, 0);   // signature
  u16(0, ev, 4);   // disk number
  u16(0, ev, 6);   // disk with start of CD
  u16(entries.length, ev, 8);   // entries on this disk
  u16(entries.length, ev, 10);  // total entries
  u32(cdSize, ev, 12);  // central directory size
  u32(dataOffset, ev, 16);  // central directory offset
  u16(0, ev, 20);  // comment length

  return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
}

async function downloadNativeApp() {
  const files = [
    'native-messaging-app/expose_home_folder_host.py',
    'native-messaging-app/expose_home_folder_host.json',
    'native-messaging-app/install.sh',
    'native-messaging-app/uninstall.sh',
    'native-messaging-app/install.bat',
    'native-messaging-app/uninstall.bat',
  ];

  const entries = await Promise.all(files.map(async path => {
    const resp = await fetch(browser.runtime.getURL(path));
    const data = new Uint8Array(await resp.arrayBuffer());
    return { name: path.replace('native-messaging-app/', ''), data };
  }));

  const blob = buildZip(entries);
  const url = URL.createObjectURL(blob);
  await browser.downloads.download({
    url,
    filename: 'native-home-folder-file-system-access-app.zip',
    saveAs: true,
  });
  URL.revokeObjectURL(url);
}

document.getElementById('download-link').addEventListener('click', e => {
  e.preventDefault();
  downloadNativeApp();
});

// ── Native messaging health check ──────────────────────────────────────────────

function checkNativeConnection() {
  return new Promise(resolve => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };

    let port;
    try {
      port = browser.runtime.connectNative(NATIVE_APP);
    } catch {
      done(false);
      return;
    }

    const timeout = setTimeout(() => {
      port.disconnect();
      done(false);
    }, 5000);

    port.onMessage.addListener(() => {
      clearTimeout(timeout);
      port.disconnect();
      done(true);
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timeout);
      done(false);
    });

    port.postMessage({ requestId: 'options-health-check', cmd: 'storageUsage' });
  });
}

async function runConnectionCheck() {
  const banner = document.getElementById('banner');
  const spinner = document.getElementById('banner-spinner');
  const iconOk = document.getElementById('banner-icon-ok');
  const iconErr = document.getElementById('banner-icon-err');
  const title = document.getElementById('banner-title');
  const detail = document.getElementById('banner-detail');
  const introSection = document.getElementById('intro-section');

  const ok = await checkNativeConnection();
  spinner.style.display = 'none';

  if (ok) {
    banner.className = 'banner banner-ok';
    iconOk.style.display = '';
    title.textContent = browser.i18n.getMessage('bannerOkTitle');
    detail.textContent = browser.i18n.getMessage('bannerOkDetail');
    introSection.style.display = 'none';
  } else {
    banner.className = 'banner banner-error';
    iconErr.style.display = '';
    title.textContent = browser.i18n.getMessage('bannerErrorTitle');
    detail.textContent = browser.i18n.getMessage('bannerErrorDetail');
    introSection.style.display = '';
  }
}

// ── Connections table ──────────────────────────────────────────────────────────

async function loadConnections() {
  const rv = await browser.storage.local.get({ [CONNECTIONS_KEY]: [] });
  return rv[CONNECTIONS_KEY];
}

function accessBadge(capabilities) {
  const canWrite = capabilities?.file?.add === true;
  return canWrite
    ? `<span class="badge badge-write">&#10003; ${browser.i18n.getMessage('accessReadWrite')}</span>`
    : `<span class="badge badge-read">&#128274; ${browser.i18n.getMessage('accessReadOnly')}</span>`;
}

async function render() {
  const connections = await loadConnections();
  const tbody = document.getElementById('connections-body');
  const empty = document.getElementById('empty-state');

  tbody.innerHTML = '';

  if (!connections.length) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  for (const conn of connections) {
    const tr = document.createElement('tr');
    const displayName = conn.addonName ?? conn.addonId ?? '—';

    tr.innerHTML = `
      <td>${escHtml(displayName)}</td>
      <td>${accessBadge(conn.capabilities)}</td>
      <td><button class="revoke-btn" data-addon-id="${escHtml(conn.addonId)}" data-storage-id="${escHtml(conn.storageId)}">${browser.i18n.getMessage('btnRevoke')}</button></td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.revoke-btn').forEach(btn => {
    btn.addEventListener('click', () => revokeAccess(btn.dataset.addonId, btn.dataset.storageId));
  });
}

async function revokeAccess(addonId, storageId) {
  const rv = await browser.storage.local.get({ [CONNECTIONS_KEY]: [] });
  const updated = rv[CONNECTIONS_KEY].filter(
    c => !(c.addonId === addonId && c.storageId === storageId)
  );
  await browser.storage.local.set({ [CONNECTIONS_KEY]: updated });

  browser.runtime.sendMessage(addonId, {
    type: 'vfs-toolkit-remove-connection',
    storageId,
  }).catch(() => { /* add-on may not be listening */ });

  render();
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

runConnectionCheck();
render();

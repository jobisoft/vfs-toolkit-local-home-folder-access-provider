import * as vfs from '../vendor/vfs-provider.mjs';
import { localizeDocument } from '../vendor/i18n.mjs';

localizeDocument();

const CONNECTIONS_KEY = 'vfs-toolkit-connections';

const params = new URLSearchParams(location.search);
const addonId = params.get('addonId');
const addonName = params.get('addonName');

const readonlyCapabilities = {
  file: { read: true, add: false, modify: false, delete: false },
  folder: { read: true, add: false, modify: false, delete: false },
};

const readwriteCapabilities = {
  file: { read: true, add: true, modify: true, delete: true },
  folder: { read: true, add: true, modify: true, delete: true },
};

// Update the permission question to include the add-on name
const displayName = addonName ?? addonId ?? 'this add-on';
document.getElementById('msg').textContent =
  browser.i18n.getMessage('setupQuestion', [displayName]);

// Highlight selected radio option
for (const option of document.querySelectorAll('.access-option')) {
  option.addEventListener('click', () => {
    const radio = option.querySelector('input[type="radio"]');
    radio.checked = true;
    document.querySelectorAll('.access-option').forEach(o => o.classList.remove('selected'));
    option.classList.add('selected');
    document.getElementById('grant-btn').disabled = false;
  });
}

document.getElementById('cancel-btn').addEventListener('click', () => window.close());

const rv = await browser.storage.local.get({ [CONNECTIONS_KEY]: [] });
const alreadyConnected = rv[CONNECTIONS_KEY].some(c => c.addonId === addonId);

if (alreadyConnected) {
  document.getElementById('msg').textContent =
    browser.i18n.getMessage('setupAlreadyGranted', [displayName]);
  document.getElementById('access-options').style.display = 'none';
  document.getElementById('cancel-btn').style.display = 'none';
  const btn = document.getElementById('grant-btn');
  btn.textContent = browser.i18n.getMessage('btnOK');
  btn.disabled = false;
  btn.addEventListener('click', () => window.close());
} else {
  document.getElementById('grant-btn').addEventListener('click', async () => {
    const selected = document.querySelector('input[name="access"]:checked');
    if (!selected) return;

    const capabilities = selected.value === 'readwrite' ? readwriteCapabilities : readonlyCapabilities;
    const storageId = crypto.randomUUID();
    const providerName = browser.i18n.getMessage('providerName');

    await vfs.reportNewConnection(addonId, storageId, providerName, capabilities);

    // Also store addonName so the options page can display it
    const rv2 = await browser.storage.local.get({ [CONNECTIONS_KEY]: [] });
    const list = rv2[CONNECTIONS_KEY];
    const idx = list.findIndex(c => c.addonId === addonId && c.storageId === storageId);
    if (idx >= 0 && addonName) list[idx].addonName = addonName;
    await browser.storage.local.set({ [CONNECTIONS_KEY]: list });

    window.close();
  });
}

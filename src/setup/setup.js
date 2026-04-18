import * as vfs from '../vendor/vfs-provider.mjs';
import { localizeDocument } from '../vendor/i18n.mjs';

localizeDocument();

const CONNECTIONS_KEY = 'vfs-toolkit-connections';

const params = new URLSearchParams(location.search);
const addonId = params.get('addonId');
const addonName = params.get('addonName');
const setupToken = params.get('setupToken');

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

document.getElementById('cancel-btn').addEventListener('click', () => window.close());

const rv = await browser.storage.local.get({ [CONNECTIONS_KEY]: [] });
const mine = rv[CONNECTIONS_KEY].filter(c => c.addonId === addonId);
const hasReadOnly = mine.some(c => c.capabilities?.file?.add === false);
const hasReadWrite = mine.some(c => c.capabilities?.file?.add === true);

function disableOption(optionId) {
  const option = document.getElementById(optionId);
  option.classList.add('disabled');
  option.querySelector('input[type="radio"]').disabled = true;
}

if (hasReadOnly) disableOption('opt-readonly');
if (hasReadWrite) disableOption('opt-readwrite');

if (hasReadOnly && hasReadWrite) {
  document.getElementById('msg').textContent =
    browser.i18n.getMessage('setupAlreadyGranted', [displayName]);
  document.getElementById('cancel-btn').style.display = 'none';
  const btn = document.getElementById('grant-btn');
  btn.textContent = browser.i18n.getMessage('btnOK');
  btn.disabled = false;
  btn.addEventListener('click', () => window.close());
} else {
  // Highlight selected radio option (enabled ones only)
  for (const option of document.querySelectorAll('.access-option')) {
    option.addEventListener('click', () => {
      if (option.classList.contains('disabled')) return;
      const radio = option.querySelector('input[type="radio"]');
      radio.checked = true;
      document.querySelectorAll('.access-option').forEach(o => o.classList.remove('selected'));
      option.classList.add('selected');
      document.getElementById('grant-btn').disabled = false;
    });
  }

  document.getElementById('grant-btn').addEventListener('click', async () => {
    const selected = document.querySelector('input[name="access"]:checked');
    if (!selected) return;

    const isReadWrite = selected.value === 'readwrite';
    const capabilities = isReadWrite ? readwriteCapabilities : readonlyCapabilities;
    const name = browser.i18n.getMessage(isReadWrite ? 'accessReadWrite' : 'accessReadOnly');
    const storageId = crypto.randomUUID();

    await vfs.reportNewConnection(addonId, addonName, storageId, name, capabilities, setupToken);

    window.close();
  });
}

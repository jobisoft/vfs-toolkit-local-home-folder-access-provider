const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const https = require("https");

// CRC-32 lookup table
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[i] = c;
}
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Zip files/folders into destFile.
 * @param {string|string[]} sources - Paths to zip
 * @param {string} destFile - Output zip file
 * @param {string[]} [exclude=[]] - Optional array of folder/file paths to exclude (relative paths)
 */
function zip(sources, destFile, exclude = []) {
  const files = [];

  // Ensure parent directory exists
  const parentDir = path.dirname(destFile);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  function collect(full, rel) {
    // skip if rel matches any exclude pattern
    if (exclude.some(e => rel === e || rel.startsWith(e + "/"))) return;

    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full)) {
        collect(path.join(full, name), rel + "/" + name);
      }
    } else {
      files.push({ full, rel });
    }
  }

  if (typeof sources === "string") {
    for (const name of fs.readdirSync(sources)) collect(path.join(sources, name), name);
  } else {
    for (const src of sources) collect(src, src);
  }

  const parts = [];
  const centralDir = [];
  let offset = 0;

  for (const { full, rel } of files) {
    const data = fs.readFileSync(full);
    const compressed = zlib.deflateRawSync(data);
    const useDeflate = compressed.length < data.length;
    const fileData = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const nameBytes = Buffer.from(rel, "utf8");

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(fileData.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(fileData.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBytes.copy(cd, 46);

    parts.push(local, fileData);
    centralDir.push(cd);
    offset += local.length + fileData.length;
  }

  const cdBuf = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(destFile, Buffer.concat([...parts, cdBuf, eocd]));
}

function rm(dir) {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "build-script" } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(get(res.headers.location));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function fetchJSON(url) {
  const buf = await get(url);
  return JSON.parse(buf.toString("utf8"));
}

async function fetchText(url) {
  const buf = await get(url);
  return buf.toString("utf8");
}

async function main() {
  const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const manifest = JSON.parse(fs.readFileSync("src/manifest.json", "utf8"));
  manifest.version = version;
  fs.writeFileSync("src/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Set manifest version to ${version}`);

  console.log("Cleaning output directory ...");
  rm("dist");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const vendorSections = [];

  for (const entry of pkg.vendor) {
    const filename = path.basename(entry.dest);
    console.log(`Fetching latest ${filename} from GitHub ...`);
    const commits = await fetchJSON(
      `https://api.github.com/repos/${entry.repo}/commits?path=${entry.path}&per_page=1`
    );
    const sha = commits[0].sha;
    console.log(`  Latest commit: ${sha}`);

    const fileUrl = `https://github.com/${entry.repo}/raw/${sha}/${entry.path}`;
    console.log(`  Fetching ${filename} ...`);
    const content = await fetchText(fileUrl);
    fs.mkdirSync(path.dirname(entry.dest), { recursive: true });
    fs.writeFileSync(entry.dest, content);

    vendorSections.push(`## ${filename}\n\n- **File** : \`${entry.dest.replace(/^src\//, "")}\`\n- **Upstream** : ${fileUrl}`);
    console.log(`  Fetched ${filename} at commit ${sha}`);
  }

  fs.writeFileSync("src/VENDOR.md", `# Vendored Files\n\nThis file lists files that were not created by this project and are maintained upstream elsewhere.\n\n${vendorSections.join("\n\n")}\n`);

  console.log("Creating extension file (dist/vfs-provider-home-folder-access.xpi) ...");
  zip("src", "dist/vfs-provider-home-folder-access.xpi");

  console.log("Build finished. Output is in the 'dist' folder.");
  https.globalAgent.destroy();
}

main().catch(e => { console.error(e); process.exit(1); });

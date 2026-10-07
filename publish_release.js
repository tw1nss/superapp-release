/**
 * publish_release.js
 * Tool untuk menyinkronkan rilis APK dan version manifest ke repo publik `tw1nss/superapp-release`
 * Repository utama `tw1nss/Superappmtg` tetap 100% PRIVATE.
 */

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

async function publish() {
  console.log('🚀 Memulai proses publikasi ke repo superapp-release...');

  // 1. Ambil token dari git credential manager
  const p = cp.spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8'
  });
  const match = p.stdout && p.stdout.match(/password=(.+)/);
  if (!match) {
    console.error('❌ Gagal membaca git credential token.');
    process.exit(1);
  }
  const token = match[1].trim();

  // 2. Unduh APK terbaru dari release private
  console.log('📦 Memeriksa build APK terbaru di repo private...');
  const relRes = await fetch('https://api.github.com/repos/tw1nss/Superappmtg/releases', {
    headers: { 'Authorization': 'Bearer ' + token, 'User-Agent': 'Node' }
  });
  const releases = await relRes.json();
  if (!releases || releases.length === 0) {
    console.error('❌ Tidak ada rilis di repo private.');
    process.exit(1);
  }

  const asset = releases[0].assets.find(a => a.name.endsWith('.apk'));
  if (!asset) {
    console.error('❌ File APK tidak ditemukan di rilis private.');
    process.exit(1);
  }

  console.log(`⬇️ Mengunduh APK ${asset.name} (${Math.round(asset.size / 1024 / 1024 * 100) / 100} MB)...`);
  const fileRes = await fetch(asset.url, {
    headers: { 'Authorization': 'Bearer ' + token, 'User-Agent': 'Node', 'Accept': 'application/octet-stream' }
  });
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  const releaseDir = path.resolve(__dirname, '../superapp-release');
  if (!fs.existsSync(releaseDir)) {
    console.log('📂 Meng-clone repo superapp-release...');
    cp.execSync('git clone https://github.com/tw1nss/superapp-release.git ../superapp-release', { stdio: 'inherit' });
  }

  // 3. Simpan APK dan sinkronkan seluruh live web assets ke superapp-release (OTA)
  const apkDest = path.join(releaseDir, 'app-debug.apk');
  fs.writeFileSync(apkDest, buffer);
  console.log('✅ APK tersimpan di:', apkDest);

  const syncFiles = [
    'version.json',
    'index.html',
    'app.js',
    'style.css',
    'qrcode.min.js',
    'sw.js',
    'manifest.json',
    'GoogleAppsScript_EDS.js',
    'GoogleAppsScript_ED_Correction.js',
    'GoogleAppsScript_DCC_Master.js',
    'GoogleAppsScript_KoliInbound.js',
    'GoogleAppsScript_Pinjaman.js',
    'GoogleAppsScript_CWG_EDS.js',
    'GoogleAppsScript_CWG_ED_Correction.js',
    'GoogleAppsScript_CWG_DCC_Master.js',
    'GoogleAppsScript_CWG_KoliInbound.js',
    'GoogleAppsScript_CWG_Pinjaman.js',
    'app-logo.jpg',
    'astro-logo.png',
    'icon-192.png',
    'icon-512.png',
    'icon-192.svg',
    'icon-512.svg',
    'CNAME',
    'wa-bot-webhook.zip'
  ];

  syncFiles.forEach(file => {
    const src = path.join(__dirname, file);
    const dst = path.join(releaseDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      console.log(`✅ ${file} tersinkronkan.`);
    }
  });

  // Sinkronkan folder dash (Admin Dashboard)
  const dashSrc = path.join(__dirname, 'dash');
  const dashDst = path.join(releaseDir, 'dash');
  if (fs.existsSync(dashSrc)) {
    fs.cpSync(dashSrc, dashDst, { recursive: true });
    console.log('✅ Folder dash/ (Admin Complaint Command Center) tersinkronkan.');
  }

  // Sinkronkan folder multi-hub: mtg, cwg
  const hubFolders = ['mtg', 'cwg'];
  hubFolders.forEach(folder => {
    const hubSrc = path.join(__dirname, folder);
    const hubDst = path.join(releaseDir, folder);
    if (fs.existsSync(hubSrc)) {
      fs.cpSync(hubSrc, hubDst, { recursive: true });
      console.log(`✅ Folder ${folder}/ (${folder.toUpperCase()} Hub) tersinkronkan.`);
    }
  });

  // 4. Git commit & push di releaseDir
  console.log('⬆️ Melakukan git push ke tw1nss/superapp-release...');
  const vJsonDest = path.join(releaseDir, 'version.json');
  const versionData = JSON.parse(fs.readFileSync(vJsonDest, 'utf8'));
  const commitMsg = `release: v${versionData.versionName} (build ${versionData.versionCode}) - sync live web assets and APK`;

  cp.execSync('git add .', { cwd: releaseDir, stdio: 'inherit' });
  try {
    cp.execSync(`git commit -m "${commitMsg}"`, { cwd: releaseDir, stdio: 'inherit' });
  } catch (e) {
    console.log('ℹ️ Tidak ada perubahan berkas untuk di-commit.');
  }
  cp.execSync('git push origin main', { cwd: releaseDir, stdio: 'inherit' });

  console.log(`🎉 Sukses! Rilis v${versionData.versionName} berhasil dipublikasikan secara publik dan aman.`);
}

publish().catch(err => {
  console.error('❌ Terjadi kesalahan saat rilis:', err);
  process.exit(1);
});

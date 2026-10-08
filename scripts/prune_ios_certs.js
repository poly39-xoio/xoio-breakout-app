// prune_ios_certs.js
// 在 CI Archive 之前執行:撤銷舊的「Created via API」簽章憑證,
// 只保留最新 KEEP 張,避免 Apple 憑證額度爆掉(每次自動簽章都會新建一張)。
// 需要環境變數:ASC_KEY_ID、ASC_ISSUER_ID,以及 ~/private_keys/AuthKey_<KEYID>.p8
const fs = require('fs'), crypto = require('crypto'), os = require('os'), path = require('path');
const KEYID = process.env.ASC_KEY_ID;
const ISSUER = process.env.ASC_ISSUER_ID;
// Apple 上限:每帳號 3 張(每種類型)。CI 每次 archive 會新建 1 張,
// 因此預設只保留 1 張(可留 2 個空位),避免「max certificates」再爆。
const KEEP = parseInt(process.env.KEEP || '1', 10);
const P8 = process.env.ASC_KEY_PATH || path.join(os.homedir(), 'private_keys', `AuthKey_${KEYID}.p8`);
const API = 'https://api.appstoreconnect.apple.com';

function jwt() {
  const key = fs.readFileSync(P8, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = b({ alg: 'ES256', kid: KEYID, typ: 'JWT' });
  const p = b({ iss: ISSUER, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' });
  const input = h + '.' + p;
  const sig = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return input + '.' + sig;
}

(async () => {
  if (!KEYID || !ISSUER) { console.log('skip: missing ASC_KEY_ID/ASC_ISSUER_ID'); return; }
  if (!fs.existsSync(P8)) { console.log('skip: p8 not found at ' + P8); return; }
  const t = jwt();
  const H = { Authorization: 'Bearer ' + t };
  const res = await fetch(`${API}/v1/certificates?limit=200`, { headers: H });
  if (!res.ok) { console.log('list certs failed ' + res.status + ' ' + (await res.text()).slice(0, 200)); return; }
  const j = await res.json();
  const all = j.data || [];
  const api = all.filter(c => c.attributes && c.attributes.displayName === 'Created via API');
  api.sort((a, b) => String(b.attributes.expirationDate).localeCompare(String(a.attributes.expirationDate))); // newest first
  const kill = api.slice(KEEP);
  console.log(`certs total=${all.length} | "Created via API"=${api.length} | keep newest ${KEEP} | revoke ${kill.length}`);
  for (const c of kill) {
    const r = await fetch(`${API}/v1/certificates/${c.id}`, { method: 'DELETE', headers: H });
    console.log('revoke', c.id, c.attributes.certificateType, String(c.attributes.expirationDate).slice(0, 10), '->', r.status);
  }
  console.log('prune done');
})().catch(e => { console.log('prune error (ignored): ' + e.message); });

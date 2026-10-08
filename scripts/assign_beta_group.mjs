// Assign the newest VALID build of the app to the internal TestFlight group.
// Runs in GitHub Actions right after "Upload to App Store Connect" so that new
// builds ALWAYS show up in TestFlight (prevents the "uploaded but invisible" miss).
// Env: ASC_KEY_ID, ASC_ISSUER_ID (required in CI). Key read from
//      $HOME/private_keys/AuthKey_<ASC_KEY_ID>.p8 (same path the workflow writes).
// Optional: ASC_KEY_PATH, ASC_APP_ID, ASC_BETA_GROUP, TARGET_BUILD (build number)
import fs from 'node:fs';
import crypto from 'node:crypto';

const KEY_ID = process.env.ASC_KEY_ID || '7MMR5Z7G34';
const ISSUER = process.env.ASC_ISSUER_ID || '19a86a9e-82a3-472f-a0b2-dc98b0e55819';
const KEY_PATH = process.env.ASC_KEY_PATH || `${process.env.HOME}/private_keys/AuthKey_${KEY_ID}.p8`;
const APP = process.env.ASC_APP_ID || '6811858851';
const GROUP = process.env.ASC_BETA_GROUP || 'e3fe0f03-029a-4e2e-af76-b9f41310ede4'; // Internal Testing
const TARGET = process.env.TARGET_BUILD || null;
const API = 'https://api.appstoreconnect.apple.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }));
  const pay = b64url(JSON.stringify({ iss: ISSUER, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' }));
  const input = head + '.' + pay;
  const key = fs.readFileSync(KEY_PATH, 'utf8');
  const sig = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return input + '.' + b64url(sig);
}
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + token(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}
async function pickBuild() {
  const { status, json } = await api('GET', `/v1/builds?filter[app]=${APP}&limit=8&sort=-uploadedDate&fields[builds]=version,processingState,uploadedDate`);
  if (status !== 200 || !json || !json.data) return null;
  if (TARGET) return json.data.find((b) => String(b.attributes.version) === String(TARGET)) || null;
  return json.data[0] || null;
}

(async () => {
  let build = null;
  for (let i = 0; i < 20; i++) {           // wait up to ~10 min for Apple processing
    build = await pickBuild();
    if (build && build.attributes.processingState === 'VALID') break;
    console.log(`[assign] waiting for build ${TARGET || '(latest)'} ... (${i + 1})` + (build ? ` state=${build.attributes.processingState}` : ' not found yet'));
    await sleep(30000);
  }
  if (!build || build.attributes.processingState !== 'VALID') { console.error('[assign] no VALID build found'); process.exit(1); }
  const bid = build.id, ver = build.attributes.version;

  await api('PATCH', `/v1/builds/${bid}`, { data: { type: 'builds', id: bid, attributes: { usesNonExemptEncryption: false } } });

  const g = await api('GET', `/v1/betaGroups/${GROUP}/builds?limit=100&fields[builds]=version`);
  const have = g.json && g.json.data ? g.json.data.map((b) => b.id) : [];
  if (have.includes(bid)) { console.log(`[assign] build ${ver} already in internal group`); return; }

  const r = await api('POST', `/v1/betaGroups/${GROUP}/relationships/builds`, { data: [{ type: 'builds', id: bid }] });
  if (![200, 201, 204].includes(r.status)) { console.error('[assign] failed', r.status, JSON.stringify(r.json)); process.exit(1); }
  console.log(`[assign] build ${ver} (${bid}) assigned to internal TestFlight group`);
})();

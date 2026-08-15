// Verify the gateway can sign an Ed25519 JWT that the data lake will accept.
// We re-verify the signature with Node's crypto to prove the token is a
// valid EdDSA JWT (header.kid -> public key), without needing the lake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as verifySig } from 'node:crypto';
import { signT1 } from '../lib/jwt.js';

function b64urlToBytes(s) {
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad), 'base64');
}

test('gateway signT1 produces a verifiable Ed25519 JWT', () => {
  const kp = generateKeyPairSync('ed25519');
  const privPem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub = kp.publicKey;

  const jwt = signT1({ openid: 'oABC', tenantId: 'weijiashi', ttl: 3600, privateKeyPem: privPem });
  const [hB64, pB64, sB64] = jwt.split('.');
  assert.equal(hB64.split('.').length, 1, 'should have 3 parts');

  const header = JSON.parse(b64urlToBytes(hB64).toString('utf8'));
  const payload = JSON.parse(b64urlToBytes(pB64).toString('utf8'));
  assert.equal(header.alg, 'EdDSA');
  assert.equal(header.kid, 'gw1');
  assert.equal(payload.sub, 'oABC');
  assert.equal(payload.tid, 'weijiashi');
  assert.equal(payload.iss, 'gateway');
  assert.equal(payload.aud, 'data.kapibala.icu');
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));

  const ok = verifySig(null, Buffer.from(`${hB64}.${pB64}`), pub, b64urlToBytes(sB64));
  assert.ok(ok, 'signature must verify against the paired public key');

  // tamper detection
  const forged = `${hB64}.${pB64}.${Buffer.from('x').toString('base64url')}`;
  const [fh, fp, fs] = forged.split('.');
  const bad = verifySig(null, Buffer.from(`${fh}.${fp}`), pub, b64urlToBytes(fs));
  assert.equal(bad, false);
});

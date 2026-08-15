// Thin REST client for the data lake, authenticated with a T3 service token.
//
// Every call mints a short-lived HS256 service token (kid + secret supplied
// by the operator). The data lake checks: signature (HMAC-SHA256), exp,
// iss/aud, and — because this key is tenant_bound — that the URL tenant
// equals the key's tenant_id. No scope enforcement on the lake side yet
// (MVP), so the `scope` array here is documentation of intent and matches
// the key's stored scope.

import { signServiceToken } from './token.js';

export function createDataLakeClient(cfg) {
  const { dataLakeUrl, apiKeyId, apiKeySecret, apiKeyKid, tenantId, appId } = cfg;

  function authHeader() {
    const token = signServiceToken(apiKeySecret, {
      sub: apiKeyId,
      aid: appId,
      tid: tenantId,
      kid: apiKeyKid,
    });
    return `Bearer ${token}`;
  }

  async function req(method, path, body) {
    const res = await fetch(`${dataLakeUrl}${path}`, {
      method,
      headers: {
        Authorization: authHeader(),
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!res.ok) {
      throw new Error(`datalake ${res.status} on ${method} ${path}: ${text}`);
    }
    return data;
  }

  return {
    // --- read tools (require data:read) ----------------------------------
    async listTodos({ ownerAll = false } = {}) {
      const q = ownerAll ? '?owner=all' : '';
      return req('GET', `/t/${tenantId}/todos${q}`);
    },

    async searchArchive({ keyword, ownerAll = true } = {}) {
      const q = ownerAll ? '?owner=all' : '';
      const items = await req('GET', `/t/${tenantId}/archive${q}`);
      if (!keyword) return items;
      const kw = keyword.toLowerCase();
      return items.filter((it) => JSON.stringify(it).toLowerCase().includes(kw));
    },

    // --- write tools (require data:write) --------------------------------
    async addTask({ title, tag, owner, meta, shared }) {
      return req('POST', `/t/${tenantId}/todos`, {
        title,
        tag: tag || null,
        owner_openid: owner || undefined,
        meta: meta || {},
        shared: shared || false,
      });
    },
  };
}

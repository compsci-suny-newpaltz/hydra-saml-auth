/**
 * Minimal SAML SP-initiated login client for the dev stack (SimpleSAMLphp mock IdP).
 *   GET  BASE/login                      -> 302 to IdP SSOService (SAMLRequest)
 *   GET  IdP SSOService                  -> 302 to loginuserpass form
 *   POST form (username, password, AuthState)
 *   HTML auto-post form                  -> POST SAMLResponse to BASE/login/callback
 *   -> np_access cookie + session cookie
 * The IdP's cluster-internal host (mock-saml-idp:8080) is rewritten to IDP_URL
 * because tests run from the host, not from inside the k3d network.
 */
const BASE = (process.env.BASE_URL || 'http://localhost:6969').replace(/\/$/, '');
const IDP  = (process.env.IDP_URL  || 'http://localhost:8080').replace(/\/$/, '');

class Jar {
  constructor() { this.cookies = new Map(); }           // host -> Map(name -> value)
  store(url, res) {
    const host = new URL(url).host;
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (!this.cookies.has(host)) this.cookies.set(host, new Map());
    for (const c of set) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.cookies.get(host).set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); }
  }
  header(url) {
    const m = this.cookies.get(new URL(url).host); if (!m || !m.size) return '';
    return [...m].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get(url, name) { return this.cookies.get(new URL(url).host)?.get(name); }
}

function rewriteIdp(url) {
  return url.replace(/^https?:\/\/mock-saml-idp(?::\d+)?/, IDP);
}

async function go(jar, url, opts = {}) {
  url = rewriteIdp(url);
  const headers = { ...(opts.headers || {}) };
  const ck = jar.header(url); if (ck) headers.cookie = ck;
  const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
  jar.store(url, res);
  return res;
}

async function follow(jar, url, opts) {
  let res = await go(jar, url, opts);
  for (let i = 0; i < 10 && [301, 302, 303, 307].includes(res.status); i++) {
    const loc = new URL(res.headers.get('location'), rewriteIdp(url)).toString();
    url = loc; res = await go(jar, loc);
  }
  return { res, url };
}

function parseForm(html) {
  const action = /<form[^>]*action="([^"]*)"/i.exec(html)?.[1];
  const fields = {};
  for (const m of html.matchAll(/<input[^>]*>/gi)) {
    const name = /name="([^"]*)"/i.exec(m[0])?.[1]; if (!name) continue;
    const value = /value="([^"]*)"/i.exec(m[0])?.[1] ?? '';
    fields[name] = value.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#43;/g, '+').replace(/&#x2B;/g, '+');
  }
  return { action, fields };
}

/** Log in as user/pass; returns a Jar holding np_access + session cookies for BASE. */
async function login(username, password) {
  const jar = new Jar();
  const { res: formRes, url: formUrl } = await follow(jar, `${BASE}/login?returnTo=/dashboard`);
  const html = await formRes.text();
  if (!/name="username"/i.test(html)) throw new Error(`IdP login form not found at ${formUrl} (status ${formRes.status})`);
  const form = parseForm(html);
  const action = new URL(form.action || formUrl, formUrl).toString();
  const body = new URLSearchParams({ ...form.fields, username, password });
  const { res: samlRes } = await follow(jar, action, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const samlHtml = await samlRes.text();
  const post = parseForm(samlHtml);
  if (!post.fields.SAMLResponse) throw new Error(`no SAMLResponse after login as ${username} (bad password? status ${samlRes.status})`);
  const acs = post.action.startsWith('http') ? post.action : `${BASE}${post.action}`;
  const cb = await go(jar, acs, { method: 'POST', body: new URLSearchParams(post.fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  if (![302, 303].includes(cb.status)) throw new Error(`ACS returned ${cb.status}: ${(await cb.text()).slice(0, 200)}`);
  if (!jar.get(BASE, 'np_access')) throw new Error('no np_access cookie after SSO login');
  return jar;
}

/** fetch with the jar's cookies, no redirect following. */
const as = (jar) => (path, opts = {}) => go(jar, `${BASE}${path}`, opts);
const anon = (path, opts = {}) => go(new Jar(), `${BASE}${path}`, opts);

module.exports = { login, as, anon, BASE, IDP };

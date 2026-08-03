/**
 * Test harness for api/lead.js.
 *
 * Two things about the handler shape the design here:
 *
 * 1. The throttle map (`HITS` in api/lead.js) lives at module scope, so it
 *    survives between tests in the same process. Every call therefore gets a
 *    unique synthetic IP unless the test deliberately reuses one — otherwise
 *    tests would leak rate-limit state into each other and fail by ordering.
 *
 * 2. The only I/O boundary is a single global `fetch`, which makes the whole
 *    handler testable without a network or a Supabase project.
 */

'use strict';

const handler = require('../../api/lead.js');

const ENV_URL = 'https://project.supabase.co';
const ENV_KEY = 'service-role-key-do-not-log';

let ipCounter = 0;
/** A fresh IP per call, so module-scoped throttle state never crosses tests. */
function uniqueIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 256}.${Math.floor(ipCounter / 256)}`;
}

/** Minimal stand-in for the Vercel response object. */
function mockRes() {
  const res = {
    statusCode: undefined,
    body: undefined,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

/**
 * Record every fetch call and reply with a canned response.
 * `impl` may be a function (full control) or {ok, status, text}.
 */
function stubFetch(impl) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options, body: safeParse(options && options.body) });
    if (typeof impl === 'function') return impl(url, options);
    const { ok = true, status = 201, text = '' } = impl || {};
    return { ok, status, text: async () => text };
  };
  fn.calls = calls;
  global.fetch = fn;
  return fn;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Invoke the handler.
 *
 * @param {object}  opts
 * @param {string}  [opts.method='POST']
 * @param {*}       [opts.body]           request body (object or raw string)
 * @param {string}  [opts.ip]             pin an IP to exercise the throttle
 * @param {object}  [opts.headers]        extra request headers
 * @param {boolean} [opts.noEnv]          unset both Supabase env vars
 * @param {object}  [opts.env]            override individual env vars
 */
async function call(opts = {}) {
  const {
    method = 'POST',
    body,
    ip = uniqueIp(),
    headers = {},
    noEnv = false,
    env = {},
  } = opts;

  const saved = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };

  if (noEnv) {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  } else {
    process.env.SUPABASE_URL = ENV_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = ENV_KEY;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const req = {
    method,
    headers: { 'x-forwarded-for': ip, ...headers },
    body,
  };
  const res = mockRes();

  // The handler logs to console.error on every failure path. Capture instead
  // of printing so a passing run stays readable, and so tests can assert that
  // details were logged server-side rather than returned to the caller.
  const realError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.map(String).join(' '));

  try {
    await handler(req, res);
  } finally {
    console.error = realError;
    process.env.SUPABASE_URL = saved.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }

  res.logged = logged.join('\n');
  return res;
}

module.exports = { call, stubFetch, mockRes, uniqueIp, ENV_URL, ENV_KEY };

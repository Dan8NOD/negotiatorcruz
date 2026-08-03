/**
 * Unit tests for api/lead.js — the site's only conversion path.
 *
 * These pin behaviour that is otherwise invisible: the honeypot has to answer
 * 200 while writing nothing, the failure paths have to stay generic so
 * PostgREST internals and the service-role key never reach the browser, and
 * the row we build has to keep matching the lead_submissions schema.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { call, stubFetch, ENV_KEY } = require('./helpers/lead-harness.js');

/** A body that passes validation, so tests can vary one field at a time. */
const valid = (over = {}) => ({ name: 'Dana Reyes', email: 'dana@example.com', ...over });

describe('method guard', () => {
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    test(`${method} is rejected with 405 and an Allow header`, async () => {
      const fetchStub = stubFetch();
      const res = await call({ method });

      assert.equal(res.statusCode, 405);
      assert.deepEqual(res.body, { ok: false, error: 'Method not allowed' });
      assert.equal(res.headers.allow, 'POST');
      assert.equal(fetchStub.calls.length, 0, 'must not touch the database');
    });
  }

  test('POST is accepted', async () => {
    stubFetch();
    const res = await call({ body: valid() });
    assert.equal(res.statusCode, 200);
  });
});

describe('configuration guard', () => {
  test('missing both env vars returns 503 and does not insert', async () => {
    const fetchStub = stubFetch();
    const res = await call({ body: valid(), noEnv: true });

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /not configured yet/);
    assert.equal(fetchStub.calls.length, 0);
  });

  test('missing only the service-role key returns 503', async () => {
    stubFetch();
    const res = await call({ body: valid(), env: { SUPABASE_SERVICE_ROLE_KEY: undefined } });
    assert.equal(res.statusCode, 503);
  });

  test('missing only the URL returns 503', async () => {
    stubFetch();
    const res = await call({ body: valid(), env: { SUPABASE_URL: undefined } });
    assert.equal(res.statusCode, 503);
  });

  test('the 503 blames the site, not the visitor, and offers a way through', async () => {
    stubFetch();
    const res = await call({ body: valid(), noEnv: true });
    assert.match(res.body.error, /negotiatorsondemand@gmail\.com/);
    assert.doesNotMatch(res.body.error, /invalid|required|wrong/i);
  });
});

describe('throttle', () => {
  test('allows 5 submissions per IP per minute and blocks the 6th', async () => {
    stubFetch();
    const ip = '198.51.100.7';

    for (let i = 1; i <= 5; i++) {
      const res = await call({ body: valid(), ip });
      assert.equal(res.statusCode, 200, `submission ${i} should pass`);
    }

    const blocked = await call({ body: valid(), ip });
    assert.equal(blocked.statusCode, 429);
    assert.match(blocked.body.error, /Too many submissions/);
  });

  test('the throttle is per-IP, not global', async () => {
    stubFetch();
    const hot = '198.51.100.8';
    for (let i = 0; i < 6; i++) await call({ body: valid(), ip: hot });

    const other = await call({ body: valid(), ip: '198.51.100.9' });
    assert.equal(other.statusCode, 200, 'a different visitor must be unaffected');
  });

  test('throttling happens before validation, so bad input still counts', async () => {
    // Documents a real UX consequence: six typo'd submissions in a minute
    // lock the visitor out even though none of them reached the database.
    stubFetch();
    const ip = '198.51.100.10';

    for (let i = 0; i < 5; i++) {
      const res = await call({ body: { name: '', email: '' }, ip });
      assert.equal(res.statusCode, 400);
    }

    const res = await call({ body: valid(), ip });
    assert.equal(res.statusCode, 429, 'a valid submission is now blocked too');
  });

  test('the throttle keys off the first x-forwarded-for entry', async () => {
    stubFetch();
    const client = '198.51.100.11';
    const chain = `${client}, 70.41.3.18, 150.172.238.178`;

    for (let i = 0; i < 6; i++) await call({ body: valid(), ip: chain });

    // Same client, different proxy chain — must still be recognised.
    const res = await call({ body: valid(), ip: `${client}, 10.0.0.1` });
    assert.equal(res.statusCode, 429);
  });

  test('a flood of fresh IPs does not clear an active offender\'s history', async () => {
    // This used to assert the opposite, and was right to flag it: the ceiling
    // called HITS.clear(), so anyone cycling addresses past it also wiped the
    // history of whoever was already being throttled — handing an attacker a
    // clean slate at the exact moment the limit mattered. api/lead.js now
    // evicts least-recently-seen instead, which is the per-key eviction the
    // original version of this test suggested as the fix.
    stubFetch();
    const offender = '198.51.100.12';

    // Use the offender's full quota, then keep them active while a flood of
    // unrelated addresses pushes the map past its ceiling. Staying active is
    // the point: LRU evicts the idle, which is the behaviour we want.
    for (let i = 0; i < 5; i++) await call({ body: valid(), ip: offender });

    let blocked = 0;
    const attempts = 40;
    for (let i = 0; i < attempts; i++) {
      for (let j = 0; j < 60; j++) {
        await call({ body: valid(), ip: `192.0.2.${j}.${i}` });
      }
      const res = await call({ body: valid(), ip: offender });
      if (res.statusCode === 429) blocked += 1;
    }

    assert.ok(
      blocked > attempts * 0.9,
      `offender was let through ${attempts - blocked}/${attempts} times after a flood`
    );
  });

  test('an idle IP is the one evicted when the ceiling is crossed', async () => {
    // The flip side of the rule above: eviction has to fall on someone, and it
    // should fall on visitors who have gone quiet rather than on live traffic.
    stubFetch();
    const idle = '198.51.100.99';
    for (let i = 0; i < 5; i++) await call({ body: valid(), ip: idle });

    // 2000 is the ceiling in api/lead.js; comfortably exceed it while the idle
    // address sends nothing at all.
    for (let i = 0; i < 2100; i++) {
      await call({ body: valid(), ip: `203.0.113.${i % 256}.${Math.floor(i / 256)}` });
    }

    const res = await call({ body: valid(), ip: idle });
    assert.equal(res.statusCode, 200, 'an IP that went quiet should have been evicted');
  });

  test('a missing x-forwarded-for falls back to a shared "unknown" bucket', async () => {
    stubFetch();
    let last;
    for (let i = 0; i < 6; i++) {
      last = await call({ body: valid(), headers: { 'x-forwarded-for': '' } });
    }
    assert.equal(last.statusCode, 429);
  });
});

describe('body parsing', () => {
  test('a JSON string body is parsed', async () => {
    const fetchStub = stubFetch();
    const res = await call({ body: JSON.stringify(valid()) });

    assert.equal(res.statusCode, 200);
    assert.equal(fetchStub.calls[0].body.name, 'Dana Reyes');
  });

  test('an unparseable string body degrades to a 400 rather than throwing', async () => {
    stubFetch();
    const res = await call({ body: 'not json at all {{{' });
    assert.equal(res.statusCode, 400);
  });

  for (const [label, body] of [
    ['undefined', undefined],
    ['null', null],
    ['an array', []],
    ['a number', 42],
  ]) {
    test(`${label} body is treated as empty and returns 400`, async () => {
      stubFetch();
      const res = await call({ body });
      assert.equal(res.statusCode, 400);
    });
  }
});

describe('honeypot', () => {
  test('a filled honeypot returns 200 but writes nothing', async () => {
    const fetchStub = stubFetch();
    const res = await call({ body: valid({ company_website: 'http://spam.example' }) });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true }, 'the bot must believe it succeeded');
    assert.equal(fetchStub.calls.length, 0, 'nothing may reach the database');
  });

  test('the honeypot wins even when the rest of the body is invalid', async () => {
    const fetchStub = stubFetch();
    const res = await call({ body: { company_website: 'x' } });

    assert.equal(res.statusCode, 200);
    assert.equal(fetchStub.calls.length, 0);
  });

  test('a whitespace-only honeypot is ignored, so real submissions survive', async () => {
    const fetchStub = stubFetch();
    const res = await call({ body: valid({ company_website: '   ' }) });

    assert.equal(res.statusCode, 200);
    assert.equal(fetchStub.calls.length, 1, 'this is a human, not a bot');
  });

  test('an absent honeypot field is fine', async () => {
    const fetchStub = stubFetch();
    await call({ body: valid() });
    assert.equal(fetchStub.calls.length, 1);
  });
});

describe('validation', () => {
  test('a missing name is rejected', async () => {
    const fetchStub = stubFetch();
    const res = await call({ body: { email: 'dana@example.com' } });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Name and email are required.');
    assert.equal(fetchStub.calls.length, 0);
  });

  test('a missing email is rejected', async () => {
    stubFetch();
    const res = await call({ body: { name: 'Dana' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Name and email are required.');
  });

  test('a whitespace-only name is rejected', async () => {
    stubFetch();
    const res = await call({ body: valid({ name: '   \t\n  ' }) });
    assert.equal(res.statusCode, 400);
  });

  test('non-string fields are rejected rather than coerced', async () => {
    stubFetch();
    const res = await call({ body: { name: 12345, email: { at: 'example.com' } } });
    assert.equal(res.statusCode, 400);
  });

  describe('email shape', () => {
    const accepted = [
      'dana@example.com',
      'dana.reyes@example.co.uk',
      'dana+speaking@example.com',
      "o'brien@example.com",
      'DANA@EXAMPLE.COM',
      'x@y.z',
    ];
    for (const email of accepted) {
      test(`accepts ${email}`, async () => {
        stubFetch();
        const res = await call({ body: valid({ email }) });
        assert.equal(res.statusCode, 200, `${email} should be accepted`);
      });
    }

    const rejected = [
      'plainaddress',
      'dana@localhost',
      'dana@.com',
      'dana@example',
      '@example.com',
      'dana@@example.com',
      'dana reyes@example.com',
      'dana@exa mple.com',
    ];
    for (const email of rejected) {
      test(`rejects ${email}`, async () => {
        const fetchStub = stubFetch();
        const res = await call({ body: valid({ email }) });

        assert.equal(res.statusCode, 400, `${email} should be rejected`);
        assert.equal(res.body.error, "That email address doesn't look right.");
        assert.equal(fetchStub.calls.length, 0);
      });
    }

    test('the address is stored exactly as typed, with no normalisation', async () => {
      const fetchStub = stubFetch();
      await call({ body: valid({ email: '  Dana.Reyes@Example.COM  ' }) });
      assert.equal(fetchStub.calls[0].body.email, 'Dana.Reyes@Example.COM');
    });
  });
});

describe('the row written to lead_submissions', () => {
  test('targets the right table with service-role credentials', async () => {
    const fetchStub = stubFetch();
    await call({ body: valid() });

    const [{ url, options }] = fetchStub.calls;
    assert.equal(url, 'https://project.supabase.co/rest/v1/lead_submissions');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.apikey, ENV_KEY);
    assert.equal(options.headers.Authorization, `Bearer ${ENV_KEY}`);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers.Prefer, 'return=minimal');
  });

  test('a trailing slash on SUPABASE_URL does not produce a doubled path', async () => {
    const fetchStub = stubFetch();
    await call({ body: valid(), env: { SUPABASE_URL: 'https://project.supabase.co/' } });

    assert.equal(fetchStub.calls[0].url, 'https://project.supabase.co/rest/v1/lead_submissions');
  });

  test('fills the NOT NULL columns and defaults status to new', async () => {
    const fetchStub = stubFetch();
    await call({ body: valid() });

    const row = fetchStub.calls[0].body;
    assert.equal(row.site, 'negotiatorcruz');
    assert.equal(row.form_type, 'contact');
    assert.equal(row.status, 'new');
  });

  test('an omitted phone is stored as NULL, not an empty string', async () => {
    const fetchStub = stubFetch();
    await call({ body: valid() });
    assert.equal(fetchStub.calls[0].body.phone, null);
  });

  test('a supplied phone is kept', async () => {
    const fetchStub = stubFetch();
    await call({ body: valid({ phone: '+1 312 555 0142' }) });
    assert.equal(fetchStub.calls[0].body.phone, '+1 312 555 0142');
  });

  test('surrounding whitespace is trimmed off every field', async () => {
    const fetchStub = stubFetch();
    await call({ body: valid({ name: '  Dana Reyes  ', phone: '  312  ' }) });

    const row = fetchStub.calls[0].body;
    assert.equal(row.name, 'Dana Reyes');
    assert.equal(row.phone, '312');
  });

  describe('length limits', () => {
    for (const [field, max] of [
      ['name', 120],
      ['phone', 40],
      ['message', 4000],
    ]) {
      test(`${field} is truncated to ${max} characters`, async () => {
        const fetchStub = stubFetch();
        const res = await call({ body: valid({ [field]: 'a'.repeat(max + 50) }) });

        assert.equal(res.statusCode, 200);
        assert.equal(fetchStub.calls[0].body[field].length, max);
      });
    }

    test('email is truncated to 200 characters', async () => {
      const fetchStub = stubFetch();
      // Long in the domain, so it survives the cut as a valid-looking address.
      const res = await call({ body: valid({ email: 'dana@example.' + 'c'.repeat(300) }) });

      assert.equal(res.statusCode, 200);
      assert.equal(fetchStub.calls[0].body.email.length, 200);
    });

    test('an over-long email is rejected as malformed, not as too long', async () => {
      // `clean()` runs before `looksLikeEmail()`, so truncation can cut the
      // "@" off an address and the visitor is told it "doesn't look right".
      // Harmless at 200 chars (RFC 5321 caps a path at 256), but the ordering
      // is deliberate and worth pinning: shrinking MAX.email would start
      // rejecting ordinary addresses with a confusing message.
      const fetchStub = stubFetch();
      const res = await call({ body: valid({ email: 'a'.repeat(250) + '@example.com' }) });

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, "That email address doesn't look right.");
      assert.equal(fetchStub.calls.length, 0);
    });

    test('context fields are truncated to 400 characters', async () => {
      const fetchStub = stubFetch();
      await call({ body: valid({ company: 'c'.repeat(600) }) });

      assert.equal(fetchStub.calls[0].body.props.company.length, 400);
    });
  });
});

describe('context block and props', () => {
  const context = {
    offer: 'keynote',
    company: 'Acme Corp',
    team_size: '12 reps',
    timeline: 'Q4 kickoff',
    page: '/contact?offer=keynote',
    referrer: 'https://negotiatorcruz.com/speaking',
  };

  test('renders the context above the note in a fixed order', async () => {
    const fetchStub = stubFetch();
    await call({ body: valid({ ...context, message: 'We stall on price.' }) });

    assert.equal(
      fetchStub.calls[0].body.message,
      [
        'Offer: keynote',
        'Company: Acme Corp',
        'Team size: 12 reps',
        'Timeline: Q4 kickoff',
        'Page: /contact?offer=keynote',
        'Referrer: https://negotiatorcruz.com/speaking',
        '---',
        'We stall on price.',
      ].join('\n')
    );
  });

  test('maps every context label to a snake_case props key', async () => {
    const fetchStub = stubFetch();
    await call({ body: valid(context) });

    assert.deepEqual(fetchStub.calls[0].body.props, {
      offer: 'keynote',
      company: 'Acme Corp',
      team_size: '12 reps',
      timeline: 'Q4 kickoff',
      page: '/contact?offer=keynote',
      referrer: 'https://negotiatorcruz.com/speaking',
    });
  });

  test('omits blank context fields instead of storing empty values', async () => {
    const fetchStub = stubFetch();
    await call({ body: valid({ offer: 'keynote', company: '', timeline: '   ' }) });

    const row = fetchStub.calls[0].body;
    assert.deepEqual(row.props, { offer: 'keynote' });
    assert.equal(row.message, 'Offer: keynote\n---\n(no message)');
  });

  test('a bare note with no context has no separator', async () => {
    const fetchStub = stubFetch();
    await call({ body: valid({ message: 'Just this.' }) });

    assert.equal(fetchStub.calls[0].body.message, 'Just this.');
    assert.deepEqual(fetchStub.calls[0].body.props, {});
  });

  test('an empty submission still records a readable placeholder', async () => {
    const fetchStub = stubFetch();
    await call({ body: valid() });
    assert.equal(fetchStub.calls[0].body.message, '(no message)');
  });
});

describe('failure paths', () => {
  test('a PostgREST error becomes a 502 with a generic message', async () => {
    stubFetch({ ok: false, status: 401, text: 'permission denied for table lead_submissions' });
    const res = await call({ body: valid() });

    assert.equal(res.statusCode, 502);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /Something broke on our end/);
  });

  test('a thrown fetch becomes a 500 with a generic message', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED 10.0.0.1:443');
    });
    const res = await call({ body: valid() });

    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /Something broke on our end/);
  });

  test('both failure paths point the visitor at email', async () => {
    stubFetch({ ok: false, status: 500, text: 'boom' });
    const upstream = await call({ body: valid() });

    stubFetch(() => {
      throw new Error('boom');
    });
    const thrown = await call({ body: valid() });

    for (const res of [upstream, thrown]) {
      assert.match(res.body.error, /negotiatorsondemand@gmail\.com/);
    }
  });

  test('upstream detail is logged server-side, never returned', async () => {
    const detail = 'duplicate key value violates unique constraint "lead_submissions_pkey"';
    stubFetch({ ok: false, status: 409, text: detail });

    const res = await call({ body: valid() });

    assert.match(res.logged, /supabase insert failed/);
    assert.match(res.logged, /409/);
    assert.ok(res.logged.includes(detail), 'the detail belongs in the server log');
    assert.ok(
      !JSON.stringify(res.body).includes(detail),
      'the detail must not reach the browser'
    );
  });
});

describe('secret handling', () => {
  test('no response body on any path contains the service-role key', async () => {
    const responses = [];

    stubFetch();
    responses.push(await call({ body: valid() }));
    responses.push(await call({ method: 'GET' }));
    responses.push(await call({ body: { name: '', email: '' } }));
    responses.push(await call({ body: valid({ email: 'nope' }) }));
    responses.push(await call({ body: valid(), noEnv: true }));

    stubFetch({ ok: false, status: 500, text: `key=${ENV_KEY}` });
    responses.push(await call({ body: valid() }));

    stubFetch(() => {
      throw new Error(`connect failed using ${ENV_KEY}`);
    });
    responses.push(await call({ body: valid() }));

    for (const res of responses) {
      const serialised = JSON.stringify(res.body || {});
      assert.ok(!serialised.includes(ENV_KEY), `leaked the service key in: ${serialised}`);
      assert.ok(!serialised.includes('supabase.co'), `leaked the project URL in: ${serialised}`);
    }
  });

  test('every response is the documented { ok } envelope', async () => {
    stubFetch();
    const ok = await call({ body: valid() });
    const bad = await call({ body: {} });

    assert.deepEqual(Object.keys(ok.body), ['ok']);
    assert.equal(ok.body.ok, true);
    assert.deepEqual(Object.keys(bad.body).sort(), ['error', 'ok']);
    assert.equal(bad.body.ok, false);
    assert.equal(typeof bad.body.error, 'string');
  });
});

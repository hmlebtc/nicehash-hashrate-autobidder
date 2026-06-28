import { describe, expect, it } from 'vitest';

import {
  buildSignatureMessage,
  createSignedHeaders,
  signRequest,
  toQueryString,
  type NiceHashCredentials,
} from './auth.js';

const CREDS: NiceHashCredentials = {
  apiKey: 'apikey123',
  apiSecret: 'apisecret456',
  orgId: 'org789',
};

const NUL = String.fromCharCode(0);

describe('buildSignatureMessage', () => {
  it('joins fields with NUL in the NiceHash field order (no body)', () => {
    const msg = buildSignatureMessage(CREDS, {
      method: 'GET',
      path: '/main/api/v2/hashpower/myOrders',
      query: 'algorithm=SHA256&market=EU',
      time: 1700000000000,
      nonce: 'nonce-abc',
    });
    expect(msg).toBe(
      [
        'apikey123',
        '1700000000000',
        'nonce-abc',
        '',
        'org789',
        '',
        'GET',
        '/main/api/v2/hashpower/myOrders',
        'algorithm=SHA256&market=EU',
      ].join(NUL),
    );
  });

  it('appends the body after one more NUL when present', () => {
    const body = '{"market":"EU","algorithm":"SHA256"}';
    const msg = buildSignatureMessage(CREDS, {
      method: 'POST',
      path: '/main/api/v2/hashpower/order/',
      query: '',
      body,
      time: 1700000000000,
      nonce: 'nonce-abc',
    });
    expect(msg.endsWith(NUL + body)).toBe(true);
  });

  it('does not append an empty body', () => {
    const msg = buildSignatureMessage(CREDS, {
      method: 'POST',
      path: '/x',
      query: '',
      body: '',
      time: 1,
      nonce: 'n',
    });
    // Fields end with the (empty) query field; no trailing body NUL.
    expect(msg).toBe(['apikey123', '1', 'n', '', 'org789', '', 'POST', '/x', ''].join(NUL));
  });
});

describe('signRequest', () => {
  // Reference digests computed from the official NiceHash rest-clients-demo
  // signing algorithm (Python), pinned here so any drift in the field order
  // or HMAC handling fails loudly.
  it('matches the reference HMAC for a signed GET', () => {
    expect(
      signRequest(CREDS, {
        method: 'GET',
        path: '/main/api/v2/hashpower/myOrders',
        query: 'algorithm=SHA256&market=EU',
        time: 1700000000000,
        nonce: 'nonce-abc',
      }),
    ).toBe('apikey123:e4b137424c7153768ecf12957f4dc5660e194478ec72c6487bc2d2c543eb796d');
  });

  it('matches the reference HMAC for a signed POST with body', () => {
    expect(
      signRequest(CREDS, {
        method: 'POST',
        path: '/main/api/v2/hashpower/order/',
        query: '',
        body: '{"market":"EU","algorithm":"SHA256"}',
        time: 1700000000000,
        nonce: 'nonce-abc',
      }),
    ).toBe('apikey123:850e3e0c1a8e3b9df16eeeb73ac8eadcfbedeaa3137945bd1ebf5d8ed202105e');
  });
});

describe('createSignedHeaders', () => {
  it('emits the full NiceHash header set with the X-Auth digest', () => {
    const headers = createSignedHeaders(CREDS, {
      method: 'GET',
      path: '/main/api/v2/hashpower/myOrders',
      query: 'algorithm=SHA256&market=EU',
      time: 1700000000000,
      nonce: 'nonce-abc',
      requestId: 'req-1',
    });
    expect(headers).toEqual({
      'X-Time': '1700000000000',
      'X-Nonce': 'nonce-abc',
      'X-Auth': 'apikey123:e4b137424c7153768ecf12957f4dc5660e194478ec72c6487bc2d2c543eb796d',
      'X-Organization-Id': 'org789',
      'X-Request-Id': 'req-1',
      'Content-Type': 'application/json',
    });
  });
});

describe('toQueryString', () => {
  it('serialises in insertion order and skips undefined/null', () => {
    expect(
      toQueryString({ algorithm: 'SHA256', market: 'EU', ts: undefined, limit: 100, op: null }),
    ).toBe('algorithm=SHA256&market=EU&limit=100');
  });

  it('URI-encodes keys and values', () => {
    expect(toQueryString({ 'a b': 'c&d' })).toBe('a%20b=c%26d');
  });
});

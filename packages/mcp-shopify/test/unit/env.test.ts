import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env.js';

const DEV_VARS = {
  SHOPIFY_DEV_SHOP_DOMAIN: 'dev.myshopify.com',
  SHOPIFY_DEV_CLIENT_ID: 'dev-client',
  SHOPIFY_DEV_CLIENT_SECRET: 'dev-secret',
  SHOPIFY_DEV_API_VERSION: '2026-04',
};

const PROD_VARS = {
  SHOPIFY_PROD_SHOP_DOMAIN: 'prod.myshopify.com',
  SHOPIFY_PROD_CLIENT_ID: 'prod-client',
  SHOPIFY_PROD_CLIENT_SECRET: 'prod-secret',
  SHOPIFY_PROD_API_VERSION: '2025-07',
};

describe('loadEnv — SHOPIFY_ENV switch', () => {
  it('defaults to dev when SHOPIFY_ENV is unset', () => {
    const env = loadEnv({ ...DEV_VARS } as NodeJS.ProcessEnv);
    expect(env.mode).toBe('dev');
    expect(env.shopDomain).toBe('dev.myshopify.com');
    expect(env.clientId).toBe('dev-client');
    expect(env.clientSecret).toBe('dev-secret');
  });

  it('reads dev vars when SHOPIFY_ENV=dev', () => {
    const env = loadEnv({
      SHOPIFY_ENV: 'dev',
      ...DEV_VARS,
      ...PROD_VARS,
    } as NodeJS.ProcessEnv);
    expect(env.mode).toBe('dev');
    expect(env.shopDomain).toBe('dev.myshopify.com');
  });

  it('reads prod vars when SHOPIFY_ENV=prod', () => {
    const env = loadEnv({
      SHOPIFY_ENV: 'prod',
      ...DEV_VARS,
      ...PROD_VARS,
    } as NodeJS.ProcessEnv);
    expect(env.mode).toBe('prod');
    expect(env.shopDomain).toBe('prod.myshopify.com');
    expect(env.clientId).toBe('prod-client');
    expect(env.clientSecret).toBe('prod-secret');
    expect(env.apiVersion).toBe('2025-07');
  });

  it('case-insensitive on SHOPIFY_ENV', () => {
    const env = loadEnv({
      SHOPIFY_ENV: 'PROD',
      ...PROD_VARS,
    } as NodeJS.ProcessEnv);
    expect(env.mode).toBe('prod');
  });

  it('throws when SHOPIFY_ENV is invalid', () => {
    expect(() =>
      loadEnv({ SHOPIFY_ENV: 'staging', ...DEV_VARS } as NodeJS.ProcessEnv),
    ).toThrow(/Invalid SHOPIFY_ENV/);
  });

  it('throws when SHOPIFY_ENV=prod but prod credentials are missing', () => {
    expect(() =>
      loadEnv({ SHOPIFY_ENV: 'prod', ...DEV_VARS } as NodeJS.ProcessEnv),
    ).toThrow(/SHOPIFY_PROD_SHOP_DOMAIN/);
  });

  it('throws when dev credentials are missing in default mode', () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(
      /SHOPIFY_DEV_SHOP_DOMAIN/,
    );
  });

  it('enables customer identity mode when verified identity is required', () => {
    const env = loadEnv({
      ...DEV_VARS,
      SHOPIFY_MCP_REQUIRE_VERIFIED_IDENTITY: 'true',
      SHOPIFY_MCP_IDENTITY_SECRET: 'test-secret',
    } as NodeJS.ProcessEnv);
    expect(env.identity.mode).toBe('required');
    expect(env.requireVerifiedIdentity).toBe(true);
  });

  it('keeps admin/operator identity mode when verified identity is not required', () => {
    const env = loadEnv({ ...DEV_VARS } as NodeJS.ProcessEnv);
    expect(env.identity.mode).toBe('disabled');
    expect(env.requireVerifiedIdentity).toBe(false);
  });

  it('rejects required customer identity mode without a signing secret', () => {
    expect(() =>
      loadEnv({
        ...DEV_VARS,
        SHOPIFY_MCP_REQUIRE_VERIFIED_IDENTITY: 'true',
      } as NodeJS.ProcessEnv),
    ).toThrow(/SHOPIFY_MCP_REQUIRE_VERIFIED_IDENTITY=true requires/);
  });
});

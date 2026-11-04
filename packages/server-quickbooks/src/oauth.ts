import { PorterError, UpstreamError, type HttpClient } from '@abhijoshi23/porter-toolkit';
import * as z from 'zod/v4';

/**
 * Intuit OAuth 2.0 (authorization code grant). Endpoints are from Intuit's discovery
 * document (developer.api.intuit.com/.well-known/openid_configuration); the same ones serve
 * sandbox and production. Intuit doesn't advertise PKCE, so this is the confidential-client
 * flow: client secret on the token endpoint, plus `state` against CSRF.
 */
export const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
/** Read and write access to the books; no payments, payroll or OpenID profile. */
export const SCOPE = 'com.intuit.quickbooks.accounting';

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const tokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  /** Seconds; one hour today. */
  expires_in: z.number(),
  /** Seconds until the refresh token lapses if unused (rolling, 100 days today). */
  x_refresh_token_expires_in: z.number().optional(),
});

export interface Tokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt?: number;
}

/** The refresh token was rejected (revoked, expired or rotated away): the user must connect again. */
export class ReauthorizeError extends PorterError {
  constructor(detail: string) {
    super(`QuickBooks rejected the saved connection (${detail}).`, {
      hint: 'Tell the user to reconnect by running `porter-quickbooks auth` in a terminal, then try again.',
    });
  }
}

export function authorizeUrl(app: OAuthApp, state: string): string {
  const u = new URL(AUTHORIZE_URL);
  u.search = new URLSearchParams({
    client_id: app.clientId,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: app.redirectUri,
    state,
  }).toString();
  return u.toString();
}

async function tokenRequest(
  http: HttpClient,
  app: OAuthApp,
  form: Record<string, string>,
  now: number,
): Promise<Tokens> {
  const res = await http
    .request(TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
    })
    .catch((err: unknown) => {
      // invalid_grant comes back as HTTP 400: the grant is dead, not the request malformed.
      if (err instanceof UpstreamError && (err.status === 400 || err.status === 401)) {
        throw new ReauthorizeError('invalid_grant');
      }
      throw err;
    });
  const t = tokenResponse.parse(await res.json());
  return {
    accessToken: t.access_token,
    // A minute early, so a token never expires between our check and Intuit's.
    accessExpiresAt: now + (t.expires_in - 60) * 1000,
    refreshToken: t.refresh_token,
    ...(t.x_refresh_token_expires_in
      ? { refreshExpiresAt: now + t.x_refresh_token_expires_in * 1000 }
      : {}),
  };
}

export function exchangeCode(http: HttpClient, app: OAuthApp, code: string, now: number) {
  return tokenRequest(
    http,
    app,
    { grant_type: 'authorization_code', code, redirect_uri: app.redirectUri },
    now,
  );
}

export function refreshTokens(http: HttpClient, app: OAuthApp, refreshToken: string, now: number) {
  return tokenRequest(http, app, { grant_type: 'refresh_token', refresh_token: refreshToken }, now);
}

/** Revoking the refresh token also ends every access token issued from it. */
export async function revoke(http: HttpClient, app: OAuthApp, refreshToken: string): Promise<void> {
  await http.request(REVOKE_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ token: refreshToken }),
  });
}

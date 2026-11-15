import {
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import {
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

/**
 * OAuth 2.1 resource-server mode (MCP authorization, 2025-06-18 onwards). Porter never
 * issues tokens: a hosted authorization server (WorkOS AuthKit, Auth0, Keycloak…) does,
 * and the server only checks them. See ADR-005.
 */
export interface ResourceServerOptions {
  /** The authorization server's issuer, exactly as it appears in the token's `iss`. */
  issuer: string;
  /**
   * This server's public MCP URL, e.g. `https://porter-demo.example.workers.dev/mcp-auth`.
   * It is the RFC 8707 resource identifier: tokens must name it in `aud`, which stops a
   * token minted for another service being replayed here.
   */
  resource: URL;
  /** Signing keys. Default: `jwks_uri` from the issuer's metadata document. */
  jwksUrl?: URL;
  /** Scopes every request needs (403 `insufficient_scope` otherwise). */
  requiredScopes?: string[];
  /** Advertised in the metadata document. */
  scopesSupported?: string[];
  resourceName?: string;
  documentationUrl?: URL;
  /** Injected in tests. */
  fetch?: typeof fetch;
  /** Injected in tests: a local key set instead of a remote one. */
  keys?: JWTVerifyGetKey;
}

const ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'];

/**
 * Verifies JWT access tokens: signature against the issuer's published keys, `iss`, `aud`
 * (this resource), `exp`/`nbf`, and only asymmetric algorithms (so `alg: none` or an HS256
 * token signed with a public key is refused).
 */
export function jwtVerifier(o: ResourceServerOptions): OAuthTokenVerifier {
  let keys: Promise<JWTVerifyGetKey> | undefined;
  const getKeys = () =>
    (keys ??= (async () =>
      o.keys ??
      createRemoteJWKSet(o.jwksUrl ?? (await discoverJwks(o.issuer, o.fetch ?? fetch)), {
        cacheMaxAge: 10 * 60_000,
        cooldownDuration: 30_000,
        ...(o.fetch ? { [customFetch]: o.fetch } : {}),
      }))().catch((err: unknown) => {
      keys = undefined; // retry discovery on the next request
      throw err;
    }));

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, await getKeys(), {
          issuer: o.issuer,
          audience: o.resource.href,
          algorithms: ALGORITHMS,
          clockTolerance: 30,
          requiredClaims: ['exp'],
        }));
      } catch (err) {
        if (err instanceof joseErrors.JOSEError) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, describe(err));
        }
        // Key discovery failed: our problem, not the client's token.
        throw new OAuthError(OAuthErrorCode.ServerError, 'Could not load the signing keys.');
      }
      return {
        token,
        clientId: str(payload.client_id) ?? str(payload.azp) ?? str(payload.sub) ?? 'unknown',
        scopes: scopesOf(payload),
        expiresAt: payload.exp,
        resource: o.resource,
        extra: { subject: payload.sub },
      };
    },
  };
}

/** RFC 9728 Protected Resource Metadata for this server. */
export function protectedResourceMetadata(o: ResourceServerOptions) {
  return {
    resource: o.resource.href,
    authorization_servers: [o.issuer],
    bearer_methods_supported: ['header'],
    ...(o.scopesSupported ? { scopes_supported: o.scopesSupported } : {}),
    ...(o.resourceName ? { resource_name: o.resourceName } : {}),
    ...(o.documentationUrl ? { resource_documentation: o.documentationUrl.href } : {}),
  };
}

/** Where the metadata document is served: the well-known prefix inserted before the path. */
export function protectedResourceMetadataUrl(o: Pick<ResourceServerOptions, 'resource'>): URL {
  return new URL(getOAuthProtectedResourceMetadataUrl(o.resource));
}

/** RFC 8414 first, then OpenID discovery (Auth0 and Keycloak publish both, some only one). */
async function discoverJwks(issuer: string, fetchFn: typeof fetch): Promise<URL> {
  const base = issuer.replace(/\/$/, '');
  for (const doc of [
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
  ]) {
    const res = await fetchFn(`${base}${doc}`, { headers: { accept: 'application/json' } });
    if (!res.ok) continue;
    const meta = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown };
    // RFC 8414 §3.3: the document must name the issuer we asked about.
    if (meta.issuer !== issuer && meta.issuer !== base) continue;
    if (typeof meta.jwks_uri === 'string') return new URL(meta.jwks_uri);
  }
  throw new Error(`No jwks_uri found in ${issuer}'s metadata.`);
}

function scopesOf(p: JWTPayload): string[] {
  if (typeof p.scope === 'string') return p.scope.split(' ').filter(Boolean);
  if (Array.isArray(p.scp)) return p.scp.filter((s): s is string => typeof s === 'string');
  if (Array.isArray(p.permissions)) {
    return p.permissions.filter((s): s is string => typeof s === 'string'); // Auth0 RBAC
  }
  return [];
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Says which check failed without echoing token contents. */
function describe(err: InstanceType<typeof joseErrors.JOSEError>): string {
  if (err instanceof joseErrors.JWTExpired) return 'The access token has expired.';
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'aud') return 'The access token was not issued for this server.';
    if (err.claim === 'iss') return 'The access token is from an unexpected issuer.';
    return `The access token's "${err.claim}" claim is invalid.`;
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return 'The access token signature is invalid.';
  }
  if (err instanceof joseErrors.JOSEAlgNotAllowed) {
    return 'The access token uses an algorithm this server does not accept.';
  }
  if (err instanceof joseErrors.JWKSNoMatchingKey)
    return 'The access token was signed with an unknown key.';
  return 'The access token is invalid.';
}

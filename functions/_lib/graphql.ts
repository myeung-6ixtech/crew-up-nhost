type GraphqlError = {
  message: string;
  extensions?: {
    code?: string;
    /**
     * Hasura reports Postgres failures as a bare "database query error" and puts
     * the real cause in here. Only the message and SQLSTATE are surfaced; the
     * sibling `arguments` and `statement` fields echo row data back and are
     * deliberately left out of the thrown error.
     */
    internal?: {
      error?: { message?: string; status_code?: string };
    };
  };
};

type GraphqlBody<T> = {
  data?: T;
  errors?: GraphqlError[];
};

function describeError(error: GraphqlError): string {
  const detail = error.extensions?.internal?.error;
  if (!detail?.message) {
    return error.message;
  }
  const sqlState = detail.status_code ? ` (SQLSTATE ${detail.status_code})` : '';
  return `${error.message}: ${detail.message}${sqlState}`;
}

/**
 * Matches the `local`/`localhost` subdomains used by `nhost up`, optionally
 * prefixed with a protocol and suffixed with a port.
 */
const LOCAL_SUBDOMAIN_PATTERN = /^(?:(https?):\/\/)?(localhost|local)(?::(\d+))?$/;

type NhostService = 'graphql' | 'storage';

const EXPLICIT_URL_ENV: Record<NhostService, string> = {
  graphql: 'NHOST_GRAPHQL_URL',
  storage: 'NHOST_STORAGE_URL',
};

/**
 * Resolves an Nhost service base URL from the environment Nhost injects into
 * every function. `NHOST_GRAPHQL_URL` / `NHOST_STORAGE_URL` win when set so
 * local overrides and self-hosted deployments keep working.
 */
export function nhostServiceUrl(service: NhostService): string {
  const explicit = process.env[EXPLICIT_URL_ENV[service]]?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const subdomain = process.env.NHOST_SUBDOMAIN?.trim();
  if (!subdomain) {
    throw new Error('Missing Nhost client environment variables');
  }

  const local = LOCAL_SUBDOMAIN_PATTERN.exec(subdomain);
  if (local) {
    const [, protocol, host, port] = local;
    if (host === 'localhost') {
      return `${protocol ?? 'http'}://localhost:${port ?? '1337'}/v1/${service}`;
    }
    const authority = port
      ? `local.${service}.local.nhost.run:${port}`
      : `local.${service}.local.nhost.run`;
    return `${protocol ?? 'https'}://${authority}/v1`;
  }

  const region = process.env.NHOST_REGION?.trim();
  if (!region) {
    throw new Error('Missing Nhost client environment variables');
  }
  return `https://${subdomain}.${service}.${region}.nhost.run/v1`;
}

function graphqlEndpoint(): string {
  return nhostServiceUrl('graphql');
}

async function executeGraphql<T>(
  query: string,
  variables: Record<string, unknown> | undefined,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetch(graphqlEndpoint(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`GraphQL request failed with status ${response.status}: ${raw.slice(0, 500)}`);
  }

  let body: GraphqlBody<T>;
  try {
    body = JSON.parse(raw) as GraphqlBody<T>;
  } catch {
    throw new Error(`GraphQL response was not valid JSON: ${raw.slice(0, 500)}`);
  }

  if (body.errors?.length) {
    throw new Error(body.errors.map(describeError).join('; '));
  }

  if (!body.data) {
    throw new Error('GraphQL response missing data');
  }

  return body.data;
}

export async function graphqlAsAdmin<T>(
  query: string,
  variables?: Record<string, unknown>,
  role = 'service',
): Promise<T> {
  const adminSecret = process.env.NHOST_ADMIN_SECRET?.trim();
  if (!adminSecret) {
    throw new Error('Missing Nhost admin client environment variables');
  }

  return executeGraphql<T>(query, variables, {
    'x-hasura-admin-secret': adminSecret,
    'x-hasura-role': role,
  });
}

export async function graphqlAsUser<T>(
  query: string,
  authorization: string,
  variables?: Record<string, unknown>,
  role?: string,
): Promise<T> {
  const headers: Record<string, string> = { authorization };
  if (role) {
    headers['x-hasura-role'] = role;
  }

  return executeGraphql<T>(query, variables, headers);
}

export async function graphqlRaw<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  return graphqlAsAdmin<T>(query, variables, 'service');
}

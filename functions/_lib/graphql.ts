type GraphqlBody<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

/**
 * Matches the `local`/`localhost` subdomains used by `nhost up`, optionally
 * prefixed with a protocol and suffixed with a port.
 */
const LOCAL_SUBDOMAIN_PATTERN = /^(?:(https?):\/\/)?(localhost|local)(?::(\d+))?$/;

/**
 * Resolves the Hasura GraphQL endpoint from the environment Nhost injects into
 * every function. `NHOST_GRAPHQL_URL` wins when set so local overrides and
 * self-hosted deployments keep working.
 */
function graphqlEndpoint(): string {
  const explicit = process.env.NHOST_GRAPHQL_URL?.trim();
  if (explicit) return explicit;

  const subdomain = process.env.NHOST_SUBDOMAIN?.trim();
  if (!subdomain) {
    throw new Error('Missing Nhost client environment variables');
  }

  const local = LOCAL_SUBDOMAIN_PATTERN.exec(subdomain);
  if (local) {
    const [, protocol, host, port] = local;
    if (host === 'localhost') {
      return `${protocol ?? 'http'}://localhost:${port ?? '1337'}/v1/graphql`;
    }
    const authority = port
      ? `local.graphql.local.nhost.run:${port}`
      : 'local.graphql.local.nhost.run';
    return `${protocol ?? 'https'}://${authority}/v1`;
  }

  const region = process.env.NHOST_REGION?.trim();
  if (!region) {
    throw new Error('Missing Nhost client environment variables');
  }
  return `https://${subdomain}.graphql.${region}.nhost.run/v1`;
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
    throw new Error(body.errors.map((error) => error.message).join('; '));
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

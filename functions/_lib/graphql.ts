import { createClient, withAdminSession } from '@nhost/nhost-js';

type GraphqlBody<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

function createAdminClient() {
  const adminSecret = process.env.NHOST_ADMIN_SECRET;
  const region = process.env.NHOST_REGION;
  const subdomain = process.env.NHOST_SUBDOMAIN;

  if (!adminSecret || !region || !subdomain) {
    throw new Error('Missing Nhost admin client environment variables');
  }

  return createClient({
    region,
    subdomain,
    configure: [
      withAdminSession({
        adminSecret,
      }),
    ],
  });
}

function createUserClient(authorization: string) {
  const region = process.env.NHOST_REGION;
  const subdomain = process.env.NHOST_SUBDOMAIN;

  if (!region || !subdomain) {
    throw new Error('Missing Nhost client environment variables');
  }

  return createClient({
    region,
    subdomain,
  });
}

export async function graphqlAsAdmin<T>(
  query: string,
  variables?: Record<string, unknown>,
  role = 'service',
): Promise<T> {
  const nhost = createAdminClient();
  const { body } = await nhost.graphql.request<GraphqlBody<T>>(
    {
      query,
      variables,
    },
    {
      headers: {
        'x-hasura-role': role,
      },
    },
  );

  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join('; '));
  }

  if (!body.data) {
    throw new Error('GraphQL response missing data');
  }

  return body.data;
}

export async function graphqlAsUser<T>(
  query: string,
  authorization: string,
  variables?: Record<string, unknown>,
  role?: string,
): Promise<T> {
  const nhost = createUserClient(authorization);
  const headers: Record<string, string> = {
    Authorization: authorization,
  };
  if (role) {
    headers['x-hasura-role'] = role;
  }

  const { body } = await nhost.graphql.request<GraphqlBody<T>>(
    {
      query,
      variables,
    },
    {
      headers,
    },
  );

  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join('; '));
  }

  if (!body.data) {
    throw new Error('GraphQL response missing data');
  }

  return body.data;
}

export async function graphqlRaw<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  return graphqlAsAdmin<T>(query, variables, 'service');
}

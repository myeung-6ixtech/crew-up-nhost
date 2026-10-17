import type { Request, Response } from 'express';
import { requireUser } from '../../_lib/auth.js';
import { graphqlAsUser, graphqlRaw } from '../../_lib/graphql.js';
import { HttpError, sendClientError } from '../../_lib/httpError.js';

type BlockRow = { id: string; blocked_id: string; created_at: string };
type ProfileRow = {
  user_id: string;
  preferred_name: string | null;
  display_name: string | null;
  username: string | null;
  avatar_file_id: string | null;
};

/**
 * GET /v1/client/blocks/list — the caller's Blocked people, with names.
 * Profile permissions hide blocked people from the blocker too, so names are read as the service role,
 * limited to the ids the caller's own (user-role) read returned.
 */
export default async function listBlocks(req: Request, res: Response) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { authorization, userId } = requireUser(req);
    let blocks: BlockRow[];
    try {
      const data = await graphqlAsUser<{ user_blocks: BlockRow[] }>(
        `query MyBlocks($id: uuid!) {
          user_blocks(where: { blocker_id: { _eq: $id } }, order_by: { created_at: desc }) { id blocked_id created_at }
        }`,
        authorization,
        { id: userId },
      );
      blocks = data.user_blocks;
    } catch {
      throw new HttpError(401, 'UNAUTHORIZED', 'Sign in again to continue');
    }

    if (!blocks.length) return res.status(200).json({ blocks: [] });

    const { profiles } = await graphqlRaw<{ profiles: ProfileRow[] }>(
      `query BlockedProfiles($ids: [uuid!]!) {
        profiles(where: { user_id: { _in: $ids } }) { user_id preferred_name display_name username avatar_file_id }
      }`,
      { ids: blocks.map((block) => block.blocked_id) },
    );
    const byId = new Map(profiles.map((profile) => [profile.user_id, profile]));

    return res.status(200).json({
      blocks: blocks.map((block) => {
        const profile = byId.get(block.blocked_id);
        return {
          id: block.id,
          userId: block.blocked_id,
          createdAt: block.created_at,
          name: profile?.preferred_name || profile?.display_name || null,
          username: profile?.username ?? null,
          avatarFileId: profile?.avatar_file_id ?? null,
        };
      }),
    });
  } catch (error) {
    return sendClientError(res, error, 'client/blocks/list', 'BLOCKS_LIST_FAILED');
  }
}

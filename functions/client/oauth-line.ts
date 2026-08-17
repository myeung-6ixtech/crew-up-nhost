import type { Request, Response } from 'express';

export default function oauthLine(_req: Request, res: Response) {
  return res.status(501).json({
    status: 'not_implemented',
    provider: 'line',
    message: 'LINE OAuth bridge is planned; see documentation/nhost-prd.md §5.1',
  });
}

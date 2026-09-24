import type { Request, Response } from 'express';
import { getAppMode } from '../_lib/appMode.js';

/** GET /v1/public/app-config — public, cacheable ~60 s. Clients never assume "launched" on failure. */
export default function appConfig(req: Request, res: Response) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    res.set('Cache-Control', 'public, max-age=60');
    return res.status(200).json({ mode: getAppMode() });
  } catch (error) {
    console.error('public/app-config: invalid CREWUP_APP_MODE', error);
    res.set('Cache-Control', 'no-store');
    return res.status(503).json({ error: { code: 'APP_CONFIG_UNAVAILABLE', message: 'App config unavailable' } });
  }
}

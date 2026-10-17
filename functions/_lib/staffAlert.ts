/**
 * Emails the moderation inbox. Uses Resend's HTTP API when RESEND_API_KEY and STAFF_ALERT_EMAIL are set;
 * otherwise only logs, so a missing key never fails the user's request.
 */
export async function sendStaffAlert(subject: string, text: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const to = process.env.STAFF_ALERT_EMAIL?.trim();
  const from = process.env.STAFF_ALERT_FROM?.trim() || 'CrewUp Moderation <moderation@crewup.app>';
  if (!apiKey || !to) {
    console.info(JSON.stringify({ event: 'staff_alert.skipped', reason: 'not_configured', subject }));
    return false;
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: to.split(',').map((value) => value.trim()), subject, text }),
    });
    if (!response.ok) {
      console.error(JSON.stringify({ event: 'staff_alert.failed', status: response.status, subject }));
      return false;
    }
    return true;
  } catch (error) {
    console.error(JSON.stringify({ event: 'staff_alert.failed', message: error instanceof Error ? error.message : 'unknown', subject }));
    return false;
  }
}

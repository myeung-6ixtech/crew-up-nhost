/**
 * Strips personal data from roster text before it leaves CrewUp. Rosters are
 * schedules, so anything that identifies a person is noise to the extractor.
 * Rules are deliberately conservative: a false positive removes one line, a
 * false negative sends someone's name to a third party.
 */

const LABELLED_LINE =
  /^.*\b(name|employee|staff\s*(no|number|id)|emp\s*(no|id)|crew\s*(id|no|list)|personnel|pers\s*no|hotel|accommodation|address|phone|mobile|tel|email|passport|licen[cs]e|captain|first\s*officer|purser|cabin\s*manager)\b.*$/gim;

/** Crew-list rows such as "CP: TAN J" or "FO - LEE K". Requires the separator so duty codes stay. */
const CREW_ROLE_LINE = /^.*\b(CP|CPT|FO|SO|CM|PS|FA|CA|CC)\s*[:\-]\s*[A-Z].*$/gm;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** International or long local phone numbers; 4-digit times and flight numbers are untouched. */
const PHONE = /(?:\+|\b00)\d[\d\s().-]{7,}\d/g;

export function redactRosterText(text: string): { text: string; redactedLines: number } {
  let redactedLines = 0;
  const countLine = () => {
    redactedLines += 1;
    return '[redacted]';
  };

  const redacted = text
    .replace(LABELLED_LINE, countLine)
    .replace(CREW_ROLE_LINE, countLine)
    .replace(EMAIL, '[redacted]')
    .replace(PHONE, '[redacted]');

  return { text: redacted, redactedLines };
}

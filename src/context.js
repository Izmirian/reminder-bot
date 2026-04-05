/**
 * Build the reminder fire message — clean and minimal.
 */

export function buildContextualMessage(reminderText, category, timezone, notes, priority) {
  let msg = priority === 'urgent' ? `*URGENT: ${reminderText}*` : `*${reminderText}*`;
  if (notes) {
    msg += `\n${notes}`;
  }
  return msg;
}

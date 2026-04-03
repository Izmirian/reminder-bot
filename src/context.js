/**
 * Build the reminder fire message — clean and minimal.
 */

export function buildContextualMessage(reminderText, category, timezone, notes) {
  let msg = `*${reminderText}*`;
  if (notes) {
    msg += `\n${notes}`;
  }
  return msg;
}

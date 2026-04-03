/**
 * Context-aware message builder — clean, minimal reminder messages.
 */

export function buildContextualMessage(reminderText, category, timezone, notes) {
  let msg = `⏰ Reminder: *${reminderText}*`;
  if (notes) {
    msg += `\n📝 ${notes}`;
  }
  return msg;
}

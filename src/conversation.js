/**
 * Natural conversation responses for casual messages.
 * Returns a response string or null if the message isn't conversational.
 */

const greetings = [
  'Hey! 👋 How can I help? Set a reminder or send "menu" for options.',
  'Hi there! 👋 Need to set a reminder?',
  'Hello! 👋 Just type your reminder or send "menu".',
];

const howAreYou = [
  "I'm doing great, thanks for asking! 🤖 Ready to help with reminders.",
  "All good here! ⏰ Need to set a reminder?",
  "Running smoothly! 💪 What can I help you with?",
];

const thanks = [
  "You're welcome! 😊",
  "Happy to help! 👍",
  "Anytime! 😊",
  "No problem! Let me know if you need anything else.",
];

const goodMorning = [
  "Good morning! ☀️ Ready for the day? Send 'today' to see your reminders.",
  "Morning! 🌅 Want to see today's reminders? Just send 'today'.",
];

const goodNight = [
  "Good night! 🌙 Sleep well. I'll keep your reminders safe.",
  "Night! 🌙 I'll make sure to remind you tomorrow.",
];

const funny = [
  "I'm a reminder bot, not a philosopher 😄 But I can help you remember things!",
  "That's above my pay grade 😅 Want to set a reminder instead?",
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Check if a message is conversational and return a response.
 * Returns null if it's not a casual message.
 */
export function getConversationalResponse(text) {
  const lower = text.toLowerCase().trim();

  // Greetings (handled separately for menu — this is for variants)
  if (/^(hey|hi|hello|yo|sup|hola|what'?s up)\b/i.test(lower)) return null; // let menu handle these

  // How are you
  if (/how are (you|u)|how('?s| is) it going|what'?s up|how do you do/i.test(lower)) return pick(howAreYou);

  // Thanks
  if (/^(thanks?|thank you|thx|ty|cheers|appreciate it)/i.test(lower)) return pick(thanks);

  // Good morning/night
  if (/^good morning|^morning/i.test(lower)) return pick(goodMorning);
  if (/^good night|^night|^gn|^sleep well/i.test(lower)) return pick(goodNight);

  // Compliments
  if (/you'?re? (awesome|great|amazing|the best|cool|helpful)/i.test(lower)) return "Thanks! 😊 I try my best!";
  if (/good (bot|job)|nice|well done|perfect/i.test(lower)) return "Thanks! 😊 Anything else you need?";

  // Negative
  if (/^(no|nah|nope|not now|nothing|never ?mind|cancel)$/i.test(lower)) return "Okay! Let me know if you need anything. 👍";

  // Emojis only
  if (/^[👍👌😊😄🙏❤️💪✅🔥]+$/u.test(lower)) return "👍";

  // Yes/okay
  if (/^(yes|yeah|yep|ok|okay|sure|alright|sounds good|got it)$/i.test(lower)) return "👍 Let me know if you need to set a reminder!";

  // Who are you
  if (/who are you|what are you|what can you do/i.test(lower)) {
    return "I'm your personal reminder bot! 🤖\n\nI can:\n• Set reminders in natural language\n• Track recurring habits\n• Send daily briefings\n\nSend 'menu' to see all options!";
  }

  // Jokes
  if (/tell me a joke|joke|funny/i.test(lower)) {
    return "Why do programmers prefer dark mode? Because light attracts bugs! 🐛😄\n\nNeed to set a reminder?";
  }

  return null;
}

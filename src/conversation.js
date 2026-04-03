/**
 * Natural conversation responses for casual messages.
 * Returns a response string or null if the message isn't conversational.
 */

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

const casual = [
  "😄 Need to set a reminder? Just tell me what and when!",
  "I'm here to help with reminders! Send 'menu' for options. 🤖",
];

const questionResponse = [
  "I'm a reminder bot — I might not understand that! 🤖\nTry: \"remind me at 3pm to call dentist\"",
  "Not sure about that! But I can help with reminders. Send 'menu' for options. 😊",
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Keywords that indicate a message IS a reminder, not casual chat
const REMINDER_KEYWORDS = [
  'remind', 'reminder', 'alarm', 'notify', 'alert',
  'schedule', 'set', 'cancel', 'list', 'edit', 'delete',
  'every day', 'every week', 'every monday', 'every tuesday',
  'every wednesday', 'every thursday', 'every friday',
  'every saturday', 'every sunday',
  'call', 'email', 'buy', 'pick up', 'submit', 'send',
  'take', 'check', 'go to', 'meet', 'pay', 'book',
  'clean', 'cook', 'wash', 'finish', 'complete', 'start',
];

function hasReminderKeywords(text) {
  const lower = text.toLowerCase();
  return REMINDER_KEYWORDS.some(kw => lower.includes(kw));
}

function hasTimeSignal(text) {
  const lower = text.toLowerCase();
  return /\bat\s+\d|\bin\s+\d|\d+\s*(?:am|pm)|o'?clock|\bminute|\bhour|\bevery\s/i.test(lower);
}

/**
 * Check if a message is conversational and return a response.
 * Returns null if it's not a casual message (i.e., might be a reminder).
 */
export function getConversationalResponse(text) {
  const lower = text.toLowerCase().trim();
  const words = lower.split(/\s+/);
  const wordCount = words.length;

  // Greetings — handled by menu in the main handler, but catch variants here
  if (/^(hey|hi|hello|yo|sup|hola)\s*$/i.test(lower)) return null; // exact greetings → menu handler
  if (/^what'?s?\s*up/i.test(lower)) return null; // "what's up" → menu handler
  if (/^(wassup|whaddup|howdy|ayo|heya|heyy+|hii+|helloo+)/i.test(lower)) return null; // variants → menu handler

  // How are you — broad matching including typos
  if (/how\s*a?re?\s*(you|u|ya)|how('?s| is) it going|how do you do|how'?s everything|how you doing/i.test(lower)) return pick(howAreYou);

  // What are you doing / what's happening
  if (/what('?s| are) (you|u) (doing|up to)|what('?s| is) happening|what('?s| is) new/i.test(lower)) return pick(casual);

  // Thanks
  if (/^(thanks?|thank you|thx|ty|cheers|appreciate it|thankyou)/i.test(lower)) return pick(thanks);

  // Good morning/night/afternoon/evening
  if (/^good (morning|afternoon|evening)|^morning\b|^afternoon\b|^evening\b/i.test(lower)) return pick(goodMorning);
  if (/^good night|^night\b|^gn\b|^sleep well/i.test(lower)) return pick(goodNight);

  // Compliments
  if (/you'?re? (awesome|great|amazing|the best|cool|helpful|smart)/i.test(lower)) return "Thanks! 😊 I try my best!";
  if (/^(good (bot|job)|well done|perfect|great|awesome|amazing|excellent|brilliant)$/i.test(lower)) return "Thanks! 😊 Anything else you need?";

  // Negative / dismissive
  if (/^(no|nah|nope|not now|nothing|never ?mind|nm|nvm|forget it|stop)$/i.test(lower)) return "Okay! Let me know if you need anything. 👍";

  // Emojis only
  if (/^[\p{Emoji}\s]+$/u.test(lower) && !/\d/.test(lower)) return "👍";

  // Yes/okay/affirmative
  if (/^(yes|yeah|yep|yea|ok|okay|sure|alright|sounds good|got it|k|kk|bet|aight|word)$/i.test(lower)) return "👍 Let me know if you need to set a reminder!";

  // Casual reactions
  if (/^(lol|lmao|haha|hehe|rofl|😂|🤣|wow|omg|bruh|damn|dang|whoa|sheesh|no way)$/i.test(lower)) return pick(casual);

  // Who/what are you
  if (/who are you|what are you|what can you do|what do you do/i.test(lower)) {
    return "I'm your personal reminder bot! 🤖\n\nI can:\n• Set reminders in natural language\n• Track recurring habits\n• Send daily briefings\n\nSend 'menu' to see all options!";
  }

  // Jokes
  if (/tell me a joke|joke|funny|make me laugh/i.test(lower)) {
    return "Why do programmers prefer dark mode? Because light attracts bugs! 🐛😄\n\nNeed to set a reminder?";
  }

  // General questions (ends with ?) that don't have reminder keywords
  if (lower.endsWith('?') && !hasReminderKeywords(lower) && !hasTimeSignal(lower)) {
    return pick(questionResponse);
  }

  // Very short messages (1-2 words) without reminder signals
  if (wordCount <= 2 && !hasReminderKeywords(lower) && !hasTimeSignal(lower)) {
    // Don't respond — let it fall through to parser which will also reject it
    // unless it's a known command word
    const knownShort = ['list', 'view', 'today', 'help', 'menu', 'pause', 'resume', 'undo', 'repeat', 'again', 'summary', 'stats', 'weekly'];
    if (!knownShort.includes(lower)) {
      return pick(casual);
    }
  }

  return null;
}

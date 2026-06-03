'use strict';

/**
 * InBoxer rules engine — three-tier taxonomy.
 *
 *   Disposition  (File / Hold / Clean up / Unsorted)   ← what should happen
 *     └─ Group   (People, Work, Finance, …)            ← topical (File only)
 *         └─ Category (Receipts, Meetings, …)          ← the leaf folder
 *
 * Plus cross-cutting flags carried on every email: priority, and the
 * unsubscribe handles (http one-click / mailto) used for mass-unsubscribe.
 *
 * Pure rules over headers + subject. No body, no AI, no API key. Each email
 * also carries the *reasons* it was sorted, and a confidence level.
 */

// ---------------------------------------------------------------------------
// Taxonomy registry
// ---------------------------------------------------------------------------

const DISPOSITIONS = {
  file:     { name: 'File',     icon: '📂', order: 1, blurb: 'Keep & organise' },
  hold:     { name: 'Hold',     icon: '⏳', order: 2, blurb: 'Act soon' },
  cleanup:  { name: 'Clean up', icon: '🧹', order: 3, blurb: 'Review & delete' },
  unsorted: { name: 'Unsorted', icon: '❓', order: 4, blurb: 'Its own folder' },
};

const GROUPS = {
  people:   { name: 'People',         icon: '👤', order: 1 },
  work:     { name: 'Work',           icon: '💼', order: 2 },
  finance:  { name: 'Finance',        icon: '💳', order: 3 },
  shopping: { name: 'Shopping',       icon: '🛍️', order: 4 },
  travel:   { name: 'Travel',         icon: '✈️', order: 5 },
  accounts: { name: 'Accounts',       icon: '🔐', order: 6 },
  admin:    { name: 'Personal Admin', icon: '🏠', order: 7 },
  reading:  { name: 'Reading',        icon: '📰', order: 8 },
};

// Each leaf category. `expireDays` (Hold only) = after this age it graduates
// to Clean up / Expired.  Order is used purely for display.
const CATEGORIES = {
  // ---- FILE ----
  people_personal:   { name: 'Personal',            icon: '👤', disp: 'file', group: 'people',   prio: 'medium', order: 1 },
  people_colleagues: { name: 'Colleagues',          icon: '🧑‍💼', disp: 'file', group: 'people',  prio: 'medium', order: 2 },
  people_clients:    { name: 'Clients & External',  icon: '🤝', disp: 'file', group: 'people',   prio: 'medium', order: 3 },
  work_documents:    { name: 'Documents & Files',   icon: '📄', disp: 'file', group: 'work',     prio: 'medium', order: 1 },
  work_projects:     { name: 'Projects & Tasks',    icon: '📋', disp: 'file', group: 'work',     prio: 'medium', order: 2 },
  work_code:         { name: 'Code & Dev',          icon: '💻', disp: 'file', group: 'work',     prio: 'medium', order: 3 },
  finance_receipts:  { name: 'Receipts & Payments', icon: '🧾', disp: 'file', group: 'finance',  prio: 'medium', order: 1 },
  finance_bank:      { name: 'Bank & Statements',   icon: '🏦', disp: 'file', group: 'finance',  prio: 'medium', order: 2 },
  finance_invoices:  { name: 'Invoices',            icon: '📑', disp: 'file', group: 'finance',  prio: 'medium', order: 3 },
  finance_taxes:     { name: 'Taxes',               icon: '🧮', disp: 'file', group: 'finance',  prio: 'high',   order: 4 },
  finance_payroll:   { name: 'Payroll',             icon: '💵', disp: 'file', group: 'finance',  prio: 'medium', order: 5 },
  finance_insurance: { name: 'Insurance',           icon: '🛡️', disp: 'file', group: 'finance',  prio: 'medium', order: 6 },
  finance_invest:    { name: 'Investments',         icon: '📈', disp: 'file', group: 'finance',  prio: 'medium', order: 7 },
  shopping_orders:   { name: 'Order Records',       icon: '🧾', disp: 'file', group: 'shopping', prio: 'medium', order: 1 },
  shopping_returns:  { name: 'Returns & Refunds',   icon: '↩️', disp: 'file', group: 'shopping', prio: 'medium', order: 2 },
  travel_records:    { name: 'Trip Records',        icon: '🗺️', disp: 'file', group: 'travel',   prio: 'medium', order: 1 },
  accounts_notices:  { name: 'Account & Policy',    icon: '📜', disp: 'file', group: 'accounts', prio: 'low',    order: 1 },
  accounts_welcome:  { name: 'Welcome & Onboarding',icon: '👋', disp: 'file', group: 'accounts', prio: 'low',    order: 2 },
  admin_appointments:{ name: 'Appointments & Health',icon: '🩺', disp: 'file', group: 'admin',    prio: 'medium', order: 1 },
  admin_utilities:   { name: 'Utilities & Home',    icon: '🔌', disp: 'file', group: 'admin',     prio: 'medium', order: 2 },
  admin_government:  { name: 'Government & Civic',   icon: '🏛️', disp: 'file', group: 'admin',     prio: 'medium', order: 3 },
  admin_housing:     { name: 'Housing & Property',  icon: '🏡', disp: 'file', group: 'admin',     prio: 'medium', order: 4 },
  admin_education:   { name: 'Education & Courses',  icon: '🎓', disp: 'file', group: 'admin',     prio: 'medium', order: 5 },
  reading_saved:     { name: 'Saved Newsletters',   icon: '📚', disp: 'file', group: 'reading',   prio: 'low',    order: 1 },

  // ---- HOLD ----
  hold_respond:   { name: 'To Respond',              icon: '✍️', disp: 'hold', prio: 'high',   order: 1 },
  hold_awaiting:  { name: 'Awaiting Reply',          icon: '📤', disp: 'hold', prio: 'medium', order: 2 },
  hold_meetings:  { name: 'Upcoming Meetings & Events', icon: '📅', disp: 'hold', prio: 'high', order: 3, expireDays: 14 },
  hold_bills:     { name: 'Bills Due / To Pay',      icon: '💸', disp: 'hold', prio: 'high',   order: 4 },
  hold_transit:   { name: 'In Transit',              icon: '📦', disp: 'hold', prio: 'medium', order: 5, expireDays: 14 },
  hold_travel:    { name: 'Upcoming Travel',         icon: '🧳', disp: 'hold', prio: 'high',   order: 6, expireDays: 30 },
  hold_security:  { name: 'Security & Codes',        icon: '🔑', disp: 'hold', prio: 'high',   order: 7, expireDays: 1 },
  hold_reminders: { name: 'Reminders & Deadlines',   icon: '⏰', disp: 'hold', prio: 'medium', order: 8, expireDays: 7 },

  // ---- CLEAN UP ----
  clean_promotions:   { name: 'Promotions',    icon: '🏷️', disp: 'cleanup', prio: 'low', order: 1 },
  clean_newsletters:  { name: 'Newsletters',   icon: '📰', disp: 'cleanup', prio: 'low', order: 2 },
  clean_social:       { name: 'Social',        icon: '💬', disp: 'cleanup', prio: 'low', order: 3 },
  clean_notifications:{ name: 'Notifications', icon: '🔔', disp: 'cleanup', prio: 'low', order: 4 },
  clean_expired:      { name: 'Expired',       icon: '⌛', disp: 'cleanup', prio: 'low', order: 5 },
  clean_spam:         { name: 'Likely Spam',   icon: '🚫', disp: 'cleanup', prio: 'low', order: 6 },

  // ---- UNSORTED ----
  unsorted: { name: 'Unidentified', icon: '❓', disp: 'unsorted', prio: 'medium', order: 1 },
};

// ---------------------------------------------------------------------------
// Sender-domain knowledge (high-confidence signals)
// ---------------------------------------------------------------------------

const D = {
  social: ['facebook.com', 'facebookmail.com', 'twitter.com', 'x.com', 'instagram.com', 'mail.instagram.com',
    'linkedin.com', 'mail.linkedin.com', 'tiktok.com', 'pinterest.com', 'reddit.com', 'redditmail.com',
    'snapchat.com', 'meetup.com', 'nextdoor.com', 'quora.com', 'discord.com', 'tinder.com', 'bumble.com', 'hinge.co'],
  dev: ['github.com', 'gitlab.com', 'bitbucket.org', 'circleci.com', 'travis-ci.org', 'vercel.com',
    'netlify.com', 'npmjs.com', 'docker.com', 'sentry.io'],
  projects: ['atlassian.net', 'atlassian.com', 'asana.com', 'trello.com', 'linear.app', 'monday.com',
    'clickup.com', 'notion.so', 'basecamp.com', 'shortcut.com'],
  fileshare: ['docs.google.com', 'drive.google.com', 'dropbox.com', 'dropboxmail.com', 'box.com',
    'wetransfer.com', 'sharepoint.com', 'onedrive.com', 'figma.com'],
  chat: ['slack.com', 'slackmail.com', 'teams.microsoft.com', 'webex.com'],
  bank: ['chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'capitalone.com', 'hsbc.com',
    'barclays.co.uk', 'lloydsbank.com', 'natwest.com', 'santander.co.uk', 'monzo.com', 'starlingbank.com',
    'revolut.com', 'paypal.com', 'stripe.com', 'wise.com', 'americanexpress.com', 'amex.com'],
  shop: ['amazon.com', 'amazon.co.uk', 'ebay.com', 'etsy.com', 'shopify.com', 'order.apple.com',
    'asos.com', 'argos.co.uk', 'walmart.com', 'target.com', 'aliexpress.com'],
  travel: ['delta.com', 'united.com', 'aa.com', 'email.ba.com', 'ba.com', 'ryanair.com', 'easyjet.com',
    'klm.com', 'lufthansa.com', 'airbnb.com', 'booking.com', 'expedia.com', 'hotels.com', 'trainline.com',
    'uber.com', 'lyft.com', 'marriott.com', 'hilton.com'],
  calendar: ['calendly.com', 'zoom.us', 'meet.google.com', 'cal.com', 'eventbrite.com'],
  media: ['nytimes.com', 'washingtonpost.com', 'theguardian.com', 'bbc.co.uk', 'economist.com', 'medium.com',
    'substack.com', 'morningbrew.com', 'theverge.com', 'wired.com', 'bloomberg.com'],
};

const FREEMAIL = ['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com'];

const AUTOMATED_LOCAL = ['no-reply', 'noreply', 'no_reply', 'donotreply', 'do-not-reply', 'do_not_reply',
  'mailer-daemon', 'notifications', 'notification', 'news', 'newsletter', 'updates', 'alerts', 'mailer',
  'auto', 'automated', 'bounce', 'postmaster', 'mail', 'info', 'hello', 'team', 'support', 'service'];

const DEADLINE_WORDS = ['urgent', 'asap', 'action required', 'response needed', 'please reply', 'due',
  'deadline', 'expires', 'final notice', 'last chance', 'overdue', 'reminder'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseAddress(raw) {
  if (!raw) return { name: '', address: '', domain: '', local: '' };
  const m = raw.match(/<([^>]+)>/);
  const address = (m ? m[1] : raw).trim().toLowerCase();
  let name = raw.replace(/<[^>]+>/, '').replace(/"/g, '').trim();
  if (!name) name = address.split('@')[0];
  const domain = address.includes('@') ? address.split('@')[1] : '';
  return { name, address, domain, local: address.split('@')[0] || '' };
}

const inList = (domain, list) => list.some((d) => domain === d || domain.endsWith('.' + d));
const kwHit = (hay, list) => { for (const k of list) if (hay.includes(k)) return k; return null; };

function ageDays(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return 0;
  return (Date.now() - d.getTime()) / 86400000;
}

function unsubHandles(listUnsub, listUnsubPost) {
  const out = { url: null, mailto: null, oneClick: false };
  if (listUnsub) {
    const http = listUnsub.match(/<(https?:\/\/[^>]+)>/i);
    const mail = listUnsub.match(/<mailto:([^>]+)>/i);
    if (http) out.url = http[1];
    if (mail) out.mailto = mail[1];
  }
  if (listUnsubPost && /one-?click/i.test(listUnsubPost) && out.url) out.oneClick = true;
  return out;
}

// ---------------------------------------------------------------------------
// Keyword sets
// ---------------------------------------------------------------------------

const KW = {
  security: ['verification code', 'security code', 'one-time', 'one time code', 'one-time passcode', 'otp',
    '2fa', 'two-factor', 'two factor', 'verify your', 'verification', 'confirm your email', 'security alert',
    'suspicious', 'unusual activity', 'unusual sign', 'new sign-in', 'new sign in', 'sign-in', 'signin',
    'single-use code', 'single use code', 'passcode', 'access code', 'your code is', 'your code:',
    'was added to your account', 'authenticate', 'login attempt', 'log-in attempt'],
  passwordReset: ['reset your password', 'password reset', 'forgot your password', 'set a new password'],
  meeting: ['invitation:', 'invite:', 'meeting', 'has been scheduled', 'is scheduled', 'rsvp', 'webinar',
    'calendar', 'join the call', 'zoom meeting', 'google meet', 'microsoft teams', 'appointment with', 'agenda for'],
  bills: ['payment due', 'amount due', 'past due', 'overdue', 'your bill', 'bill is ready', 'pay your',
    'payment reminder', 'invoice due', 'autopay', 'direct debit', 'balance due', 'minimum payment'],
  receipts: ['receipt', 'payment received', 'payment confirmation', 'you paid', 'thanks for your payment',
    'order receipt', 'your payment of', 'transaction'],
  statement: ['statement is ready', 'your statement', 'monthly statement', 'account summary', 'balance'],
  invoice: ['invoice'],
  taxes: ['tax', 'hmrc', 'irs', 'p60', 'p45', 'self assessment', 'tax return', '1099', 'w-2'],
  payroll: ['payslip', 'payroll', 'salary', 'net pay', 'your pay', 'wage'],
  insurance: ['insurance', 'policy renewal', 'premium', 'your cover', 'insurance claim', 'your claim', 'claim number'],
  invest: ['portfolio', 'dividend', 'shares', 'your investment', 'trade confirmation', 'brokerage', 'stock'],
  shipping: ['has shipped', 'shipped', 'out for delivery', 'on its way', 'tracking', 'in transit', 'dispatched',
    'arriving', 'delivery update', 'your package', 'your parcel'],
  delivered: ['delivered', 'was delivered', 'has been delivered'],
  order: ['order confirmation', 'your order', 'order #', 'order number', 'we received your order', 'thanks for your order'],
  returns: ['refund', 'your return', 'return label', 'start a return', 'return request', 'has been refunded', 'refunded'],
  travel: ['itinerary', 'booking confirmation', 'reservation', 'your trip', 'e-ticket', 'confirmation number',
    'flight', 'boarding', 'check-in', 'check in for', 'hotel', 'your stay', 'departure'],
  promo: ['% off', 'sale', 'discount', 'deal', 'save now', 'save up to', 'offer', 'coupon', 'promo', 'clearance',
    'black friday', 'cyber monday', 'limited time', 'free shipping', 'shop now', 'buy now', 'exclusive offer',
    'flash sale', "don't miss", 'last chance', 'ends tonight', 'new arrivals', 'gift card', 'voucher', 'bogo'],
  newsletter: ['newsletter', 'digest', 'weekly', 'daily', 'roundup', 'round-up', 'edition', 'this week',
    'latest from', 'bulletin', 'what you missed', 'top stories', 'recap', 'monthly update', 'issue #', 'briefing'],
  social: ['mentioned you', 'tagged you', 'friend request', 'new follower', 'commented on', 'liked your',
    'new connection', 'wants to connect', 'replied to your', 'reacted to', 'new message from', 'started following'],
  events: ['webinar', 'register now', 'join us', 'event', 'rsvp', 'save the date'],
  survey: ['survey', 'feedback', 'rate your', 'how did we do', 'tell us what you think', 'review your'],
  welcome: ['welcome to', 'get started', 'thanks for signing up', 'account created', 'confirm your account',
    'verify your email address', 'activate your account'],
  policy: ['terms', 'privacy policy', 'policy update', "we've updated", 'we have updated', 'changes to our',
    'updated terms', 'service agreement'],
  appointments: ['appointment', 'your visit', 'prescription', 'test results', 'your doctor', 'dentist', 'clinic',
    'booking reminder', 'consultation'],
  utilities: ['energy', 'electricity', 'gas bill', 'water bill', 'broadband', 'your usage', 'meter reading', 'utility'],
  government: ['gov.uk', 'dvla', 'dmv', 'irs', 'hmrc', 'council', 'passport', 'visa', 'jury', 'electoral', 'benefits'],
  housing: ['mortgage', 'rent', 'lease', 'landlord', 'tenancy', 'your property', 'letting'],
  education: ['course', 'enrol', 'enroll', 'semester', 'assignment', 'university', 'school', 'lesson', 'class', 'tuition'],
  reminders: ["don't forget", 'reminder:', 'action required', 'response needed', 'deadline', 'expiring soon', 'renew'],
  notification: ['notification', 'alert', 'update', 'status', 'report', 'activity', 'ticket', 'case #', 'request #'],
  spam: ['you won', 'winner', 'claim your prize', 'free money', 'congratulations you', 'lottery', 'viagra',
    'act now!!!', 'risk-free', 'wire transfer', 'nigerian prince', 'crypto giveaway', 'work from home'],
};

// ---------------------------------------------------------------------------
// Scored rule engine
// ---------------------------------------------------------------------------
//
// Every rule contributes weighted "votes" toward one or more categories rather
// than returning on first match. The winning category is the one with the most
// accumulated weight; confidence falls out of how dominant that winner is (its
// total score and its margin over the runner-up). Independent signals that
// agree therefore *stack* — a bank domain plus a "payment due" subject reinforce
// each other and raise confidence — while a lone weak signal scores low and is
// reported as low-confidence.
//
// Weight tiers (rough guide):
//   100  unmistakable (security codes / password resets)
//    80  high-confidence sender domain (social, bank, retailer, travel, …)
//    70  strong keyword signal (promo + unsubscribe, taxes, bills)
//    55  ordinary topical keyword
//    35  weak heuristic (people inference)
//     1  last-resort "unsorted" floor so there is always a candidate
//
// Rules are plain functions `(ctx, add) => void`; `add(cat, weight, reason)`
// records a vote. Order is irrelevant — only the totals matter — which makes
// the engine easy to extend and test.

const RULES = [
  // 1) Security & codes
  (c, add) => {
    if (kwHit(c.hay, KW.security)) add('hold_security', 100, 'Looks like a sign-in or verification message');
    if (kwHit(c.hay, KW.passwordReset)) add('hold_security', 100, 'Password reset request');
  },

  // 2) High-confidence sender domains
  (c, add) => {
    if (inList(c.dom, D.social)) add('clean_social', 85, `From a social network (${c.dom})`);
    if (inList(c.dom, D.dev)) add('work_code', 80, `Developer service (${c.dom})`);
    if (inList(c.dom, D.projects)) add('work_projects', 80, `Project/task tool (${c.dom})`);
    if (inList(c.dom, D.fileshare)) add('work_documents', 80, `File sharing (${c.dom})`);
    if (inList(c.dom, D.chat)) add('clean_notifications', 80, `Team chat (${c.dom})`);
    if (inList(c.dom, D.calendar)) add('hold_meetings', 80, 'Calendar / scheduling service');
  },

  // 3) Meeting wording
  (c, add) => { if (kwHit(c.hay, KW.meeting)) add('hold_meetings', 55, 'Meeting / calendar invite'); },

  // 4) Marketing / bulk — only when an unsubscribe link is present and there is
  //    no transactional wording, so a promo from a shop or travel domain isn't
  //    mistaken for a real order or booking. The `gatedPromo` flag (see ctx)
  //    suppresses the retailer/travel domain votes below.
  (c, add) => {
    if (!(c.isUnsub && !c.transactional)) return;
    if (kwHit(c.hay, KW.promo)) add('clean_promotions', 72, 'Promotional offer with an unsubscribe link');
    if (inList(c.dom, D.media) || kwHit(c.hay, KW.newsletter)) add('clean_newsletters', 55, 'Newsletter / digest');
    if (kwHit(c.hay, KW.survey)) add('clean_promotions', 45, 'Survey / feedback request');
  },

  // 5) Travel
  (c, add) => {
    const isDom = inList(c.dom, D.travel);
    const isKw = !!kwHit(c.hay, KW.travel);
    if (!isDom && !isKw) return;
    const upcoming = c.age < 21 || /check-in|boarding|departs|upcoming|your trip/.test(c.hay);
    const cat = upcoming ? 'hold_travel' : 'travel_records';
    const reason = isDom ? `Travel provider (${c.dom})` : 'Travel booking wording';
    if (isDom && !c.gatedPromo) add(cat, 80, reason);
    else if (isKw) add(cat, 50, reason);
  },

  // 6) Shopping / shipping — specific transactional wording (a shipment, a
  //    refund) outscores the generic retailer-domain vote in rule 7-equivalent
  //    below, so "your order has shipped" files under In Transit, not Orders.
  (c, add) => {
    if (kwHit(c.hay, KW.shipping)) add('hold_transit', 85, 'Shipping / delivery update');
    if (kwHit(c.hay, KW.returns)) add('shopping_returns', 82, 'Return or refund');
    if (kwHit(c.hay, KW.order)) add('shopping_orders', 50, 'Order confirmation');
    if (inList(c.dom, D.shop) && !c.gatedPromo) add('shopping_orders', 80, `Retailer (${c.dom})`);
  },

  // 7) Finance — the bank domain casts a low baseline vote (so a bank email with
  //    no other signal still lands in Receipts); specific wording routes to the
  //    precise leaf and comfortably outscores that baseline.
  (c, add) => {
    if (inList(c.dom, D.bank)) add('finance_receipts', 45, `Bank / payments provider (${c.dom})`);
    if (kwHit(c.hay, KW.taxes)) add('finance_taxes', 70, 'Tax-related');
    if (kwHit(c.hay, KW.payroll)) add('finance_payroll', 70, 'Payroll / payslip');
    if (kwHit(c.hay, KW.insurance)) add('finance_insurance', 70, 'Insurance');
    if (kwHit(c.hay, KW.invest)) add('finance_invest', 70, 'Investments');
    if (kwHit(c.hay, KW.bills)) add('hold_bills', 75, 'Payment appears to be due');
    if (kwHit(c.hay, KW.statement)) add('finance_bank', 66, 'Bank statement');
    if (kwHit(c.hay, KW.receipts)) add('finance_receipts', 65, 'Receipt / payment');
    if (kwHit(c.hay, KW.invoice)) add('finance_invoices', /pay|due|amount|total/.test(c.hay) ? 66 : 50, 'Invoice');
  },

  // 8) Accounts (topical — same tier as personal-admin signals)
  (c, add) => {
    if (kwHit(c.hay, KW.welcome)) add('accounts_welcome', 55, 'Welcome / onboarding');
    if (kwHit(c.hay, KW.policy)) add('accounts_notices', 55, 'Policy / terms update');
  },

  // 9) Personal admin
  (c, add) => {
    if (kwHit(c.hay, KW.appointments)) add('admin_appointments', 55, 'Appointment / health');
    if (kwHit(c.hay, KW.government) || inList(c.dom, ['gov.uk', 'gov'])) add('admin_government', 55, 'Government / civic');
    if (kwHit(c.hay, KW.utilities)) add('admin_utilities', 55, 'Utilities / home');
    if (kwHit(c.hay, KW.housing)) add('admin_housing', 55, 'Housing / property');
    if (kwHit(c.hay, KW.education)) add('admin_education', 55, 'Education / course');
  },

  // 10) Bulk / marketing fallback (unsubscribe or bulk header, any wording)
  (c, add) => {
    if (!(c.isUnsub || c.isBulk)) return;
    if (inList(c.dom, D.media) || kwHit(c.hay, KW.newsletter)) add('clean_newsletters', 40, 'Newsletter / digest');
    if (kwHit(c.hay, KW.promo)) add('clean_promotions', 62, 'Promotional offer');
    if (kwHit(c.hay, KW.survey)) add('clean_promotions', 38, 'Survey / feedback request');
    add('clean_newsletters', 12, 'Bulk mail with an unsubscribe link');
  },

  // 11) Spam phrasing
  (c, add) => { if (kwHit(c.hay, KW.spam)) add('clean_spam', 30, 'Matches common spam phrasing'); },

  // 12) Reminders / notifications from automated *transactional* senders.
  //     Skipped for mailing lists (isUnsub) — there the marketing read in
  //     rule 10 owns the email, so a "last chance / expiring soon" promo stays
  //     in Clean up rather than being read as a personal reminder.
  (c, add) => {
    if (c.isUnsub || !(c.isAutomated || c.isBulk)) return;
    if (kwHit(c.hay, KW.reminders)) add('hold_reminders', 42, 'Reminder / deadline');
    if (kwHit(c.hay, KW.notification)) add('clean_notifications', 42, 'Automated notification');
  },

  // 13) People (real humans) — only when the sender looks human (not automated,
  //     not a mailing list). A reply or a question bumps it to "To Respond".
  (c, add) => {
    if (c.isAutomated || c.isUnsub || c.isBulk) return;
    let cat = null, reason = null;
    if (c.dom && c.dom === c.userDomain) { cat = 'people_colleagues'; reason = 'Colleague (your domain)'; }
    else if (inList(c.dom, FREEMAIL)) { cat = 'people_personal'; reason = 'Personal contact'; }
    // A non-freemail business domain is only a "client" with a positive signal
    // (a real name, a reply, or a question) — otherwise it stays Unsorted.
    else if (c.dom && (c.hasRealName || c.isReply || c.asks)) { cat = 'people_clients'; reason = 'External contact / client'; }
    if (!cat) return;
    add(cat, 35, reason);
    if (c.isReply) add('hold_respond', 50, 'Part of an ongoing conversation');
    else if (c.asks) add('hold_respond', 50, 'Asks a question');
  },

  // 14) Last-resort notification bucket
  (c, add) => { if (kwHit(c.hay, KW.notification)) add('clean_notifications', 12, 'Automated notification'); },
];

// Floor weight that the "unsorted" candidate always carries, so there is a
// winner even when no rule fires.
const UNSORTED_FLOOR = 1;

function classifyCategory(e, ctx) {
  // Enrich the context with the derived signals the rules read.
  const c = {
    ...ctx,
    dom: ctx.from.domain,
    userDomain: (e.userAddress || '').split('@')[1] || '',
    isReply: /^(re:|fwd:|fw:)/i.test(e.subject || ''),
    asks: (e.subject || '').includes('?'),
    hasRealName: ctx.from.name.includes(' '),
    transactional: !!(kwHit(ctx.hay, KW.shipping) || kwHit(ctx.hay, KW.order) || kwHit(ctx.hay, KW.receipts) ||
      kwHit(ctx.hay, KW.bills) || kwHit(ctx.hay, KW.travel) || kwHit(ctx.hay, KW.statement) || kwHit(ctx.hay, KW.invoice)),
  };
  // A gated promo (unsubscribe link + promo wording + no transactional wording)
  // suppresses the retailer/travel *domain* votes so the marketing read wins.
  c.gatedPromo = c.isUnsub && !c.transactional && !!kwHit(c.hay, KW.promo);

  const scores = {};
  const reasons = {};
  const add = (cat, weight, reason) => {
    scores[cat] = (scores[cat] || 0) + weight;
    if (reason) (reasons[cat] = reasons[cat] || []).push(reason);
  };
  for (const rule of RULES) rule(c, add);
  add('unsorted', UNSORTED_FLOOR, null);

  // Rank candidates by total weight.
  const ranked = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
  const winner = ranked[0];
  const winScore = scores[winner];
  const runnerScore = ranked.length > 1 ? scores[ranked[1]] : 0;

  // Confidence from how dominant the winner is.
  let confidence;
  if (winScore >= 70 && winScore - runnerScore >= 15) confidence = 'high';
  else if (winScore >= 35) confidence = 'medium';
  else confidence = 'low';

  const R = (reasons[winner] || []).slice(0, 4);
  if (!R.length) R.push('No confident signal — left in your Inbox for review');

  return { cat: winner, reasons: R, confidence, score: winScore, margin: winScore - runnerScore };
}

// ---------------------------------------------------------------------------
// Public classify — assembles the full per-email result
// ---------------------------------------------------------------------------

const ACTION = {
  hold_respond: 'Reply', hold_awaiting: 'Awaiting reply', hold_meetings: 'Add to calendar',
  hold_bills: 'Pay', hold_transit: 'Track', hold_travel: 'Keep handy', hold_security: 'Review',
  hold_reminders: 'Review', clean_expired: 'Delete', unsorted: 'Review',
};

function classify(email) {
  const from = parseAddress(email.from);
  const subject = email.subject || '(no subject)';
  const hay = `${subject} ${email.snippet || ''}`.toLowerCase();
  const handles = unsubHandles(email.listUnsubscribe, email.listUnsubscribePost);
  const ctx = {
    hay, from,
    isUnsub: !!email.listUnsubscribe,
    oneClick: handles.oneClick,
    isBulk: /\b(bulk|list|junk)\b/i.test(email.precedence || '') || (!!email.autoSubmitted && !/no/i.test(email.autoSubmitted)),
    isAutomated: AUTOMATED_LOCAL.some((p) => from.local.includes(p)),
    age: ageDays(email.date),
  };

  let { cat, reasons, confidence } = classifyCategory(email, ctx);
  let meta = CATEGORIES[cat];

  // Hold → Clean up / Expired graduation once its time has passed.
  if (meta.disp === 'hold' && meta.expireDays != null && ctx.age > meta.expireDays) {
    reasons = reasons.concat([`Older than ${meta.expireDays}d — its time has passed`]);
    cat = 'clean_expired';
    meta = CATEGORIES[cat];
  }

  const group = meta.group ? GROUPS[meta.group] : null;
  const disp = DISPOSITIONS[meta.disp];

  let priority = meta.prio;
  if (DEADLINE_WORDS.some((w) => hay.includes(w)) && (meta.disp === 'hold' || meta.group === 'finance')) priority = 'high';

  const suggestedAction = ACTION[cat] || (handles.url || handles.mailto ? 'Unsubscribe' : (meta.disp === 'file' ? 'File' : 'Clean up'));

  return {
    fromName: from.name,
    fromAddress: from.address,
    // category
    categoryKey: cat, categoryName: meta.name, categoryIcon: meta.icon, categoryOrder: meta.order,
    // group (null for hold/cleanup/unsorted)
    groupKey: meta.group || null,
    groupName: group ? group.name : null, groupIcon: group ? group.icon : null, groupOrder: group ? group.order : 0,
    // disposition
    dispKey: meta.disp, dispName: disp.name, dispIcon: disp.icon, dispOrder: disp.order,
    // flags
    priority, suggestedAction, confidence,
    unsubscribeUrl: handles.url, unsubscribeMailto: handles.mailto, unsubscribeOneClick: handles.oneClick,
    reasons,
  };
}

module.exports = { classify, DISPOSITIONS, GROUPS, CATEGORIES };

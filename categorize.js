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
// Core classifier — returns a category key + reasons + confidence
// ---------------------------------------------------------------------------

function classifyCategory(e, ctx) {
  const { hay, from, isUnsub, oneClick, isBulk, isAutomated, age } = ctx;
  const userDomain = (e.userAddress || '').split('@')[1] || '';
  const dom = from.domain;
  const R = [];
  const r = (m) => { R.push(m); };
  const done = (cat, conf) => ({ cat, reasons: R.slice(0, 4), confidence: conf || 'medium' });

  // 1) Security & codes (before generic accounts)
  if (kwHit(hay, KW.security)) { r('Looks like a sign-in or verification message'); return done('hold_security', 'high'); }
  if (kwHit(hay, KW.passwordReset)) { r('Password reset request'); return done('hold_security', 'high'); }

  // 2) High-confidence sender domains
  if (inList(dom, D.social)) { r(`From a social network (${dom})`); return done('clean_social', 'high'); }
  if (inList(dom, D.dev)) { r(`Developer service (${dom})`); return done('work_code', 'high'); }
  if (inList(dom, D.projects)) { r(`Project/task tool (${dom})`); return done('work_projects', 'high'); }
  if (inList(dom, D.fileshare)) { r(`File sharing (${dom})`); return done('work_documents', 'high'); }
  if (inList(dom, D.chat)) { r(`Team chat (${dom})`); return done('clean_notifications', 'high'); }
  if (inList(dom, D.calendar) || (kwHit(hay, KW.meeting))) { r('Meeting / calendar invite'); return done('hold_meetings', inList(dom, D.calendar) ? 'high' : 'medium'); }

  // 2b) Marketing / bulk mail — runs before retailer/travel domains so a
  // promo from a shop domain isn't mistaken for a transactional order.
  // Skipped when clear transactional wording is present.
  const transactional = kwHit(hay, KW.shipping) || kwHit(hay, KW.order) || kwHit(hay, KW.receipts) ||
    kwHit(hay, KW.bills) || kwHit(hay, KW.travel) || kwHit(hay, KW.statement) || kwHit(hay, KW.invoice);
  if (isUnsub && !transactional) {
    if (kwHit(hay, KW.promo)) { r('Promotional offer with an unsubscribe link'); return done('clean_promotions', 'high'); }
    if (inList(dom, D.media) || kwHit(hay, KW.newsletter)) { r('Newsletter / digest'); return done('clean_newsletters', 'medium'); }
    if (kwHit(hay, KW.survey)) { r('Survey / feedback request'); return done('clean_promotions', 'medium'); }
  }

  // 3) Travel
  if (inList(dom, D.travel) || kwHit(hay, KW.travel)) {
    r(inList(dom, D.travel) ? `Travel provider (${dom})` : 'Travel booking wording');
    const upcoming = age < 21 || /check-in|boarding|departs|upcoming|your trip/.test(hay);
    return done(upcoming ? 'hold_travel' : 'travel_records', inList(dom, D.travel) ? 'high' : 'medium');
  }

  // 4) Shopping / shipping
  if (kwHit(hay, KW.shipping)) { r('Shipping / delivery update'); return done('hold_transit', 'medium'); }
  if (kwHit(hay, KW.returns)) { r('Return or refund'); return done('shopping_returns', 'medium'); }
  if (kwHit(hay, KW.order) || inList(dom, D.shop)) { r('Order confirmation'); return done('shopping_orders', inList(dom, D.shop) ? 'high' : 'medium'); }

  // 5) Finance
  if (inList(dom, D.bank) || kwHit(hay, KW.bills) || kwHit(hay, KW.receipts) || kwHit(hay, KW.statement) ||
      kwHit(hay, KW.taxes) || kwHit(hay, KW.payroll) || kwHit(hay, KW.insurance) || kwHit(hay, KW.invest) ||
      (kwHit(hay, KW.invoice) && /pay|due|amount|total/.test(hay))) {
    if (inList(dom, D.bank)) r(`Bank / payments provider (${dom})`);
    if (kwHit(hay, KW.taxes)) { r('Tax-related'); return done('finance_taxes', 'medium'); }
    if (kwHit(hay, KW.payroll)) { r('Payroll / payslip'); return done('finance_payroll', 'medium'); }
    if (kwHit(hay, KW.insurance)) { r('Insurance'); return done('finance_insurance', 'medium'); }
    if (kwHit(hay, KW.invest)) { r('Investments'); return done('finance_invest', 'medium'); }
    if (kwHit(hay, KW.bills)) { r('Payment appears to be due'); return done('hold_bills', 'high'); }
    if (kwHit(hay, KW.statement)) { r('Bank statement'); return done('finance_bank', 'medium'); }
    if (kwHit(hay, KW.receipts)) { r('Receipt / payment'); return done('finance_receipts', 'medium'); }
    if (kwHit(hay, KW.invoice)) { r('Invoice'); return done('finance_invoices', 'medium'); }
    return done('finance_receipts', 'medium');
  }

  // 6) Accounts
  if (kwHit(hay, KW.welcome)) { r('Welcome / onboarding'); return done('accounts_welcome', 'medium'); }
  if (kwHit(hay, KW.policy)) { r('Policy / terms update'); return done('accounts_notices', 'medium'); }

  // 7) Personal admin
  if (kwHit(hay, KW.appointments)) { r('Appointment / health'); return done('admin_appointments', 'medium'); }
  if (kwHit(hay, KW.government) || inList(dom, ['gov.uk', 'gov'])) { r('Government / civic'); return done('admin_government', 'medium'); }
  if (kwHit(hay, KW.utilities)) { r('Utilities / home'); return done('admin_utilities', 'medium'); }
  if (kwHit(hay, KW.housing)) { r('Housing / property'); return done('admin_housing', 'medium'); }
  if (kwHit(hay, KW.education)) { r('Education / course'); return done('admin_education', 'medium'); }

  // 8) Bulk / marketing (needs List-Unsubscribe or bulk header)
  if (isUnsub || isBulk) {
    if (inList(dom, D.media) || kwHit(hay, KW.newsletter)) { r('Newsletter / digest'); return done('clean_newsletters', 'medium'); }
    if (kwHit(hay, KW.promo)) { r('Promotional offer'); return done('clean_promotions', 'high'); }
    if (kwHit(hay, KW.survey)) { r('Survey / feedback request'); return done('clean_promotions', 'medium'); }
    r('Bulk mail with an unsubscribe link');
    return done('clean_newsletters', 'low');
  }

  // 9) Spam-ish
  if (kwHit(hay, KW.spam)) { r('Matches common spam phrasing'); return done('clean_spam', 'low'); }

  // 10) Reminders / notifications from automated senders
  if (isAutomated || isBulk) {
    if (kwHit(hay, KW.reminders)) { r('Reminder / deadline'); return done('hold_reminders', 'medium'); }
    if (kwHit(hay, KW.notification)) { r('Automated notification'); return done('clean_notifications', 'medium'); }
  }

  // 11) People (real humans)
  if (!isAutomated && !isUnsub && !isBulk) {
    const isReply = /^(re:|fwd:|fw:)/i.test(e.subject || '');
    const asks = (e.subject || '').includes('?');
    let cat, conf = 'medium';
    const hasRealName = from.name.includes(' ');
    if (dom && dom === userDomain) { r('Colleague (your domain)'); cat = 'people_colleagues'; }
    else if (inList(dom, FREEMAIL)) { r('Personal contact'); cat = 'people_personal'; }
    // A non-freemail business domain is only a "client" with a positive signal
    // (a real name, a reply, or a question) — otherwise it stays Unsorted.
    else if (dom && (hasRealName || isReply || asks)) { r('External contact / client'); cat = 'people_clients'; }
    if (cat) {
      if (isReply) { r('Part of an ongoing conversation'); return done('hold_respond', 'medium'); }
      if (asks) { r('Asks a question'); return done('hold_respond', 'medium'); }
      return done(cat, conf);
    }
  }

  // 12) Last-resort buckets
  if (kwHit(hay, KW.notification)) { r('Automated notification'); return done('clean_notifications', 'low'); }

  // 13) Couldn't identify
  r('No confident signal — left in your Inbox for review');
  return done('unsorted', 'low');
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

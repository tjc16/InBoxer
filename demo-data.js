'use strict';

/**
 * Realistic sample inbox for demo mode, covering the full three-tier taxonomy.
 * Produces raw email-shaped objects (the same shape the IMAP scanner produces)
 * which are run through the real rules engine — so the demo behaves exactly like
 * the live app, with no credentials.
 */

const ME = 'you@example.com';

// unsub: has List-Unsubscribe · post: supports RFC-8058 one-click · mailto: mailto-only unsubscribe
// maxAge: cap the random age (days) so time-sensitive mail lands in Hold not Expired
const TEMPLATES = [
  // People — personal
  { from: 'Sarah Mitchell <sarah.mitchell@gmail.com>', subjects: ['Re: lunch on Friday?', 'Did you see this?', 'Photos from the weekend'] },
  { from: 'Mum <linda.harper@yahoo.com>', subjects: ['Re: Sunday dinner', 'Can you call me back?', 'Recipe you wanted'] },
  // People — colleagues (your domain)
  { from: 'James Okafor <james.okafor@example.com>', subjects: ['Re: project timeline', 'Notes from standup', 'Can you review the deck?'] },
  { from: 'Priya Nair <priya.nair@example.com>', subjects: ['Q3 planning', 'Quick question on the budget?'] },
  // People — clients / external
  { from: 'Daniel Reeves <daniel@acmeagency.com>', subjects: ['Following up on our proposal', 'Re: contract draft'] },
  // Work — code / projects / docs
  { from: 'GitHub <notifications@github.com>', subjects: ['[repo] PR #482 was merged', 'A new SSH key was added to your account', '[repo] 3 issues assigned to you'] },
  { from: 'Jira <jira@company.atlassian.net>', subjects: ['[JIRA] PROJ-1423 assigned to you', 'Sprint board updated'] },
  { from: 'Google Docs <comments-noreply@docs.google.com>', subjects: ['Priya shared “Q3 Strategy” with you', 'New comment on “Roadmap”'] },
  { from: 'Dropbox <no-reply@dropbox.com>', subjects: ['Daniel shared a folder with you', 'Your files are ready'] },
  // Finance
  { from: 'Chase <no-reply@chase.com>', subjects: ['Your monthly statement is ready', 'Your statement is ready — payment due Jun 18'], maxAge: 20 },
  { from: 'Stripe <receipts@stripe.com>', subjects: ['Your receipt from Figma', 'Payment received — thank you'] },
  { from: 'PayPal <service@paypal.com>', subjects: ['You sent a payment of £45.00', 'Your invoice from Acme Ltd'] },
  { from: 'HMRC <noreply@gov.uk>', subjects: ['Your tax return is due', 'Self assessment reminder'] },
  { from: 'Payroll <payroll@example.com>', subjects: ['Your payslip for May is ready', 'Salary payment confirmation'] },
  { from: 'Aviva <noreply@aviva.com>', subjects: ['Your insurance policy renewal', 'Your premium is changing'] },
  { from: 'Vanguard <no-reply@vanguard.com>', subjects: ['Your quarterly portfolio summary', 'Dividend payment processed'] },
  // Shopping
  { from: 'Amazon <ship-confirm@amazon.com>', subjects: ['Your package has shipped — tracking inside', 'Out for delivery: arriving today'], maxAge: 10 },
  { from: 'Amazon <order-update@amazon.com>', subjects: ['Your order #112-4455 confirmation', 'Thanks for your order'] },
  { from: 'ASOS <returns@asos.com>', subjects: ['Your refund has been processed', 'Your return label is ready'] },
  // Travel
  { from: 'British Airways <no-reply@email.ba.com>', subjects: ['Your flight itinerary — check-in now open', 'Booking confirmation LHR → JFK'], maxAge: 12 },
  { from: 'Airbnb <automated@airbnb.com>', subjects: ['Your reservation is confirmed', 'Check-in details for your trip'], maxAge: 12 },
  // Accounts & security
  { from: 'Google <no-reply@accounts.google.com>', subjects: ['Your verification code is 284913', 'Security alert: new sign-in to your account'], maxAge: 1 },
  { from: 'Microsoft <account-security-noreply@microsoft.com>', subjects: ['Your single-use code: 552190', 'Unusual sign-in activity detected'], maxAge: 1 },
  { from: 'Notion <team@makenotion.com>', subjects: ['Welcome to Notion — get started', 'Confirm your email address'] },
  { from: 'Spotify <no-reply@spotify.com>', subjects: ["We've updated our terms of service", 'Changes to our privacy policy'] },
  // Meetings
  { from: 'Calendly <notifications@calendly.com>', subjects: ['Invitation: Product sync Thursday', 'Reminder: your meeting starts soon'], maxAge: 6 },
  { from: 'Zoom <no-reply@zoom.us>', subjects: ['Invitation: Team standup (Zoom)', 'Your webinar registration is confirmed'], maxAge: 6 },
  // Personal admin
  { from: 'City Dental <no-reply@citydental.com>', subjects: ['Appointment reminder: your visit', 'Your test results are ready'] },
  { from: 'British Gas <no-reply@britishgas.co.uk>', subjects: ['Your energy usage this month', 'Your meter reading is due'] },
  { from: 'GOV.UK <no-reply@notifications.service.gov.uk>', subjects: ['Your passport application update', 'Council tax statement'] },
  { from: 'Nationwide <no-reply@nationwide.co.uk>', subjects: ['Your mortgage statement', 'Important information about your tenancy'] },
  { from: 'Coursera <no-reply@coursera.org>', subjects: ['Your course starts Monday', 'New assignment in Machine Learning'] },
  // Promotions (one-click capable)
  { from: 'Nike <news@nike.com>', subjects: ['🔥 Up to 40% off — shop now', 'Members get early access', "Don't miss our biggest sale"], unsub: true, post: true },
  { from: 'ASOS <offers@asos.com>', subjects: ['50% off everything — flash sale ends tonight!', 'Your exclusive 20% code inside'], unsub: true, post: true },
  { from: 'Deliveroo <deals@deliveroo.co.uk>', subjects: ['Save 30% on your next 3 orders', 'Tonight only: buy one get one free'], unsub: true, post: true },
  { from: 'Booking.com <promotions@booking.com>', subjects: ['Exclusive deal: 25% off your next stay', 'Limited time offer just for you'], unsub: true, post: true },
  // Newsletters (mix of one-click and mailto)
  { from: 'Morning Brew <crew@morningbrew.com>', subjects: ['☕ Daily digest: top stories', 'This week in business'], unsub: true, post: true },
  { from: 'The New York Times <nytdirect@nytimes.com>', subjects: ['Your morning briefing', 'The Weekly: what you missed'], unsub: true, mailto: true },
  { from: 'Lenny <lenny@substack.com>', subjects: ['📰 This week: product strategy deep-dive', 'Latest from the newsletter'], unsub: true, mailto: true },
  { from: 'Product Hunt <hello@producthunt.com>', subjects: ['Today’s top product launches', 'Your daily digest'], unsub: true, post: true },
  // Social
  { from: 'LinkedIn <notifications-noreply@linkedin.com>', subjects: ['You have 4 new connection requests', 'Maya mentioned you in a comment'], unsub: true },
  { from: 'Instagram <no-reply@mail.instagram.com>', subjects: ['New follower request', 'someone liked your photo'], unsub: true },
  { from: 'Facebook <notification@facebookmail.com>', subjects: ['You have 3 new notifications', 'Tom tagged you in a post'], unsub: true },
  { from: 'Reddit <noreply@redditmail.com>', subjects: ['Someone replied to your comment', 'Top posts from r/programming'], unsub: true },
  // Notifications
  { from: 'Slack <notifications@slack.com>', subjects: ['New activity in #general', 'You have unread messages'], unsub: true },
  { from: 'Trello <do-not-reply@trello.com>', subjects: ['You were added to a board', 'Card due tomorrow'], unsub: true },
  // Reminders
  { from: 'Grammarly <info@grammarly.com>', subjects: ['Reminder: your subscription renews soon', "Don't forget to claim your insights"], unsub: true },
  // Spam-ish
  { from: 'Rewards <win@luckydraw.biz>', subjects: ['Congratulations you won! Claim your prize now', 'You are our lucky winner!!!'] },
  // Unidentifiable
  { from: 'updates <x9@mailer-svc.net>', subjects: ['ref 88213', 'notice'] },
  { from: 'system <bot@unknown-co.io>', subjects: ['automated message', '...'] },
];

function generateDemoInbox(count) {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const t = TEMPLATES[i % TEMPLATES.length];
    const subject = t.subjects[Math.floor(Math.random() * t.subjects.length)];
    const cap = t.maxAge || 50;
    const daysAgo = Math.floor(Math.pow(Math.random(), 1.6) * cap);
    const d = new Date(now - daysAgo * 86400000 - Math.floor(Math.random() * 86400000));

    let listUnsub = '';
    if (t.unsub && t.mailto) listUnsub = '<mailto:unsubscribe@' + (t.from.split('@')[1] || 'list.com').replace('>', '') + '?subject=unsubscribe>';
    else if (t.unsub) listUnsub = '<https://lists.example.com/u/' + i + '>';

    out.push({
      uid: 100000 - i,
      from: t.from,
      to: ME,
      subject,
      date: d.toUTCString(),
      seen: Math.random() > 0.45,
      listUnsubscribe: listUnsub,
      listUnsubscribePost: t.post ? 'List-Unsubscribe=One-Click' : '',
      precedence: t.unsub ? 'bulk' : '',
      autoSubmitted: '',
      replyTo: '',
      userAddress: ME,
    });
  }
  return out;
}

module.exports = { generateDemoInbox, ME };

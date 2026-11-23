---
title: Privacy Policy
version: 2026-11-23
---

## 1. Who we are

IRIS is provided by Noatak Enterprises, LLC, an Arizona limited liability company ("we", "us"). For the personal data described in section 2 that we use to run our own business (accounts, billing, security), we are the controller. For the content your organization processes through IRIS (the sites you test and the results), your organization is the controller and we act as its processor under our [Data Processing Agreement](/dpa). Contact for privacy questions: [support@briastrategy.net](mailto:support@briastrategy.net). We have not appointed a data protection officer or an EU or UK representative.

## 2. What we collect

- **Account data**: your name, email address, a hash of your password, whether your address is verified, and the sessions you sign in with, including the IP address and browser user agent of each session.
- **Organization data**: the organizations you create or join, your role in each, and invitations, including the invited email address and who sent it.
- **API key metadata**: the name, the first characters and a one-way hash of each API key, the organization it belongs to and when it was last used. We do not keep the key itself after showing it to you once.
- **AI provider keys**: if your organization adds its own OpenAI or Anthropic key, we store it encrypted and use it only to make AI requests for your organization.
- **Test inputs and page content**: the URLs you ask IRIS to test, your plain-language instructions, and the pages IRIS opens to do it. Page content and screenshots are processed in our browser while a test runs. For visual tests, the screenshots, the images showing what changed, and each project's approved baseline screenshots are stored.
- **Results**: run history and test results, such as the pages tested, pass or fail, accessibility violation counts and a description of each browser action. We never store what a "fill" action typed.
- **Usage and billing data**: what your organization used (browser minutes, AI calls, jobs) and its cost. For paid plans, the billing email and the plan and payment status our payment processor, Stripe, reports to us. Stripe collects and holds your card details; we never see or store them.
- **Logs and security data**: service logs with organization, API key and request identifiers and error messages; our web server's access logs, which include IP addresses; and the IP address recorded when you accept the Terms.
- **Terms acceptances**: which version of the Terms of Service and Acceptable Use Policy you accepted, when, and from which IP address.

## 3. Why we use it

- To create and secure your account, verify your email address, sign you in and reset your password.
- To run the service: open the pages you name, run the tests and AI requests you ask for, and keep your organization's results.
- To meter usage, enforce limits and budgets, and bill for paid plans.
- To keep the service secure and working: rate limits, abuse prevention, monitoring, backups and investigating errors.
- To record your acceptance of our terms, and to meet legal obligations.
- To send you the emails the service needs (verification, password reset, invitations). We do not send marketing email.

Where the law requires a legal basis: running your account and the service, and billing, are performance of our contract with you; security, abuse prevention and improving the service are our legitimate interests; keeping billing records and terms acceptances is a legal obligation or our legitimate interest in defending claims.

## 4. AI vendors

When your organization has added its own OpenAI or Anthropic key, IRIS may send the AI vendor your instruction and the page URL to turn the instruction into browser actions. For visual comparisons it sends screenshots, an optional difference image and the page URL. These requests are made with your organization's key, on your organization's own account with that vendor, whose terms and privacy policy apply. If your organization chooses IRIS credits instead, the same requests are made with IRIS's own key, on our account with the vendor, which is then our subprocessor; once this month's credits are used, your organization's own key is used, if it has one. Without IRIS credits or a stored key, nothing is sent to an AI vendor.

## 5. Who we share it with

We use service providers (subprocessors) to host the service, send email and, when paid plans launch, take payments. They are listed on our [subprocessor page](/subprocessors). We do not sell your personal data. We may disclose data when the law requires it, or to protect the service and its users. If our business is sold or merged, your data may pass to the new owner, who must keep this policy's commitments or tell you first.

## 6. International transfers

IRIS and its subprocessors store and process data in the United States. Where data is transferred from the EU, UK or Switzerland, we rely on the European Commission's Standard Contractual Clauses (with the UK Addendum and Swiss amendments) or another lawful transfer mechanism.

## 7. How long we keep it

- Sessions expire about 7 days after the session was last extended (sessions are extended at most once a day while in use), and password-reset links after 1 hour. Invitations expire after 48 hours.
- When you revoke an API key or remove an AI provider key, we delete it at once.
- AI vision results we cache to avoid repeat charges are kept for 30 days.
- Service logs are rotated by size and overwritten as new logs are written.
- Backups are encrypted. Daily backups older than 14 days are deleted, but the 7 most recent are always kept. Data deleted from the service remains in backups until they are deleted.
- Run history and results, including a visual test's screenshots, are kept for 90 days after the run finishes. A project's approved baseline screenshots are kept until they are replaced or the organization is deleted. Expired sessions and sign-in links are deleted daily.
- Accounts and organizations are kept until you ask us to delete them at [support@briastrategy.net](mailto:support@briastrategy.net). A deleted organization is disabled at once and can be restored for 30 days; then its members, keys, runs and results are deleted. Its usage and billing records are kept for 7 years, no longer linked to its name or members, and then deleted.
- When an account is deleted, the record of which terms it accepted, when and from which IP address is kept for 7 years under a one-way hash instead of the account, then deleted.

## 8. How we protect it

- Encryption in transit (TLS) for the portal and the API.
- Passwords and API keys are stored only as one-way hashes. AI provider keys are encrypted with a per-key data key, itself encrypted with a master key.
- Backups are encrypted before they are written, and the key to decrypt them is kept off the server.
- Every organization's data is kept apart: each record carries its organization, and every query is limited to it.
- The browser that opens your pages runs sandboxed, in a hardened container, and cannot reach private or internal network addresses.
- Logs never contain keys, passwords, typed values or your instructions.
- Sign-in, API and job rate limits, and email verification for every account.

No system is perfectly secure. If a breach affects your personal data, we will tell you without undue delay, as the law requires.

## 9. Your rights

Depending on where you live, you may have the right to access, correct, delete, restrict or object to our use of your personal data, to receive a copy of it, and to withdraw consent. To use these rights, contact [support@briastrategy.net](mailto:support@briastrategy.net). If your data is in an organization's content, we will pass your request to that organization, as its controller. You may also complain to your data protection authority. California residents have the rights the CCPA gives them, including to know, delete and correct their personal information; we do not sell or share personal information as the CCPA defines it, and we will not treat you differently for using these rights.

## 10. Cookies

The portal uses only the cookies it needs to keep you signed in. We do not use analytics or advertising cookies.

## 11. Children

IRIS is not meant for children under 18, and we do not knowingly collect their data.

## 12. Changes

This policy has a version, shown at the top of this page. When we change it we publish a new version here. For a material change, we will tell you at least 30 days before it takes effect, by email and in the portal.

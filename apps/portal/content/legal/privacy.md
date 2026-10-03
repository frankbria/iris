---
title: Privacy Policy
version: 2026-10-02
draft: true
---

This privacy policy is a working draft. Text in [square brackets] is a placeholder the owner must fill in or replace before the policy takes effect.

## 1. Who we are

IRIS is provided by [company name, registered address] ("we", "us"). For the personal data described in section 2 that we use to run our own business (accounts, billing, security), we are the controller. For the content your organization processes through IRIS (the sites you test and the results), your organization is the controller and we act as its processor under our [Data Processing Agreement](/dpa). Contact for privacy questions: [privacy contact email]. [Data protection officer or EU/UK representative, if required.]

## 2. What we collect

- **Account data**: your name, email address, a hash of your password, whether your address is verified, and the sessions you sign in with, including the IP address and browser user agent of each session.
- **Organization data**: the organizations you create or join, your role in each, and invitations, including the invited email address and who sent it.
- **API key metadata**: the name, the first characters and a one-way hash of each API key, the organization it belongs to and when it was last used. We do not keep the key itself after showing it to you once.
- **AI provider keys**: if your organization adds its own OpenAI or Anthropic key, we store it encrypted and use it only to make AI requests for your organization.
- **Test inputs and page content**: the URLs you ask IRIS to test, your plain-language instructions, and the pages IRIS opens to do it. Page content and screenshots are processed in our browser while a test runs.
- **Results**: run history and test results, such as the pages tested, pass or fail, accessibility violation counts and a description of each browser action. We never store what a "fill" action typed.
- **Usage and billing data**: what your organization used (browser minutes, AI calls, jobs) and its cost. [Billing contact and payment details once paid plans launch.]
- **Logs and security data**: service logs with organization, API key and request identifiers and error messages; our web server's access logs, which include IP addresses; and the IP address recorded when you accept the Terms.
- **Terms acceptances**: which version of the Terms of Service and Acceptable Use Policy you accepted, when, and from which IP address.

## 3. Why we use it

- To create and secure your account, verify your email address, sign you in and reset your password.
- To run the service: open the pages you name, run the tests and AI requests you ask for, and keep your organization's results.
- To meter usage, enforce limits and budgets, and [bill for paid plans].
- To keep the service secure and working: rate limits, abuse prevention, monitoring, backups and investigating errors.
- To record your acceptance of our terms, and to meet legal obligations.
- To send you the emails the service needs (verification, password reset, invitations). [Marketing email, if any, and how to opt out.]

[Legal basis for each purpose under applicable law, for example performance of a contract, legitimate interests, legal obligation or consent, to be completed by counsel.]

## 4. AI vendors

When your organization has added its own OpenAI or Anthropic key, IRIS may send the AI vendor your instruction and the page URL to turn the instruction into browser actions. For visual comparisons it sends screenshots, an optional difference image and the page URL. These requests are made with your organization's key, on your organization's own account with that vendor, whose terms and privacy policy apply. Without a stored key, nothing is sent to an AI vendor. [When IRIS-provided AI credits launch, requests using them will be made on our account, and the vendor will be our subprocessor.]

## 5. Who we share it with

We use service providers (subprocessors) to host the service, send email and, when paid plans launch, take payments. They are listed on our [subprocessor page](/subprocessors). We do not sell your personal data. We may disclose data when the law requires it, or to protect the service and its users. [Business transfers, for example a merger.]

## 6. International transfers

[Where the service and our subprocessors store and process data, and the safeguards used for transfers out of the EU, UK or other regions, for example Standard Contractual Clauses.]

## 7. How long we keep it

- Sessions expire 7 days after they were last used, and password-reset links after 1 hour. Invitations expire after 48 hours.
- When you revoke an API key or remove an AI provider key, we delete it at once.
- AI vision results we cache to avoid repeat charges are kept for 30 days.
- Service logs are rotated by size and overwritten as new logs are written.
- Backups are encrypted. Daily backups older than 14 days are deleted, but the 7 most recent are always kept. [Retention of off-site backup copies.] Data deleted from the service remains in backups until they are deleted.
- Accounts, organizations, run history, usage records and terms acceptances are kept while your account or organization exists. [Retention after account deletion or organization closure, and how to request deletion, to be set out here.]

## 8. How we protect it

- Encryption in transit (TLS) for the portal and the API.
- Passwords and API keys are stored only as one-way hashes. AI provider keys are encrypted with a per-key data key, itself encrypted with a master key.
- Backups are encrypted before they are written, and the key to decrypt them is kept off the server.
- Every organization's data is kept apart: each record carries its organization, and every query is limited to it.
- The browser that opens your pages runs sandboxed, in a hardened container, and cannot reach private or internal network addresses.
- Logs never contain keys, passwords, typed values or your instructions.
- Sign-in, API and job rate limits, and email verification for every account.

No system is perfectly secure. [Breach notification commitments.]

## 9. Your rights

Depending on where you live, you may have the right to access, correct, delete, restrict or object to our use of your personal data, to receive a copy of it, and to withdraw consent. To use these rights, contact [privacy contact email]. If your data is in an organization's content, we will pass your request to that organization, as its controller. You may also complain to your data protection authority. [Jurisdiction-specific rights, for example California.]

## 10. Cookies

The portal uses only the cookies it needs to keep you signed in. [Confirm before adding any analytics or marketing cookies.]

## 11. Children

IRIS is not meant for children under [minimum age], and we do not knowingly collect their data.

## 12. Changes

This policy has a version, shown at the top of this page. When we change it we publish a new version here. [Notice for material changes.]

---
title: Data Processing Agreement
version: 2026-10-02
draft: true
---

This Data Processing Agreement ("DPA") is a working template. Text in [square brackets] is a placeholder the owner and counsel must fill in or replace before it is offered or signed. To request a DPA for your organization, contact [privacy contact email].

## 1. Parties

- **Controller**: [customer legal name, address] ("Customer"), the organization that uses IRIS.
- **Processor**: [company name, registered address] ("Provider"), which provides IRIS.

This DPA forms part of the [Terms of Service](/terms) (the "Agreement") between them. If they conflict on the processing of personal data, this DPA prevails.

## 2. Subject matter and duration

The Provider processes Customer personal data only to provide IRIS under the Agreement. This DPA lasts as long as the Provider processes Customer personal data under the Agreement, and ends when that processing ends under section 10. [Effective date.]

## 3. Nature and purpose of processing

- Opening and interacting with the web pages the Customer names, in a browser the Provider runs, and taking screenshots of them.
- Running accessibility and visual tests and storing their results for the Customer's organization.
- Translating the Customer's plain-language instructions into browser actions, and comparing screenshots, using AI vendors with the Customer's own AI provider key.
- Authenticating the Customer's users and API keys, metering usage, and keeping the service secure.

## 4. Categories of data and data subjects

- **Data subjects**: the Customer's users (people with portal accounts in its organization), and any person whose personal data appears on the pages the Customer tests.
- **Personal data**: user account data (name, email address, session IP addresses and user agents); organization membership and invitations; API key metadata; the URLs and instructions the Customer submits; page content and screenshots processed while a test runs; test results; usage records; logs.
- **Special categories**: the Provider does not require any. The Customer decides what is on the pages it tests and should not test pages containing special-category data unless [conditions].

## 5. Customer obligations

The Customer is responsible for having a lawful basis for the processing it instructs, for having the right to test every site it points IRIS at, and for the content of its instructions, test targets and results. The Customer's own AI provider keys are used under the Customer's agreements with those vendors.

## 6. Provider obligations

- Process Customer personal data only on the Customer's documented instructions, which are the Agreement, this DPA and the Customer's use of IRIS, unless the law requires otherwise, in which case the Provider tells the Customer first where the law allows.
- Ensure that people authorized to process the data are bound by confidentiality.
- Implement the security measures in section 8.
- Assist the Customer, taking into account the nature of the processing, with data subject requests, security, breach notification, data protection impact assessments and consultations with authorities. [Cost of assistance.]
- Tell the Customer if, in its opinion, an instruction infringes data protection law.

## 7. Subprocessors

The Customer authorizes the Provider to use the subprocessors listed at [/subprocessors](/subprocessors). The Provider will give at least [notice period] notice of an intended addition or replacement by [notice method], and the Customer may object on reasonable data protection grounds within [objection period]. [What happens after an objection.] The Provider imposes data protection obligations on each subprocessor no less protective than this DPA and remains responsible for its subprocessors' performance.

AI requests made with the Customer's own AI provider key are made on the Customer's account with that vendor; for those requests the vendor is the Customer's provider, not the Provider's subprocessor.

## 8. Technical and organizational measures

- **Encryption in transit**: TLS for the portal, the REST API and the WebSocket API.
- **Credentials at rest**: passwords hashed (scrypt); API keys stored only as SHA-256 hashes and shown once; Customer AI provider keys encrypted with envelope encryption (AES-256-GCM, a fresh data key per key, wrapped by a master key held outside the database).
- **Tenant isolation**: every Customer record carries its organization, and every read and write is scoped to it; foreign keys stop a record from referring to another organization's data; API keys belong to an organization.
- **Access control**: organization roles (owner, admin, member) govern who may manage members, API keys and AI provider keys; email verification is required for every account; all sessions are revoked on password reset.
- **Browser isolation**: the browser runs sandboxed in a container with all capabilities dropped, a read-only root filesystem and resource limits; downloads and service workers are blocked; an egress proxy and per-request URL checks refuse private, internal and cloud-metadata addresses.
- **Abuse limits**: per-key and per-organization rate limits, connection, session and job caps, and sign-in rate limits.
- **Data minimization**: what a "fill" action typed is never stored; credentials in URLs are stripped or refused; accessibility results store violation counts, not page markup.
- **Logging**: structured logs that never contain keys, passwords, typed values or instructions, with redaction of credentials in messages; logs are rotated by size.
- **Backups**: daily, encrypted before being written, with the decryption key kept off the server; a restore procedure that is tested.
- **Monitoring**: health checks, metrics and alerts to the operator.
- [Organizational measures: personnel, access reviews, incident response, vendor management.]

## 9. Personal data breaches

The Provider will notify the Customer without undue delay, and in any case within [hours] hours, after becoming aware of a personal data breach affecting Customer personal data, with the information the Customer reasonably needs to meet its own obligations, and will take reasonable steps to contain it.

## 10. Deletion and return

When the Agreement ends, the Provider will, at the Customer's choice, delete or return Customer personal data within [period], unless the law requires it to be kept. Data in backups is deleted as the backups expire. [Export format and process; certificate of deletion.]

## 11. Audits

The Provider will make available the information reasonably necessary to demonstrate compliance with this DPA, and allow audits by the Customer or an auditor it appoints, [frequency, notice, scope, confidentiality and cost].

## 12. International transfers

[Where Customer personal data is processed, and the transfer mechanism used where it leaves the EU, UK or Switzerland, for example the Standard Contractual Clauses (module two or three), the UK Addendum and the Swiss amendments, incorporated by reference.]

## 13. Liability and governing law

[Liability under this DPA, governing law and venue, as in the Agreement.]

## Annex: processing details

- **Duration**: the term of the Agreement plus the deletion period in section 10.
- **Frequency**: continuous, as the Customer uses IRIS.
- **Retention**: [per category, from the Provider's data retention schedule].
- **Subprocessors**: as listed at [/subprocessors](/subprocessors).

# Responsible use

PitchTrace is for small, deliberate, evidence-linked review—not bulk spam.

- Obtain and document an appropriate lawful basis before processing contact
  information or performing outreach.
- Respect robots directives, suppression requests, applicable privacy rules,
  marketing rules, platform terms, and recipient preferences.
- Review every finding and claim. A technical observation can still be
  misleading without context.
- Never turn an `experimental`, inferred, or `outreach_eligible: false` finding
  into an assertion.
- Do not upload scraped personal datasets or data that you are not authorized
  to process.
- Keep n8n, analyzer, databases, artifacts, exports, and backups private.
- Treat `.eml` creation as preparation, not delivery. PitchTrace does not send
  email, track opens, add pixels, or monitor replies.

This document is operational guidance, not a legal guarantee of KVKK, İYS,
GDPR, ePrivacy, CAN-SPAM, or any other regime. Operators must obtain qualified
advice for their jurisdiction and use case.
# Production and pilot controls

Human approval is mandatory and produces only a downloadable `.eml`; it does not send email and must never be interpreted as `sent_manually`. Audit and draft/export kill switches must be enabled deliberately and disabled on complaints or unsafe behavior. Opt-outs are suppression events, not analytics events.

Pilot reporting is aggregate and excludes personal email addresses. The operator is the sender and remains responsible for lawful basis, transparency, security, KVKK, İYS and any other applicable rules. PitchTrace and its documentation are not a legal compliance guarantee.

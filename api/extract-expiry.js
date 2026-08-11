// POST /api/extract-expiry
// Body: { file_url, type_name, thing_id, field_name?, api_token }
//
// 1. Downloads the document image from Bubble's file_url
// 2. Sends it to Claude with a forced tool call for structured extraction
// 3. Writes the expiry date back onto the given Bubble Thing via the Data API
//    (skipped if Claude's confidence is low, or no date is found — the caller
//    gets needs_review: true instead so it can be routed for manual check)

const BUBBLE_LIVE_BASE = 'https://knightingale.com.au/api/1.1/obj';
const BUBBLE_TEST_BASE = 'https://knightingale.com.au/version-test/api/1.1/obj';

// For CPR/First Aid specifically: only genuine Australian RTO Statements of
// Attainment count. Add company names here as more non-RTO providers turn up.
const DISALLOWED_CPR_PROVIDERS = ['National CPR Foundation', 'NationalCPRFoundation', 'NCPRF'];

const RTO_COMPLIANCE_NOTE = `For CPR and First Aid competency specifically, only accept a genuine Statement of Attainment issued by an Australian Registered Training Organisation (RTO) for the relevant nationally recognised unit of competency (e.g. HLTAID009 Provide cardiopulmonary resuscitation, HLTAID011 Provide First Aid). Reject a generic online "Certificate of Completion" that references CPR/AED/first aid training but is NOT an RTO Statement of Attainment for one of these units — this includes any document issued by: ${DISALLOWED_CPR_PROVIDERS.join(', ')}. Reject these regardless of what expiry date is printed on them. If a document matches this pattern, set is_expected_document_type to false and explain in mismatch_reason that it is not a recognised RTO qualification.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clean = (v) => (v === undefined || v === null || v === 'null' || v === 'undefined' || v === '' ? undefined : v);
  const body = req.body || {};
  const file_url = clean(body.file_url);
  const type_name = clean(body.type_name);
  const thing_id = clean(body.thing_id);
  const field_name = clean(body.field_name);
  const api_token = clean(body.api_token);
  const env = clean(body.env);
  const document_label = clean(body.document_label);
  const fallback_expiry_months = clean(body.fallback_expiry_months);

  if (!file_url || !type_name || !thing_id || !api_token) {
    return res.status(400).json({
      error: 'Missing required field(s): file_url, type_name, thing_id, api_token',
    });
  }

  const targetField = field_name || 'date';
  const BUBBLE_BASE = env === 'test' ? BUBBLE_TEST_BASE : BUBBLE_LIVE_BASE;
  const fileUrl = file_url.startsWith('//') ? `https:${file_url}` : file_url;

  try {
    // 1. Fetch and base64-encode the document
    const fileResp = await fetch(fileUrl);
    if (!fileResp.ok) {
      throw new Error(`Could not fetch file_url (${fileResp.status})`);
    }
    const mediaType = fileResp.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await fileResp.arrayBuffer());
    const base64 = buffer.toString('base64');

    // 2. Ask Claude to extract the expiry date as structured JSON
    const isPdf = mediaType.includes('pdf') || fileUrl.toLowerCase().includes('.pdf');
    const docBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 300,
        tools: [
          {
            name: 'record_expiry_date',
            description: 'Records the expiry date printed on an identity or compliance document.',
            input_schema: {
              type: 'object',
              properties: {
                is_expected_document_type: {
                  type: 'boolean',
                  description: 'True if the document contains the qualification/type described in document_label anywhere on it — including when it\'s a combined certificate listing several qualifications together (e.g. First Aid + CPR + Basic Life Support on one Statement of Attainment). False only if the document is clearly a different, unrelated document (e.g. a driver\'s licence or passport when a certificate was expected) that does not contain the expected qualification at all.',
                },
                mismatch_reason: {
                  type: 'string',
                  description: 'If is_expected_document_type is false, briefly explain what the document actually appears to be instead. Omit if true.',
                },
                expiry_date: {
                  type: ['string', 'null'],
                  description: 'Expiry date in YYYY-MM-DD format, taken ONLY from a date explicitly printed on the document as an expiry, valid-until, or renewal-due date. Never calculate or infer this from an issue date plus a stated renewal period (e.g. "renew annually") — if no explicit expiry date is printed, this must be null even if an issue date or renewal guidance is present.',
                },
                issue_date: {
                  type: ['string', 'null'],
                  description: 'The issue/completion/attainment date in YYYY-MM-DD format, ONLY if explicitly printed on the document (e.g. "Issue Date: 28 September 2023"). Null if not printed. Report this even when expiry_date is also found.',
                },
                matched_qualification: {
                  type: 'string',
                  description: 'The exact line/qualification on the document that expiry_date was taken from, e.g. "HLTAID009 - Provide cardiopulmonary resuscitation - 08/10/2026". If the document only has one date, describe that line.',
                },
                document_type: {
                  type: 'string',
                  description: "Best guess at what the document actually is, e.g. 'drivers licence', 'passport', 'first aid certificate'.",
                },
                confidence: {
                  type: 'string',
                  enum: ['high', 'medium', 'low'],
                  description: 'Confidence that expiry_date is correct.',
                },
                nrt_logo_visible: {
                  type: 'boolean',
                  description: 'True if the "Nationally Recognised Training" triangle logo (a stylised triangle made of layered red/green arrow shapes) is visible anywhere on the document. False if not visible, unclear, or cropped out. This is informational only — do not let its absence affect is_expected_document_type.',
                },
              },
              required: ['is_expected_document_type', 'expiry_date', 'confidence', 'matched_qualification', 'nrt_logo_visible'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'record_expiry_date' },
        messages: [
          {
            role: 'user',
            content: [
              docBlock,
              {
                type: 'text',
                text: document_label
                  ? `You are verifying an uploaded document against an expected type: "${document_label}".

First, check whether this document genuinely appears to be a certificate, statement, or card that would contain this qualification — not a different, unrelated document (e.g. a driver's licence, passport, or a different certificate entirely) that simply happens to have a date on it somewhere. Training providers often issue a single combined "Statement of Attainment" listing several separate qualifications together (e.g. First Aid, CPR, and Basic Life Support on the same certificate) — this is normal. Do NOT reject it as a mismatch just because it also lists other, unrelated qualifications, or because its overall title/heading doesn't literally say the expected type. What matters is whether the specific qualification described in "${document_label}" is listed anywhere on the document.

${RTO_COMPLIANCE_NOTE}

Date format: these documents are Australian. When a date is written in ambiguous numeric slash format (e.g. "12/09/26"), read it as DD/MM/YYYY (Australian convention), not MM/DD/YYYY — so "12/09/26" means 12 September 2026, not 9 December 2026. Only use MM/DD if the document itself is unambiguously from a US source and other dates on it are spelled out in a way that confirms it (e.g. "Aug 8, 2026").

Separately, check whether the "Nationally Recognised Training" triangle logo is visible anywhere on the document, and report it in nrt_logo_visible. This is informational only — a genuine certificate can have this logo cropped, blurry, or absent from a scan/photo, so its absence must NOT be used to reject an otherwise valid document.

If it does NOT match, set is_expected_document_type to false, briefly explain what it actually is in mismatch_reason, and set expiry_date to null.

If it DOES match: this document may list several qualifications, each with its own date. Read every line first, then find the expiry date that specifically corresponds to "${document_label}" — do not default to the first or most prominent date on the page if it belongs to a different item. Only use a date that is explicitly printed as a calendar date (e.g. "08/10/2026" or "14 August 2024") functioning as an expiry/valid-until/renewal-due date — never calculate one from an issue date plus a stated renewal period (e.g. "renew annually", "recertify within 12 months", a recertification-period table). Many certificates print a generic renewal-guidance table listing periods like "12 months" or "3 years" per unit — that is NOT a calendar date and must NOT be used to produce one; if the only dated thing on the page is an issue date plus this kind of guidance, expiry_date must be null and confidence low, even though the math is tempting. Separately, also report issue_date if the document explicitly prints an issue/completion/attainment date, even when an expiry date was also found. Record which exact line you matched, including the literal date text as printed.`
                  : 'Set is_expected_document_type to true. Find the expiry date on this document and record it — only if it is explicitly printed as an expiry/valid-until date, never calculated from an issue date plus a renewal period. These documents are Australian: read ambiguous numeric dates (e.g. "12/09/26") as DD/MM/YYYY, not MM/DD/YYYY, unless the document is clearly from a US source. Also report issue_date if one is explicitly printed. If multiple dates appear, note which line each belongs to and pick the one that best represents the document\'s overall expiry. If no explicit expiry date is printed, return null and confidence low. Also report whether the "Nationally Recognised Training" triangle logo is visible anywhere on the document (nrt_logo_visible) — informational only, do not let its absence affect your other answers.',
              },
            ],
          },
        ],
      }),
    });

    if (!claudeResp.ok) {
      throw new Error(`Claude API error (${claudeResp.status}): ${await claudeResp.text()}`);
    }

    const claudeData = await claudeResp.json();
    const toolBlock = claudeData.content.find((b) => b.type === 'tool_use');
    if (!toolBlock) throw new Error('Claude did not return a structured result');

    // Every response returns this same set of keys (null where not applicable),
    // so Bubble's Initialize call captures the full schema no matter which
    // branch happens to run on the test — instead of a different subset each time.
    const respond = (overrides) =>
      res.status(200).json({
        success: false,
        needs_review: true,
        reason: null,
        mismatch_reason: null,
        document_type: null,
        expiry_date: null,
        expiry_source: null,
        issue_date: null,
        matched_qualification: null,
        confidence: null,
        nrt_logo_visible: null,
        expiry_verification_warning: null,
        ...overrides,
      });

    const { is_expected_document_type, mismatch_reason, expiry_date, issue_date, matched_qualification, document_type, confidence, nrt_logo_visible } = toolBlock.input;

    // Trust boundary: don't take Claude's word that a date was "printed" —
    // verify the year it claims actually shows up in the line it quoted.
    // If it doesn't, this is very likely a calculated/inferred date dressed
    // up as a printed one (e.g. issue date + a recertification-period table),
    // so discard it and fall through to the deterministic fallback instead.
    let trustedExpiryDate = expiry_date;
    let expiryVerificationWarning = null;
    if (expiry_date && (!matched_qualification || !matched_qualification.includes(expiry_date.slice(0, 4)))) {
      trustedExpiryDate = null;
      expiryVerificationWarning = 'Claude reported a printed expiry date but its year did not appear in the quoted line — discarded as unverified rather than trusted.';
    }

    // Wrong kind of document entirely -> flag for review, don't write
    if (!is_expected_document_type) {
      return respond({
        reason: 'document_type_mismatch',
        mismatch_reason,
        document_type,
        nrt_logo_visible,
      });
    }

    // No printed expiry, but an issue date + fallback renewal period was given ->
    // calculate the expiry deterministically in code (never trust an LLM to do date math)
    let finalExpiryDate = trustedExpiryDate;
    let expirySource = trustedExpiryDate ? 'printed' : null;

    if (!finalExpiryDate && issue_date && fallback_expiry_months) {
      const months = Number(fallback_expiry_months);
      const d = new Date(`${issue_date}T00:00:00.000Z`);
      d.setUTCMonth(d.getUTCMonth() + months);
      finalExpiryDate = d.toISOString().slice(0, 10);
      expirySource = 'calculated_from_issue_date';
    }

    // Still nothing usable -> flag for manual review, don't write
    if (!finalExpiryDate || (expirySource === 'printed' && confidence === 'low')) {
      return respond({
        expiry_date: finalExpiryDate || null,
        issue_date,
        matched_qualification,
        document_type,
        confidence,
        nrt_logo_visible,
        expiry_verification_warning: expiryVerificationWarning,
      });
    }

    // 3. Write the date back onto the Bubble Thing (Bubble date fields expect ISO 8601)
    // We record it whether it's expired or not — staff still need an accurate
    // date on file, even for a lapsed certificate.
    const isoExpiry = new Date(`${finalExpiryDate}T00:00:00.000Z`).toISOString();
    const bubbleResp = await fetch(`${BUBBLE_BASE}/${type_name}/${thing_id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${api_token}`,
      },
      body: JSON.stringify({ [targetField]: isoExpiry }),
    });

    if (!bubbleResp.ok) {
      throw new Error(`Bubble Data API error (${bubbleResp.status}): ${await bubbleResp.text()}`);
    }

    // Plain date-string comparison against today (server clock, UTC) — deterministic,
    // no LLM involved, same principle as the fallback calculation above.
    const todayStr = new Date().toISOString().slice(0, 10);
    const isExpired = finalExpiryDate < todayStr;

    if (isExpired) {
      return respond({
        success: false,
        needs_review: true,
        reason: 'expired',
        mismatch_reason: `This document is genuine but expired on ${finalExpiryDate}. An updated certificate is required.`,
        expiry_date: finalExpiryDate,
        expiry_source: expirySource,
        issue_date,
        matched_qualification,
        document_type,
        confidence,
        nrt_logo_visible,
        expiry_verification_warning: expiryVerificationWarning,
      });
    }

    return respond({
      success: true,
      needs_review: false,
      expiry_date: finalExpiryDate,
      expiry_source: expirySource,
      issue_date,
      matched_qualification,
      document_type,
      confidence,
      nrt_logo_visible,
      expiry_verification_warning: expiryVerificationWarning,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

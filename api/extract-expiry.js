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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { file_url, type_name, thing_id, field_name, api_token, env, document_label, fallback_expiry_months } = req.body || {};

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
              },
              required: ['is_expected_document_type', 'expiry_date', 'confidence', 'matched_qualification'],
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

If it does NOT match, set is_expected_document_type to false, briefly explain what it actually is in mismatch_reason, and set expiry_date to null.

If it DOES match: this document may list several qualifications, each with its own date. Read every line first, then find the expiry date that specifically corresponds to "${document_label}" — do not default to the first or most prominent date on the page if it belongs to a different item. Only use a date that is explicitly printed as an expiry/valid-until/renewal-due date — never calculate one from an issue date plus a stated renewal period (e.g. "renew annually"). If no explicit expiry date is printed, set expiry_date to null and confidence to low, even if an issue date is shown. Separately, also report issue_date if the document explicitly prints an issue/completion/attainment date, even when an expiry date was also found. Record which exact line you matched.`
                  : 'Set is_expected_document_type to true. Find the expiry date on this document and record it — only if it is explicitly printed as an expiry/valid-until date, never calculated from an issue date plus a renewal period. Also report issue_date if one is explicitly printed. If multiple dates appear, note which line each belongs to and pick the one that best represents the document\'s overall expiry. If no explicit expiry date is printed, return null and confidence low.',
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
        ...overrides,
      });

    const { is_expected_document_type, mismatch_reason, expiry_date, issue_date, matched_qualification, document_type, confidence } = toolBlock.input;

    // Wrong kind of document entirely -> flag for review, don't write
    if (!is_expected_document_type) {
      return respond({
        reason: 'document_type_mismatch',
        mismatch_reason,
        document_type,
      });
    }

    // No printed expiry, but an issue date + fallback renewal period was given ->
    // calculate the expiry deterministically in code (never trust an LLM to do date math)
    let finalExpiryDate = expiry_date;
    let expirySource = expiry_date ? 'printed' : null;

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
      });
    }

    // 3. Write the date back onto the Bubble Thing (Bubble date fields expect ISO 8601)
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

    return respond({
      success: true,
      needs_review: false,
      expiry_date: finalExpiryDate,
      expiry_source: expirySource,
      issue_date,
      matched_qualification,
      document_type,
      confidence,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

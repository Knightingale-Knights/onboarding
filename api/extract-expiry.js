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

  const { file_url, type_name, thing_id, field_name, api_token, env, document_label } = req.body || {};

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
                  description: 'True if the document genuinely matches the expected type described in the prompt (or true by default if no specific type was requested). False if it is clearly a different, unrelated document (e.g. a driver\'s licence or passport when a certificate was expected) that just happens to have some date on it.',
                },
                mismatch_reason: {
                  type: 'string',
                  description: 'If is_expected_document_type is false, briefly explain what the document actually appears to be instead. Omit if true.',
                },
                expiry_date: {
                  type: ['string', 'null'],
                  description: 'Expiry date in YYYY-MM-DD format, or null if none is visible or the document type does not match.',
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

First, check whether this document genuinely appears to be a certificate, statement, or card that would contain this qualification — not a different, unrelated document (e.g. a driver's licence, passport, or a different certificate entirely) that simply happens to have a date on it somewhere.

If it does NOT match, set is_expected_document_type to false, briefly explain what it actually is in mismatch_reason, and set expiry_date to null.

If it DOES match: this document may list several qualifications, each with its own date. Read every line first, then find the expiry date that specifically corresponds to "${document_label}" — do not default to the first or most prominent date on the page if it belongs to a different item. Record which exact line you matched.`
                  : 'Set is_expected_document_type to true. Find the expiry date on this document and record it. If multiple dates appear, note which line each belongs to and pick the one that best represents the document\'s overall expiry.',
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

    const { is_expected_document_type, mismatch_reason, expiry_date, matched_qualification, document_type, confidence } = toolBlock.input;

    // Wrong kind of document entirely -> flag for review, don't write
    if (!is_expected_document_type) {
      return res.status(200).json({
        success: false,
        needs_review: true,
        reason: 'document_type_mismatch',
        mismatch_reason,
        document_type,
        expiry_date: null,
      });
    }

    // Low confidence or no date found -> flag for manual review, don't write
    if (!expiry_date || confidence === 'low') {
      return res.status(200).json({
        success: false,
        needs_review: true,
        expiry_date: expiry_date || null,
        matched_qualification,
        document_type,
        confidence,
      });
    }

    // 3. Write the date back onto the Bubble Thing (Bubble date fields expect ISO 8601)
    const isoExpiry = new Date(`${expiry_date}T00:00:00.000Z`).toISOString();
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

    return res.status(200).json({
      success: true,
      needs_review: false,
      expiry_date,
      matched_qualification,
      document_type,
      confidence,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

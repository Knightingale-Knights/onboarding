// POST /api/extract-expiry
// Body: { file_url, type_name, thing_id, field_name?, api_token }
//
// 1. Downloads the document image from Bubble's file_url
// 2. Sends it to Claude with a forced tool call for structured extraction
// 3. Writes the expiry date back onto the given Bubble Thing via the Data API
//    (skipped if Claude's confidence is low, or no date is found — the caller
//    gets needs_review: true instead so it can be routed for manual check)

const BUBBLE_BASE = 'https://knightingale.com.au/api/1.1/obj';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { file_url, type_name, thing_id, field_name, api_token } = req.body || {};

  if (!file_url || !type_name || !thing_id || !api_token) {
    return res.status(400).json({
      error: 'Missing required field(s): file_url, type_name, thing_id, api_token',
    });
  }

  const targetField = field_name || 'date';

  try {
    // 1. Fetch and base64-encode the document
    const fileResp = await fetch(file_url);
    if (!fileResp.ok) {
      throw new Error(`Could not fetch file_url (${fileResp.status})`);
    }
    const mediaType = fileResp.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await fileResp.arrayBuffer());
    const base64 = buffer.toString('base64');

    // 2. Ask Claude to extract the expiry date as structured JSON
    const isPdf = mediaType.includes('pdf') || file_url.toLowerCase().includes('.pdf');
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
                expiry_date: {
                  type: ['string', 'null'],
                  description: 'Expiry date in YYYY-MM-DD format, or null if none is visible.',
                },
                document_type: {
                  type: 'string',
                  description: "Best guess at the document type, e.g. 'drivers licence', 'passport', 'first aid certificate'.",
                },
                confidence: {
                  type: 'string',
                  enum: ['high', 'medium', 'low'],
                  description: 'Confidence that expiry_date is correct.',
                },
              },
              required: ['expiry_date', 'confidence'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'record_expiry_date' },
        messages: [
          {
            role: 'user',
            content: [
              docBlock,
              { type: 'text', text: 'Find the expiry date on this document and record it.' },
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

    const { expiry_date, document_type, confidence } = toolBlock.input;

    // Low confidence or no date found -> flag for manual review, don't write
    if (!expiry_date || confidence === 'low') {
      return res.status(200).json({
        success: false,
        needs_review: true,
        expiry_date: expiry_date || null,
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
      document_type,
      confidence,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

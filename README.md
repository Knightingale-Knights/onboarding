# onboarding

Extracts the expiry date from an uploaded document (ID, certificate, etc.) using
Claude vision, and writes it back to a Bubble Thing.

## Endpoint

`POST /api/extract-expiry`

```json
{
  "file_url": "https://.../uploaded-file.jpg",
  "type_name": "User",
  "thing_id": "168...x1",
  "field_name": "date",
  "api_token": "your-bubble-api-token"
}
```

Response:

```json
{ "success": true, "needs_review": false, "expiry_date": "2027-03-15", "document_type": "drivers licence", "confidence": "high" }
```

If Claude can't find a date or isn't confident, nothing is written to Bubble —
you get back `"success": false, "needs_review": true"` instead, so the workflow
can route it to a manual-check step rather than saving a bad date.

## Deploy

1. Push this repo to `Knightingale-Knights/onboarding` on GitHub
2. Import into Vercel
3. Add env var `ANTHROPIC_API_KEY` in Vercel project settings
4. Note the deployed URL, e.g. `https://onboarding-xxxx.vercel.app`

## Wire up in Bubble

1. File uploader element on the form → gives you the file's URL
2. Backend workflow (API Connector call or "Call an external API" action) →
   POST to `https://onboarding-xxxx.vercel.app/api/extract-expiry` with the
   body above (`api_token` = your Bubble API token, from Settings → API)
3. On response, branch on `success` — if `true`, the Thing's field is already
   updated; if `false`/`needs_review`, show it in a review queue for you to
   check manually

Reusing for other document types: just pass a different `type_name` /
`field_name` per call — no code changes needed.

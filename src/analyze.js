/**
 * Document/image analysis using Claude Vision API.
 * Handles images of documents, receipts, screenshots, etc.
 */

/**
 * Analyze an image buffer using Claude's vision capabilities.
 * @param {Buffer} imageBuffer - The image binary data
 * @param {string} mimeType - MIME type (image/jpeg, image/png, etc.)
 * @param {string} prompt - What to analyze (e.g., "summarize this document")
 * @returns {string} Analysis result
 */
export async function analyzeImage(imageBuffer, mimeType, prompt) {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();

    const base64 = imageBuffer.toString('base64');
    const mediaType = mimeType.includes('png') ? 'image/png'
      : mimeType.includes('webp') ? 'image/webp'
      : mimeType.includes('gif') ? 'image/gif'
      : 'image/jpeg';

    const userPrompt = prompt || 'Analyze this document/image. Provide a clear summary of its contents. If it contains text, extract the key information. If it is a receipt, list the items and totals. If it is a form or official document, summarize the important details.';

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          {
            type: 'text',
            text: userPrompt,
          },
        ],
      }],
    });

    return response.content[0]?.text || 'Could not analyze the image.';
  } catch (err) {
    console.error('[Analyze] Error:', err.message);
    return `Failed to analyze: ${err.message}`;
  }
}

/**
 * Analyze a PDF by converting pages to description.
 * Claude can't directly read PDFs via vision, but we can extract text.
 */
export async function analyzePdfBuffer(pdfBuffer, prompt) {
  try {
    // PDFs can be sent as documents to Claude's API using the document type
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();

    const base64 = pdfBuffer.toString('base64');

    const userPrompt = prompt || 'Analyze this PDF document. Provide a comprehensive summary of its contents, key points, and any important details.';

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          },
          {
            type: 'text',
            text: userPrompt,
          },
        ],
      }],
    });

    return response.content[0]?.text || 'Could not analyze the PDF.';
  } catch (err) {
    console.error('[Analyze PDF] Error:', err.message);
    // Fallback: if document type not supported, inform user
    return `Failed to analyze PDF: ${err.message}`;
  }
}

/**
 * Scan a receipt image and extract expense data.
 * Returns { amount, currency, description, category } or null.
 */
export async function scanReceipt(imageBuffer, mimeType) {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();

    const base64 = imageBuffer.toString('base64');
    const mediaType = mimeType.includes('png') ? 'image/png' : 'image/jpeg';

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: 'Extract expense info from this receipt/bill. Return ONLY valid JSON: { "amount": number, "currency": "JOD" or "USD" etc, "description": "store or vendor name", "category": "food|transport|shopping|bills|entertainment|other" }. If not a receipt, return { "error": "not a receipt" }.' },
        ],
      }],
    });

    const text = response.content[0]?.text?.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    if (!text) return null;
    const data = JSON.parse(text);
    if (data.error) return null;
    return data;
  } catch (err) {
    console.error('[Receipt Scan] Error:', err.message);
    return null;
  }
}

/* ══════════════════════════════════════════════
   NETLIFY FUNCTION — CONTACT FORM HANDLER
   File location: netlify/functions/contact.js

   This function runs server-side on Netlify's infrastructure.
   It receives the contact form submission from the browser,
   validates the required fields, and sends an email via Resend.

   Why server-side:
   - The Resend API key must never be exposed in browser code
   - Netlify stores it as an environment variable (RESEND_API_KEY)
   - This function reads it securely at runtime

   How it's triggered:
   - The contact form in index.html POSTs JSON to /.netlify/functions/contact
   - Netlify automatically routes that URL to this file
   - No additional routing configuration required

   Environment variables required (set in Netlify dashboard):
   - RESEND_API_KEY: your Resend API key (from resend.com dashboard)
   - CONTACT_EMAIL: the address to deliver submissions to
     (info@beneficialenterprisegroup.com)
   ══════════════════════════════════════════════ */

exports.handler = async function(event) {

  /* ── Only accept POST requests ──
     GET requests to this URL (e.g. someone typing it in a browser)
     should be rejected immediately with a 405 Method Not Allowed response. */
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  /* ── Parse the incoming JSON body ──
     event.body is a raw string — JSON.parse converts it to a JavaScript object.
     The try/catch handles the case where the body is malformed or empty. */
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (err) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  /* ── Extract and validate required fields ──
     Destructure the expected fields from the parsed payload.
     from_name and from_email are the minimum required fields —
     same validation as the client-side check in index.html. */
  const { from_name, from_email, company, interest, message } = payload;

  if (!from_name || !from_email) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Name and email are required' })
    };
  }

  /* ── Read environment variables ──
     These are set in the Netlify dashboard under Site settings → Environment variables.
     They are never hardcoded here — the function reads them at runtime.
     If either is missing the function will fail with a clear error. */
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const CONTACT_EMAIL  = process.env.CONTACT_EMAIL;

  if (!RESEND_API_KEY || !CONTACT_EMAIL) {
    console.error('Missing environment variables: RESEND_API_KEY or CONTACT_EMAIL');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server configuration error' })
    };
  }

  /* ── Build the email content ──
     Plain HTML email with the form fields laid out clearly.
     The from address uses your verified domain so Resend will send it.
     reply-to is set to the submitter's email so you can reply directly
     from your inbox without copying the address manually. */
  const emailHtml = `
    <h2>New Contact Form Submission</h2>
    <p><strong>Name:</strong> ${from_name}</p>
    <p><strong>Email:</strong> ${from_email}</p>
    <p><strong>Company:</strong> ${company || 'Not provided'}</p>
    <p><strong>Interest:</strong> ${interest || 'Not specified'}</p>
    <p><strong>Message:</strong></p>
    <p>${message || 'No message provided'}</p>
    <hr>
    <p style="color:#888;font-size:12px;">Submitted via beneficialenterprisegroup.com contact form</p>
  `;

  /* ── Send email via Resend API ──
     POST to Resend's /emails endpoint with the email payload.
     Authorization header carries the API key as a Bearer token.
     The from address must use your verified domain. */
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`, /* Resend API key — from env var */
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `Beneficial Enterprise Group <info@beneficialenterprisegroup.com>`, /* Verified sender */
        to:   [CONTACT_EMAIL],          /* Destination — set in Netlify env vars */
        reply_to: from_email,           /* Submitter's email — enables direct reply */
        subject: `New inquiry from ${from_name} — ${interest || 'General'}`, /* Clear subject line */
        html: emailHtml                 /* The formatted email body built above */
      })
    });

    /* ── Handle Resend API response ──
       If Resend returns a non-2xx status, log the error and return 500.
       The browser will show the fallback alert with the direct email address. */
    if (!response.ok) {
      const errorData = await response.json();
      console.error('Resend API error:', errorData);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to send email' })
      };
    }

    /* ── Success ──
       Return 200 — the browser contact form shows the success confirmation screen. */
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true })
    };

  } catch (err) {
    /* Network error or unexpected failure — log and return 500 */
    console.error('Contact function error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }

};


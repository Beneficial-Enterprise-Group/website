/* ══════════════════════════════════════════════
   BENEFICIAL ENTERPRISE GROUP — DAILY CONTENT AGENT
   File location: agent/agent.js

   PURPOSE:
   This agent runs on a schedule via GitHub Actions.
   It calls the Anthropic API (Claude) with web search enabled
   to find real current news and research, then inserts content
   into the Supabase database which the website reads dynamically.

   SCHEDULE:
   - Feed entries: runs every day at 6am EST
   - Insight articles: runs every Monday at 6am EST
     (controlled by the RUN_MODE environment variable set in GitHub Actions)

   ON/OFF SWITCHES:
   Both agents can be paused without touching GitHub Actions.
   Flip feed_agent_enabled or insight_agent_enabled to 'false'
   in the Supabase agent_settings table to pause the relevant agent.

   ENVIRONMENT VARIABLES (stored as GitHub Actions secrets):
   - ANTHROPIC_API_KEY: Anthropic API key for Claude access
   - SUPABASE_URL: your Supabase project URL
   - SUPABASE_SERVICE_KEY: service role key — bypasses RLS for writes
   - RUN_MODE: 'feed' for daily run, 'insights' for Monday run
   ══════════════════════════════════════════════ */

/* ── Import dependencies ──
   @supabase/supabase-js: official Supabase client for database operations
   node-fetch: adds fetch() to Node.js for HTTP calls to the Anthropic API */
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import ws from 'ws';

/* ── Read environment variables ──
   These are never hardcoded — they are injected by GitHub Actions at runtime
   from encrypted secrets stored in the repository settings. */
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RUN_MODE            = process.env.RUN_MODE || 'feed'; /* 'feed' or 'insights' */

/* ── Validate required environment variables ──
   If any are missing the agent exits immediately with a clear error message.
   This prevents silent failures where the agent runs but does nothing. */
if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: Missing required environment variables.');
  console.error('Required: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1); /* Exit with error code — GitHub Actions will mark the run as failed */
}

/* ── Initialize Supabase client with service role key ──
   The service role key bypasses Row Level Security — the agent needs full
   write access to insert new content and update agent_runs records.
   This key is NEVER used in browser code — server/agent only. */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  realtime: {
    transport: ws  /* Required for Node.js versions below 22 */
  }
});


/* ══════════════════════════════════════════════
   ANTHROPIC API CALL
   Core function that sends a prompt to Claude with web search enabled.
   Returns the full text response from Claude.

   The web search tool allows Claude to find real current articles
   rather than generating content from training data alone.
   This is what ensures every feed entry has a real verifiable source URL.
   ══════════════════════════════════════════════ */
async function callClaude(prompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,       /* Authenticates the request */
      'anthropic-version': '2023-06-01',    /* Required — specifies API version */
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',           /* Sonnet balances quality and cost */
      max_tokens: 4000,                      /* Enough for articles + feed entries */
      tools: [
        {
          type: 'web_search_20250305',       /* Enables real-time web search */
          name: 'web_search'
        }
      ],
      messages: [
        {
          role: 'user',
          content: prompt                    /* The prompt built by each run function */
        }
      ]
    })
  });

  /* Check for HTTP errors from the Anthropic API */
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Anthropic API error: ${JSON.stringify(error)}`);
  }

  const data = await response.json();

  /* Extract the text content from the response.
     Claude's response may contain multiple content blocks (text + tool_use).
     We join all text blocks into one string. */
  const textContent = data.content
    .filter(block => block.type === 'text') /* Only text blocks, not tool_use blocks */
    .map(block => block.text)
    .join('\n');

  return textContent;
}


/* ══════════════════════════════════════════════
   CHECK AGENT SETTINGS
   Reads the on/off switch from the agent_settings table in Supabase.
   Returns true if the agent should run, false if it should stop.

   To pause an agent: go to Supabase → Table Editor → agent_settings
   and change the value for feed_agent_enabled or insight_agent_enabled to 'false'.
   ══════════════════════════════════════════════ */
async function isAgentEnabled(settingKey) {
  const { data, error } = await supabase
    .from('agent_settings')
    .select('value')
    .eq('key', settingKey)  /* Find the row with the matching key */
    .single();              /* Expect exactly one row */

  if (error) {
    /* If the setting can't be read, default to enabled to avoid false stops */
    console.warn(`Could not read setting ${settingKey}:`, error.message);
    return true;
  }

  return data.value === 'true'; /* Only runs if value is exactly the string 'true' */
}


/* ══════════════════════════════════════════════
   PARSE JSON FROM CLAUDE RESPONSE
   Claude is prompted to return JSON but may wrap it in markdown code fences.
   This function strips the fences and parses the clean JSON.

   Example of what Claude might return:
   ```json
   { "entries": [...] }
   ```
   This function returns the parsed object: { entries: [...] }
   ══════════════════════════════════════════════ */
function parseJSON(text) {
  /* Remove markdown code fences if present — ```json ... ``` */
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
}


/* ══════════════════════════════════════════════
   DAILY FEED AGENT
   Searches for real current news about legacy ERP and API integration.
   Generates 4 feed entries and inserts them into Supabase feed_entries table.
   Runs every day at 6am EST via GitHub Actions.
   ══════════════════════════════════════════════ */
async function runFeedAgent(agentRunId) {
  console.log('Starting feed agent...');

  /* Build the prompt for Claude.
     The JSON format instruction is precise — this is what allows reliable parsing.
     The quality rules match the project brief requirements. */
  const prompt = `Search the web for recent news and research (last 30 days) about:
- Legacy ERP modernization and implementation failures
- API middleware and integration strategies for legacy systems
- Distribution, manufacturing, healthcare, or financial services technology

Generate exactly 4 feed entries based on REAL articles you find. Return ONLY this JSON with no other text:

{
  "entries": [
    {
      "title": "Headline of the article or finding",
      "category": "One of: ERP Failure, API Strategy, Distribution, Manufacturing, Healthcare, Financial Services",
      "snippet": "2-3 sentence summary of the key finding or news. Be specific with numbers and facts.",
      "source_name": "Publication or organization name",
      "source_url": "Full URL to the real article"
    }
  ]
}

RULES — follow these exactly:
- Every entry MUST have a real verifiable source URL you actually found
- Never fabricate statistics or attribute quotes to sources that don't contain them
- Snippet must be 2-3 sentences only — no longer
- If you cannot find 4 real sources, return fewer entries rather than fabricating
- Categories must be exactly one of the options listed above`;

  /* Call Claude with web search enabled */
  const responseText = await callClaude(prompt);

  /* Parse the JSON response */
  let parsed;
  try {
    parsed = parseJSON(responseText);
  } catch (err) {
    throw new Error(`Failed to parse feed entries JSON: ${err.message}\nResponse: ${responseText}`);
  }

  const entries = parsed.entries || [];

  /* Quality gate — skip insert if fewer than 2 real sources found */
  if (entries.length < 2) {
    console.warn(`Quality gate: only ${entries.length} entries found. Skipping insert.`);
    return 0;
  }

  /* Insert all entries into Supabase feed_entries table */
  const rows = entries.map(e => ({
    title:        e.title,
    category:     e.category,
    snippet:      e.snippet,
    source_name:  e.source_name,
    source_url:   e.source_url,
    active:       true,           /* Immediately visible on the website */
    agent_run_id: agentRunId      /* Links back to this agent run for auditing */
  }));

  const { error } = await supabase
    .from('feed_entries')
    .insert(rows);

  if (error) throw new Error(`Supabase insert error (feed_entries): ${error.message}`);

  console.log(`Feed agent complete — inserted ${rows.length} entries`);
  return rows.length;
}


/* ══════════════════════════════════════════════
   MONDAY INSIGHT AGENT
   Generates 2 long-form insight articles — one per category.
   Each article is 400-600 words, grounded in real research.
   Inserts into insight_articles and insight_sources tables.
   Runs every Monday at 6am EST via GitHub Actions.
   ══════════════════════════════════════════════ */
async function runInsightAgent(agentRunId) {
  console.log('Starting insight agent...');

  let totalArticles = 0;

  /* Generate one article per category — two categories total */
  const categories = [
    {
      category: 'Why ERP Replacements Fail',
      focus: 'the risks, costs, hidden expenses, and failure rates of full ERP replacement projects. Include real statistics and case studies where possible.'
    },
    {
      category: 'API Layer vs. Replacement',
      focus: 'when and why building an API middleware layer is a better choice than replacing a legacy ERP. Include real market data and specific use cases.'
    }
  ];

  for (const cat of categories) {
    console.log(`Generating article for category: ${cat.category}`);

    /* Build the prompt for this category's article */
    const prompt = `Search the web for recent research, statistics, and case studies about ${cat.focus}

Write one insight article for an IT director or operations leader audience. Return ONLY this JSON with no other text:

{
  "title": "Article headline — specific and outcome-focused",
  "category": "${cat.category}",
  "body": "Full article body — 400 to 600 words. Use double newlines between paragraphs. Ground every claim in real research you found. Never fabricate statistics.",
  "sources": [
    {
      "source_name": "Publication or organization name",
      "source_url": "Full URL to the real source",
      "display_order": 1
    }
  ]
}

RULES — follow these exactly:
- Body must be 400-600 words — no shorter, no longer
- Minimum 2 real verifiable sources — skip article if you cannot find them
- Never fabricate statistics or attribute quotes to sources that don't contain them
- Write for a senior operations or IT decision maker — direct, no fluff
- Paragraphs separated by double newlines only — no markdown headers or bullets
- Sources must be real URLs you actually found during your search`;

    /* Call Claude with web search enabled */
    const responseText = await callClaude(prompt);

    /* Parse the JSON response */
    let parsed;
    try {
      parsed = parseJSON(responseText);
    } catch (err) {
      console.error(`Failed to parse insight article JSON for ${cat.category}:`, err.message);
      continue; /* Skip this article and move to the next category */
    }

    /* Quality gate — skip if fewer than 2 sources found */
    if (!parsed.sources || parsed.sources.length < 2) {
      console.warn(`Quality gate: insufficient sources for ${cat.category}. Skipping.`);
      continue;
    }

    /* Insert the article into insight_articles table */
    const { data: articleData, error: articleError } = await supabase
      .from('insight_articles')
      .insert({
        title:        parsed.title,
        category:     parsed.category,
        body:         parsed.body,
        active:       true,           /* Immediately visible on the website */
        agent_run_id: agentRunId      /* Links back to this agent run */
      })
      .select()                       /* Return the inserted row so we get the new article id */
      .single();

    if (articleError) {
      console.error(`Supabase insert error (insight_articles):`, articleError.message);
      continue;
    }

    /* Insert all sources linked to this article */
    const sourceRows = parsed.sources.map(s => ({
      article_id:    articleData.id,   /* Foreign key — links source to its parent article */
      source_name:   s.source_name,
      source_url:    s.source_url,
      display_order: s.display_order
    }));

    const { error: sourcesError } = await supabase
      .from('insight_sources')
      .insert(sourceRows);

    if (sourcesError) {
      console.error(`Supabase insert error (insight_sources):`, sourcesError.message);
      /* Article was inserted — log the source error but don't fail the whole run */
    }

    /* Deactivate the previous article in this category so only 1 per category shows */
    const { error: deactivateError } = await supabase
      .from('insight_articles')
      .update({ active: false })
      .eq('category', cat.category)   /* Same category */
      .neq('id', articleData.id)      /* Not the one we just inserted */
      .eq('active', true);            /* Only currently active ones */

    if (deactivateError) {
      console.error(`Error deactivating old articles for ${cat.category}:`, deactivateError.message);
    }

    console.log(`Insight article inserted for category: ${cat.category}`);
    totalArticles++;
  }

  console.log(`Insight agent complete — inserted ${totalArticles} articles`);
  return totalArticles;
}


/* ══════════════════════════════════════════════
   MAIN ENTRY POINT
   Creates an agent_run record, checks the on/off switch,
   runs the appropriate agent, and updates the run record with results.
   All errors are caught and logged — the run record is always updated
   so you can see what happened in the Supabase agent_runs table.
   ══════════════════════════════════════════════ */
async function main() {
  console.log(`Agent starting — RUN_MODE: ${RUN_MODE}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);

  /* Determine which setting key to check based on run mode */
  const settingKey = RUN_MODE === 'insights' ? 'insight_agent_enabled' : 'feed_agent_enabled';

  /* Check the on/off switch in Supabase before doing anything */
  const enabled = await isAgentEnabled(settingKey);
  if (!enabled) {
    console.log(`Agent is disabled via ${settingKey} setting. Exiting.`);
    process.exit(0); /* Clean exit — not an error */
  }

  /* Create an agent_run record to track this run */
  const { data: runData, error: runError } = await supabase
    .from('agent_runs')
    .insert({
      run_at: new Date().toISOString(),
      feed_entries_created: 0,
      insight_articles_created: 0,
      status: 'running',              /* Will be updated to 'success' or 'failed' */
      notes: `RUN_MODE: ${RUN_MODE}`
    })
    .select()
    .single();

  if (runError) {
    console.error('Failed to create agent_run record:', runError.message);
    process.exit(1);
  }

  const agentRunId = runData.id;
  console.log(`Agent run ID: ${agentRunId}`);

  /* Run the appropriate agent and track results */
  let feedCount = 0;
  let insightCount = 0;
  let status = 'success';
  let notes = `RUN_MODE: ${RUN_MODE}`;

  try {
    if (RUN_MODE === 'insights') {
      /* Monday run — generate insight articles */
      insightCount = await runInsightAgent(agentRunId);
    } else {
      /* Daily run — generate feed entries */
      feedCount = await runFeedAgent(agentRunId);
    }
  } catch (err) {
    /* Catch any unexpected errors and record them */
    console.error('Agent run failed:', err.message);
    status = 'failed';
    notes = `${notes} | Error: ${err.message}`;
  }

  /* Update the agent_run record with the final results */
  await supabase
    .from('agent_runs')
    .update({
      feed_entries_created:     feedCount,
      insight_articles_created: insightCount,
      status:                   status,
      notes:                    notes
    })
    .eq('id', agentRunId);

  console.log(`Agent run complete — status: ${status}`);
  console.log(`Feed entries created: ${feedCount}`);
  console.log(`Insight articles created: ${insightCount}`);

  /* Exit with error code if the run failed — GitHub Actions will flag it */
  if (status === 'failed') process.exit(1);
}

/* Start the agent */
main();

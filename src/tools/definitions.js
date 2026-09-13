// Tool definitions for Claude tool_use
export const TOOL_DEFINITIONS = [
  {
    name: 'spire_presence',
    description: "Who is inside THE SPIRE right now — the Legal Quants' 3D venue at spire.lquorum.blog (floors: lobby, chambers, council, auditorium, garden, arcade, library, oracle). Returns live people and agents by floor from the venue itself. Use for 'anyone in the spire', 'who's in the venue', 'is anyone online in the spire'. The Spire is NOT one of the steads games — Moorstead/Saltstead/Marsstead questions use steads_status instead.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'spire_feedback',
    description: "File a Spire bug report or suggestion onto the venue's Boardroom wall for James. Use whenever someone reports a Spire problem or idea (especially in the Spire Testers group). from = the reporter's name, text = their report, verbatim or lightly tidied.",
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: "The reporter's name." },
        text: { type: 'string', description: 'The bug report or suggestion.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'spire_health',
    description: "Quick live health check of the Spire venue: is it serving, what version, and is the voice signal endpoint up. Use for 'is the spire up', 'is the spire down', 'spire broken?'.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'steads_status',
    description: "Status across all three of James's OWN games (Moorstead, Saltstead, Marsstead): who is online now, today's real visitor/player counts, and whether VESPER (Marsstead's AI) is up. Use for 'how are the steads', 'anyone playing', 'steads status'. Owner-only.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'steads_mint',
    description: "Mint an invite code for one of James's games and return it to hand out. game is 'moorstead', 'saltstead' or 'marsstead'. Set warden:true for a warden code (saltstead/marsstead). For moorstead, optionally set room (moor/dale/crag/tarn/bairns). Owner-only.",
    input_schema: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: ['moorstead', 'saltstead', 'marsstead'], description: 'Which game.' },
        warden: { type: 'boolean', description: 'Mint a warden code (saltstead/marsstead).' },
        room: { type: 'string', description: 'World-room (moorstead only).' },
      },
      required: ['game'],
    },
  },
  {
    name: 'steads_revoke',
    description: "Stage revoking an invite code for a game - does NOT execute, returns a confirm_id. game is moorstead/saltstead/marsstead; code is the invite code. Owner-only, confirm-gated.",
    input_schema: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: ['moorstead', 'saltstead', 'marsstead'] },
        code: { type: 'string', description: 'The invite code to revoke.' },
      },
      required: ['game', 'code'],
    },
  },
  {
    name: 'steads_revoke_confirm',
    description: 'Confirm and execute a previously staged code revocation. Requires the confirm_id from steads_revoke. Single-use. Owner-only.',
    input_schema: {
      type: 'object',
      properties: { confirm_id: { type: 'string', description: 'The confirm_id from steads_revoke.' } },
      required: ['confirm_id'],
    },
  },
  {
    name: 'steads_mute',
    description: "Mute or unmute Clint's live game notifications (visits, plays, bugs). on:true mutes, on:false unmutes. Resets to unmuted on restart. Owner-only.",
    input_schema: {
      type: 'object',
      properties: { on: { type: 'boolean', description: 'true to mute, false to unmute.' } },
      required: [],
    },
  },

  // === GOOGLE CALENDAR ===
  {
    name: 'calendar_list_events',
    description: 'List upcoming events from Google Calendar. Returns events for the specified number of days ahead.',
    input_schema: {
      type: 'object',
      properties: {
        days_ahead: {
          type: 'number',
          description: 'Number of days to look ahead. Default 7.',
        },
        query: {
          type: 'string',
          description: 'Optional search query to filter events.',
        },
      },
      required: [],
    },
  },
  {
    name: 'calendar_create_event',
    description: 'Create a new Google Calendar event.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Event title.',
        },
        start: {
          type: 'string',
          description: 'Start datetime in ISO 8601 format (e.g., 2026-03-15T10:00:00). Use Europe/London timezone.',
        },
        end: {
          type: 'string',
          description: 'End datetime in ISO 8601 format. If not provided, defaults to 1 hour after start.',
        },
        description: {
          type: 'string',
          description: 'Optional event description.',
        },
        location: {
          type: 'string',
          description: 'Optional event location.',
        },
      },
      required: ['summary', 'start'],
    },
  },
  {
    name: 'calendar_update_event',
    description: 'Update an existing Google Calendar event. Use calendar_list_events first to get the event ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'The event ID from calendar_list_events.',
        },
        summary: {
          type: 'string',
          description: 'New event title (optional — only include to change).',
        },
        start: {
          type: 'string',
          description: 'New start date/time. Use YYYY-MM-DD for all-day or ISO 8601 for timed events.',
        },
        end: {
          type: 'string',
          description: 'New end date/time. For all-day events, use the day AFTER the last day (Google Calendar exclusive end).',
        },
        description: {
          type: 'string',
          description: 'New event description.',
        },
        location: {
          type: 'string',
          description: 'New event location.',
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'calendar_find_free_time',
    description: 'Check calendar availability for a specific date or date range.',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Date to check in YYYY-MM-DD format.',
        },
        days: {
          type: 'number',
          description: 'Number of days to check. Default 1.',
        },
      },
      required: ['date'],
    },
  },

  // === GMAIL ===
  {
    name: 'gmail_search',
    description: 'Search Gmail inbox. Returns message summaries.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Gmail search query (same syntax as Gmail search bar). E.g., "from:john subject:meeting is:unread"',
        },
        max_results: {
          type: 'number',
          description: 'Max results to return. Default 10.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'gmail_read',
    description: 'Read the full content of a specific email by ID.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'The Gmail message ID to read.',
        },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_draft',
    description: 'Create a draft email (does NOT send). Always use this first — James must confirm before sending. Returns draft ID and preview.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address.',
        },
        subject: {
          type: 'string',
          description: 'Email subject line.',
        },
        body: {
          type: 'string',
          description: 'Email body text.',
        },
        thread_id: {
          type: 'string',
          description: 'Optional thread ID to reply to an existing conversation.',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'gmail_confirm_send',
    description: 'Send an existing draft email. ONLY call this after James has explicitly confirmed he wants the draft sent. Requires the draft ID from gmail_draft.',
    input_schema: {
      type: 'object',
      properties: {
        draft_id: {
          type: 'string',
          description: 'The draft ID returned by gmail_draft.',
        },
      },
      required: ['draft_id'],
    },
  },

  // === LIVE TRAVEL DATA ===
  {
    name: 'train_departures',
    description: 'Get live train departure board from National Rail Darwin. Shows next trains, platforms, delays, and cancellations. Use for "when\'s the next train to York?" or "any delays at Kings Cross?"',
    input_schema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Departure station CRS code (e.g., "KGX" for Kings Cross, "YRK" for York, "LDS" for Leeds).',
        },
        to: {
          type: 'string',
          description: 'Optional destination CRS code to filter departures.',
        },
      },
      required: ['from'],
    },
  },
  {
    name: 'train_fares',
    description: 'Get actual ticket prices for a rail journey. Shows Advance, Off-Peak, and Anytime fares. Use for "how much are tickets to York?" or "cheapest train fare Kings Cross to York".',
    input_schema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Origin station CRS code (e.g., "KGX").',
        },
        to: {
          type: 'string',
          description: 'Destination station CRS code (e.g., "YRK").',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'hotel_search',
    description: 'Search for hotels with real-time prices and availability via Amadeus. Supports search by coordinates or area name (e.g., "north_york_moors", "helmsley", "york"). Use for "find a hotel near Helmsley for this weekend".',
    input_schema: {
      type: 'object',
      properties: {
        area: {
          type: 'string',
          description: 'Named area: "north_york_moors", "york", "helmsley", "pickering", "whitby", "malton", "scarborough". Resolves to coordinates automatically.',
        },
        latitude: {
          type: 'number',
          description: 'Latitude for custom location search. Overrides area.',
        },
        longitude: {
          type: 'number',
          description: 'Longitude for custom location search. Overrides area.',
        },
        checkin: {
          type: 'string',
          description: 'Check-in date YYYY-MM-DD.',
        },
        checkout: {
          type: 'string',
          description: 'Check-out date YYYY-MM-DD.',
        },
        adults: {
          type: 'number',
          description: 'Number of adults. Default 2.',
        },
        radius: {
          type: 'number',
          description: 'Search radius in km. Default 30.',
        },
      },
      required: ['checkin', 'checkout'],
    },
  },

  // === TRAVEL BOOKING LINKS ===
  {
    name: 'search_trains',
    description: 'Search for train tickets (LNER, National Rail). Supports single journeys, returns, and multi-leg weekend trips. For James\'s York visits, use legs for complex patterns (e.g. 4-trip weekends).',
    input_schema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Departure station (e.g., "London Kings Cross", "York"). Used for single/return journeys or as default for legs.',
        },
        to: {
          type: 'string',
          description: 'Arrival station. Used for single/return journeys or as default for legs.',
        },
        date: {
          type: 'string',
          description: 'Travel date YYYY-MM-DD. Used for single journey or as default for legs.',
        },
        time: {
          type: 'string',
          description: 'Preferred departure time (e.g., "18:00"). Used for single journey or as default for legs.',
        },
        return_date: {
          type: 'string',
          description: 'Return date for simple return tickets.',
        },
        legs: {
          type: 'array',
          description: 'For multi-leg trips (e.g. 4-trip weekends). Each leg has from, to, date, and optional time. Overrides single journey params.',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'Departure station for this leg.' },
              to: { type: 'string', description: 'Arrival station for this leg.' },
              date: { type: 'string', description: 'Date YYYY-MM-DD for this leg.' },
              time: { type: 'string', description: 'Preferred time for this leg.' },
            },
            required: ['from', 'to', 'date'],
          },
        },
      },
      required: ['from', 'to', 'date'],
    },
  },
  {
    name: 'search_accommodation',
    description: 'Search for accommodation. Has special North York Moors support — use area="north_york_moors" or mention "moors" in location for NYM-specific results with local area knowledge.',
    input_schema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'Destination (e.g., "Helmsley, North Yorkshire", "North York Moors", "Pickering")',
        },
        checkin: {
          type: 'string',
          description: 'Check-in date YYYY-MM-DD',
        },
        checkout: {
          type: 'string',
          description: 'Check-out date YYYY-MM-DD',
        },
        guests: {
          type: 'number',
          description: 'Number of guests. Default 2.',
        },
        budget: {
          type: 'string',
          description: 'Budget preference: "budget", "mid", "luxury"',
        },
        area: {
          type: 'string',
          description: 'Special area flag. Use "north_york_moors" for NYM-specific results with local village suggestions and rural stays.',
        },
      },
      required: ['location', 'checkin', 'checkout'],
    },
  },
  // === WEB SEARCH ===
  {
    name: 'web_search',
    description: 'Search the web for current information. Use when you need facts, prices, contact details, news, or anything outside your training data. Returns titles, URLs, and snippets.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query.',
        },
        count: {
          type: 'number',
          description: 'Number of results (1-10). Default 5.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch and read the content of a URL. Use after web_search to read full page content, or when someone shares a link. Extracts main article content, preserves headings/lists/links as readable text. Max 8000 chars.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to fetch.',
        },
      },
      required: ['url'],
    },
  },

  // === TODOS & REMINDERS ===
  {
    name: 'todo_add',
    description: 'Add a new todo item. Can optionally set a due date and a reminder time (sends WhatsApp notification).',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The todo item text.' },
        due_date: { type: 'string', description: 'Optional due date YYYY-MM-DD.' },
        reminder: { type: 'string', description: 'Optional ISO datetime for WhatsApp reminder (e.g., "2026-03-15T09:00:00"). Will send a WhatsApp message at this time.' },
        priority: { type: 'string', description: 'Priority: "low", "normal", or "high". Default "normal".' },
      },
      required: ['text'],
    },
  },
  {
    name: 'todo_list',
    description: 'List todo items. By default shows only active (not done) items.',
    input_schema: {
      type: 'object',
      properties: {
        show_done: { type: 'boolean', description: 'Include completed items. Default false.' },
        priority: { type: 'string', description: 'Filter by priority: "low", "normal", "high".' },
      },
      required: [],
    },
  },
  {
    name: 'todo_complete',
    description: 'Mark a todo item as completed.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The todo item ID.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'todo_remove',
    description: 'Delete a todo item entirely.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The todo item ID.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'todo_update',
    description: 'Update an existing todo item (text, due date, reminder, or priority).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The todo item ID.' },
        text: { type: 'string', description: 'New text for the item.' },
        due_date: { type: 'string', description: 'New due date YYYY-MM-DD (or empty string to clear).' },
        reminder: { type: 'string', description: 'New reminder datetime ISO (or empty string to clear).' },
        priority: { type: 'string', description: 'New priority: "low", "normal", "high".' },
      },
      required: ['id'],
    },
  },

  // === SOUL SYSTEM (Self-Recode) ===
  {
    name: 'soul_read',
    description: 'Read your soul — what you have learned from interactions. Sections: people (facts about individuals), patterns (observed habits), lessons (incidents that changed behaviour), boundaries (social rules from feedback). Always safe to call.',
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'Optional: specific section (people, patterns, lessons, boundaries). Omit to read all.',
        },
      },
      required: [],
    },
  },
  {
    name: 'soul_learn',
    description: 'Add a learned entry to your soul. Use when you notice something about a person, a pattern in how James works, or a lesson from an interaction. This writes directly — no confirmation needed.',
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'Section: people, patterns, lessons, or boundaries.',
        },
        text: {
          type: 'string',
          description: 'What you learned (max 200 chars). Be specific and concise.',
        },
      },
      required: ['section', 'text'],
    },
  },
  {
    name: 'soul_forget',
    description: 'Remove a learned entry from your soul by section and index number. Owner-only.',
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'Section: people, patterns, lessons, or boundaries.',
        },
        index: {
          type: 'number',
          description: 'Entry number to remove (1-based, as shown by soul_read).',
        },
      },
      required: ['section', 'index'],
    },
  },
  {
    name: 'soul_propose',
    description: 'Propose a soul update for James to review. Stores a pending change that must be confirmed via soul_confirm. Use when you observe something worth learning but want owner approval first. In groups, proposals are always sent to James via DM.',
    input_schema: {
      type: 'object',
      properties: {
        section: { type: 'string' },
        content: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['section', 'content', 'reason'],
    },
  },
  {
    name: 'soul_confirm',
    description: 'Confirm and apply the pending soul proposal. Only works from owner DM. Call this after James has reviewed and approved a soul_propose.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // === MEMORY ===
  {
    name: 'memory_search',
    description: 'Search your long-term memory for relevant facts. Use when James asks about something you might have stored previously, or when you need context for a travel, legal, accommodation, or personal task.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query.',
        },
        category: {
          type: 'string',
          description: 'Optional category filter: preference, person, legal, travel, accommodation, henry, ai_consultancy, schedule, general.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_update',
    description: 'Correct an incorrect memory. Use when James says something like "that\'s wrong" about a stored fact. Search first to find the memory ID, then update it.',
    input_schema: {
      type: 'object',
      properties: {
        memory_id: {
          type: 'string',
          description: 'The memory ID to update.',
        },
        fact: {
          type: 'string',
          description: 'Corrected fact text.',
        },
        category: {
          type: 'string',
          description: 'Updated category if needed.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Updated tags if needed.',
        },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete a memory that is wrong or no longer relevant.',
    input_schema: {
      type: 'object',
      properties: {
        memory_id: {
          type: 'string',
          description: 'The memory ID to delete.',
        },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'system_status',
    description: 'Get the current status of the Clint system — uptime, memory, WhatsApp connection, EVO X2 health.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  // === PROJECTS ===
  {
    name: 'project_list',
    description: 'List all defined projects with their names, status, and one-liners.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'project_read',
    description: 'Read a project\'s full details or a specific section. Use to recall project architecture, pitch points, next steps, etc. Available projects include atlas, clint-agi, sovren, and spire (the complete reference for the Spire venue: floors, voice, agents, controls).',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Project ID (e.g., "atlas").',
        },
        section: {
          type: 'string',
          description: 'Optional: specific section to read (summary, architecture, keyDifferentiators, potentialPartners, nextSteps, foundingInsight, tags). Omit to read everything.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'project_pitch',
    description: 'Generate a pitch for a project tailored to a specific audience. Returns structured context for you to deliver a compelling pitch.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Project ID (e.g., "atlas").',
        },
        audience: {
          type: 'string',
          description: 'Who the pitch is for — e.g., "Shlomo Klapper (Learned Hand founder)", "VC investor", "BigLaw managing partner", "legal tech conference".',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'project_update',
    description: 'Update a project field. Can update status, summary, oneLiner, foundingInsight directly, or append items to nextSteps, tags, or keyDifferentiators arrays.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Project ID.',
        },
        field: {
          type: 'string',
          description: 'Field to update: status, summary, oneLiner, foundingInsight, nextSteps, tags, keyDifferentiators.',
        },
        value: {
          type: 'string',
          description: 'The new value (for string fields) or item to append (for array fields).',
        },
      },
      required: ['id', 'field', 'value'],
    },
  },
  {
    name: 'project_list_files',
    description: 'List files in a project directory so project docs can be inspected on demand.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Project ID, e.g. "sovren".',
        },
        subpath: {
          type: 'string',
          description: 'Relative path inside the project root. Defaults to ".".',
        },
        limit: {
          type: 'number',
          description: 'Maximum entries to list. Defaults to 60.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'project_file_read',
    description: 'Read a text file from a project root (for plans, architecture docs, specs, and notes).',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Project ID, e.g. "sovren".',
        },
        path: {
          type: 'string',
          description: 'Relative file path inside the project root.',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters to return. Defaults to 9000.',
        },
      },
      required: ['id', 'path'],
    },
  },
  {
    name: 'sovren_site_access',
    description: 'Access the live SOVREN website or authenticated SOVREN API using the approved demo login path. Use for checking the public homepage, API health, documents, valuations, admin AI status, or LLM analytics.',
    input_schema: {
      type: 'object',
      properties: {
        resource: {
          type: 'string',
          enum: ['homepage', 'health', 'login_test', 'documents', 'valuations', 'ai_status', 'llm_analytics'],
          description: 'Which SOVREN site or API resource to access.',
        },
        hours: {
          type: 'number',
          description: 'Hours window for llm_analytics. Default 24.',
        },
        limit: {
          type: 'number',
          description: 'Result limit for llm_analytics. Default 20.',
        },
      },
      required: ['resource'],
    },
  },

  // === OVERNIGHT STATUS ===
  {
    name: 'overnight_status',
    description: "Get a concise plain-text summary of the current overnight pipeline for a given date: event-log activity, shadow candidate counts, morning report availability, and any IMPROVE/proposal outcomes. Use when asked \"what happened overnight\", \"what ran last night\", \"did anything fail\", or \"what's awaiting my approval\". Fast — reads persisted artifacts and does not regenerate the report.",
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Optional YYYY-MM-DD date. Defaults to most recent overnight session.',
        },
      },
      required: [],
    },
  },

  // === OVERNIGHT REPORT ===
  {
    name: 'overnight_report',
    description: 'Regenerate and send the structured morning report for a given date from the Phase 5 event log pipeline. Use ONLY when James asks to regenerate, resend, or review the full morning report. This sends via WhatsApp using the current report renderer; it does not email or recreate the retired diary/retrospective format. For "what happened overnight" use overnight_status instead.',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Optional date to generate report for (YYYY-MM-DD). Defaults to yesterday.',
        },
      },
      required: [],
    },
  },

  // === EVOLUTION ===
  {
    name: 'evolution_task',
    description: 'Legacy self-coding queue placeholder retained for backward compatibility. The old direct evolution task queue is retired in Phase 5; weekly IMPROVE and proposal cards are the active self-improvement path. Do not use this for normal overnight reporting or active code changes unless James is explicitly asking about the retired queue behavior.',
    input_schema: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description: 'What code change to make. Be specific about the file, function, or behaviour to change.',
        },
        priority: {
          type: 'string',
          enum: ['normal', 'high'],
          description: 'Priority level. High = processed next, normal = queued.',
        },
      },
      required: ['instruction'],
    },
  },

  // === FILE SENDING ===
  {
    name: 'send_file',
    description: 'Send a file from the data/ directory as a WhatsApp document attachment. Use when asked to send, share, or forward a document, PDF, or file to the chat.',
    input_schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Filename within data/ directory (e.g. "refactoring-vibe-coded-projects.pdf")',
        },
        caption: {
          type: 'string',
          description: 'Optional caption to send with the document.',
        },
      },
      required: ['filename'],
    },
  },

  // === LIVE BRIEFING ===
  {
    name: 'live_briefing',
    description: 'Research a topic using live web sources and produce a grounded briefing with citations. Use when someone asks for a briefing, research summary, "what do we know about X", or "brief us on X". Returns synthesised prose with source URLs, not raw search results.',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The topic to research.',
        },
        depth: {
          type: 'string',
          enum: ['quick', 'deep'],
          description: 'Quick (~5s) or deep (~15s) research. Default quick.',
        },
      },
      required: ['topic'],
    },
  },

  // === GROUP DECISIONS ===
  {
    name: 'group_decisions',
    description: 'Search group decisions, action items, and commitments extracted from conversations. Use when asked "what did we decide", "what is outstanding", "who committed to X", or "what are the action items".',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Optional — omit to list recent decisions.',
        },
        days_back: {
          type: 'number',
          description: 'How many days back to search. Default 7.',
        },
        type: {
          type: 'string',
          enum: ['decision', 'action_item', 'commitment', 'all'],
          description: 'Filter by type. Default all.',
        },
      },
      required: [],
    },
  },

  // === GROUP SECURITY MODES ===
  {
    name: 'group_mode',
    description: 'Set the security mode for a group. Three modes: "open" (no restrictions), "project" (block personal life/admin, side projects allowed), "colleague" (block personal life/admin AND all side projects). Owner only. Use when James says "colleague mode", "project mode", or "open mode" in a group.',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['open', 'project', 'colleague'],
          description: 'Security mode.',
        },
        label: {
          type: 'string',
          description: 'Optional human-readable label for this group.',
        },
      },
      required: ['mode'],
    },
  },
  {
    name: 'group_block',
    description: 'Add blocked topics to a group. Use from DM to block specific topics without saying them in the group. Identify the group by label (e.g. "block Shlomo in Tom\'s group"). Owner only.',
    input_schema: {
      type: 'object',
      properties: {
        group_label: {
          type: 'string',
          description: 'Group label or partial name to identify which group (e.g. "Tom", "AGI").',
        },
        topics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Topics to block in that group.',
        },
      },
      required: ['group_label', 'topics'],
    },
  },
  {
    name: 'group_status',
    description: 'Show current security mode and restrictions for groups. In DM shows all groups. In a group shows just that group.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'group_project',
    description: 'Configure project access for a group. Supports allow-list project IDs and scope mode. Owner only. If the group is currently colleague mode, this tool upgrades it to project mode automatically.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project ID to allow (for example: sovren).',
        },
        scope_mode: {
          type: 'string',
          enum: ['allow_list', 'single_project_only'],
          description: 'allow_list = project allowed but general discussion still possible. single_project_only = soft-redirect off-topic chat back to the project.',
        },
        offtopic_policy: {
          type: 'string',
          enum: ['allow', 'soft_redirect'],
          description: 'How to handle non-project messages. single_project_only normally uses soft_redirect.',
        },
        label: {
          type: 'string',
          description: 'Optional group label to save while configuring access.',
        },
      },
      required: ['project_id'],
    },
  },

  // === MOORSTEAD ADMIN (owner only) ===
  {
    name: 'moorstead_status',
    description: "Find who is currently online in Moorstead — James's OWN multiplayer voxel game on his server (NOT an external service like Minecraft Realms) — returning each player's name, which world they are in (\"moor\" is the main adult world, \"bairns\" is the children's world) and their coordinates. Use this for ANY question about who is playing, whether a named player is online, or where someone is — e.g. \"who's on\", \"is Henry playing\", \"find Henry in the bairns world\", \"where is X\".",
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'moorstead_broadcast',
    description: 'Send a system message to all Moorstead players, or just players in one room.',
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Message to broadcast to players.',
        },
        room: {
          type: 'string',
          description: 'Optional room name (e.g. "moor"). Omit to broadcast to all rooms.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'moorstead_kick',
    description: 'Disconnect a Moorstead player by their pid (player ID).',
    input_schema: {
      type: 'object',
      properties: {
        pid: {
          type: 'string',
          description: 'Player ID to disconnect.',
        },
      },
      required: ['pid'],
    },
  },
  {
    name: 'moorstead_bairns_status',
    description: "Show the bairns world controls: daily play limit, closed window, whether it's open now, and how long each child played today.",
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'moorstead_bairns_set',
    description: 'Update bairns world controls. All params optional — only include what you want to change.',
    input_schema: {
      type: 'object',
      properties: {
        limitMinutes: {
          type: 'number',
          description: 'Daily play limit in minutes. 0 = no limit.',
        },
        warnSeconds: {
          type: 'number',
          description: 'Seconds before limit at which the player is warned.',
        },
        locked: {
          type: 'boolean',
          description: 'Lock the bairns world completely (true) or unlock it (false).',
        },
        closeFrom: {
          type: 'string',
          description: 'Start of the closed window, HH:MM (e.g. "20:00"). Must be paired with closeTo.',
        },
        closeTo: {
          type: 'string',
          description: 'End of the closed window, HH:MM (e.g. "07:00"). Must be paired with closeFrom.',
        },
        clearClosed: {
          type: 'boolean',
          description: 'Pass true to remove the closed window entirely.',
        },
      },
      required: [],
    },
  },

  // === MOORSTEAD DESTRUCTIVE OPS (owner DM only — confirm-gated) ===
  {
    name: 'moorstead_ops',
    description: 'Stage a destructive Moorstead operation (restart_service or reset_room). Returns a warning + confirm_id. Does NOT execute anything — the owner must call moorstead_ops_confirm with the confirm_id to proceed. Owner-only.',
    input_schema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['restart_service', 'reset_room'],
          description: 'Which destructive op to stage.',
        },
        service: {
          type: 'string',
          description: 'For restart_service: the short service alias. Allowed: relay, brain, dash, body, clawdbot.',
        },
        room: {
          type: 'string',
          description: 'For reset_room: the room name (lowercase letters only, 2–16 chars, e.g. "moor").',
        },
      },
      required: ['op'],
    },
  },
  {
    name: 'moorstead_ops_confirm',
    description: 'Confirm and execute a previously staged Moorstead destructive op. Requires the confirm_id returned by moorstead_ops. Single-use — consuming the id prevents replay. Owner-only.',
    input_schema: {
      type: 'object',
      properties: {
        confirm_id: {
          type: 'string',
          description: 'The 8-character hex confirm_id returned by moorstead_ops.',
        },
      },
      required: ['confirm_id'],
    },
  },

  // === MOORSTEAD AUTO-CODER (owner DM only — confirm-gated) ===
  {
    name: 'moorstead_code',
    description: [
      'Make a small additive code change to the Moorstead game — runs in ONE step.',
      'Owner-only. Generates the change via the auto-coder, runs the safety gate + build/tests, and reports back. Proposal-only unless MOORSTEAD_CODE_APPLY is true. There is NO separate confirm step — just call this with the request and wait (it can take a couple of minutes).',
      '',
      'Accepts a plain-English description of the change (e.g. "add a hedgehog that snuffles around hedgerows at dusk").',
      'The EVO-side runner generates the code, gates it through the safety classifier, runs tests, and (if MOORSTEAD_CODE_APPLY is true) deploys.',
      '',
      'HARD-BLOCKED paths (never deployable via this tool):',
      '  • worldgen.js, geography.js, noise.js, sky.js, landmarks.js, rails.js (terrain/worldgen)',
      '  • defs.js, multiplayer.js, player.js (core protocol/save format)',
      '  • Any path matching auth|account|login|warden|admin|token|secret|password|cred',
      '  • package.json, package-lock.json, vite.config.*, vercel.json, .vercelignore',
      '  • Anything under deploy/, .github/, scripts/, worldsvc/, server/',
      '  • Root dotfiles, *.service files, *.py files',
      '',
      'Safe envelope: ≤4 files, ≤150 lines. Green (auto-eligible): ≤2 files, ≤60 lines, content-only paths.',
      'Proposal-only by default — set MOORSTEAD_CODE_APPLY=true to allow live deploy.',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'Plain-English description of the additive code change to make. Max 500 chars. Examples: "add a hedgehog NPC that snuffles around hedgerows at dusk", "add a seasonal berry bush that players can harvest in autumn".',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'moorstead_code_confirm',
    description: 'Deprecated — moorstead_code now runs the auto-coder directly in one step. You do not need to call this; just use moorstead_code with the request. Owner-only.',
    input_schema: {
      type: 'object',
      properties: {
        confirm_id: {
          type: 'string',
          description: 'The 8-character hex confirm_id returned by moorstead_code.',
        },
      },
      required: ['confirm_id'],
    },
  },

  // === LQ COUNCIL (dev group / owner DM only) ===
  {
    name: 'lqc_status',
    description: 'Report LQ Bot Council harness health: release SHA, in-flight debates, recent completions, failure rate over the last hour.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'lqc_list_debates',
    description: 'List recent debates in the LQ Bot Council, optionally filtered by status (created/round_0/round_1/round_2/round_3/round_4/analysing/synthesising/complete/failed/cancelled).',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max debates to list (1-50). Default 10.' },
        status: { type: 'string', description: 'Optional status filter.' },
      },
      required: [],
    },
  },
  {
    name: 'lqc_debate_detail',
    description: 'Return structural metadata for one LQ Council debate: topic, bots + roles, status, rankings if complete. For SUBSTANCE of a debate (consensus points, disagreements, minority positions, what the bots actually concluded) use `lqc_debate_summary` instead — this tool is metadata only.',
    input_schema: {
      type: 'object',
      properties: {
        debate_id: { type: 'string', description: 'The debate UUID.' },
      },
      required: ['debate_id'],
    },
  },
  {
    name: 'lqc_list_bots',
    description: 'List registered LQ Council bots with status (active/pending/smoke_test_failed/inactive/rejected) and endpoint URL.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional status filter.' },
      },
      required: [],
    },
  },
  {
    name: 'lqc_bot_schema',
    description: 'Return the JSON Schema for the wire protocol a bot must implement (DebateRoundRequest + DebateRoundResponse).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'lqc_validate_bot',
    description: 'QUICK smoke test — round 0 only. Verifies reachability, TLS, bearer-auth handshake, and that the bot returns JSON with a `response` string on a dummy round-0 prompt. Fast but shallow: does NOT exercise rounds 1-4 or the round-specific fields (challenge, position_change). Use as the FIRST check; once green, move to `lqc_full_smoke_test` to verify all 5 rounds.',
    input_schema: {
      type: 'object',
      properties: {
        endpoint_url: { type: 'string', description: 'Full HTTPS URL of the bot\'s /debate endpoint.' },
        token: { type: 'string', description: 'Bearer token the bot expects.' },
      },
      required: ['endpoint_url', 'token'],
    },
  },
  {
    name: 'lqc_bot_diagnose',
    description: 'Diagnose ONE specific LQ Council bot by bot_id: aggregate its recent round outcomes, surface dominant error_kinds (timeout, http_5xx, schema_missing_field, etc.), show abstention / invalid-response patterns, and suggest fixes. Use when an author knows their bot_id and asks "why is my bot failing", "why does my bot abstain", "what\'s wrong with bot X". If the author doesn\'t know the bot_id, call `lqc_failing_bots` first to surface candidates, or `lqc_list_bots` to find it by name.',
    input_schema: {
      type: 'object',
      properties: {
        bot_id: { type: 'string', description: 'The bot UUID (use lqc_list_bots to find it).' },
        limit: { type: 'number', description: 'How many recent rounds to aggregate. 5-100. Default 20.' },
      },
      required: ['bot_id'],
    },
  },
  {
    name: 'lqc_bot_author_guide',
    description: 'Return a structured onboarding guide for LQ Council bot authors. Topics: overview (default), schema, rounds, failure_modes, testing, or "all".',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Which section: overview, schema, rounds, failure_modes, testing, all.' },
      },
      required: [],
    },
  },
  {
    name: 'lqc_onboarding_checklist',
    description: 'Return the bot-admission checklist with state inferred from the harness (if bot_id is known). Helps an author answer "where am I in the process?"',
    input_schema: {
      type: 'object',
      properties: {
        bot_id: { type: 'string', description: 'Optional bot UUID to check status against.' },
        endpoint_url: { type: 'string', description: 'Optional declared endpoint URL (marks step 1 complete).' },
      },
      required: [],
    },
  },
  {
    name: 'lqc_self_describe',
    description: 'List Clint\'s LQ Council tools and briefly describe what each does. Use when James asks what Clint can do with the council.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'lqc_dry_run_debate',
    description: 'POST a real round-0 debate prompt to a candidate bot\'s /debate endpoint and return the structured result (elapsed, status, parsed response, schema errors). Use AFTER lqc_validate_bot passes, when the author wants to see what their bot actually produces on a non-trivial prompt before submitting. Catches latency issues, prompt-interpretation bugs, and field-naming errors the generic smoke test does not.',
    input_schema: {
      type: 'object',
      properties: {
        endpoint_url: { type: 'string', description: 'Full /debate URL (https:// required in production; http://localhost permitted in dev).' },
        token: { type: 'string', description: 'Bearer token the bot will authenticate against.' },
        topic: { type: 'string', description: 'Debate proposition. Pick something specific and contestable (not "AI is good").' },
        role: { type: 'string', description: 'Optional role to test under. Defaults to "proponent". Valid: proponent, skeptic, devils_advocate, empiricist, steelman.' },
      },
      required: ['endpoint_url', 'token', 'topic'],
    },
  },
  {
    name: 'lqc_knowledge',
    description: 'Return curated LQcouncil reference knowledge distilled from the bot-council repo (CLAUDE.md, reference implementations, orchestrator source, live /bots/schema). This is authoritative reference material — NOT live state (use the other lqc_* tools for that). Prefer this over web_search or live_briefing for any question about how LQcouncil works, how bots are onboarded, the debate protocol, the wire schema, rounds, roles, error kinds, or testing. Pass either `topic_id` (for a specific chunk) or `query` (for keyword-matched top-N chunks within a token budget). With neither, returns the topic index.',
    input_schema: {
      type: 'object',
      properties: {
        topic_id: {
          type: 'string',
          description: 'Exact topic id. One of: overview, onboarding, request-schema, response-schema, rounds, roles, confidence-and-scoring, endpoint-contract, test-before-submit, error-taxonomy, llm-wrapping, abstention, operational-facts.',
        },
        query: {
          type: 'string',
          description: 'Natural-language phrase; returns top keyword-matched topics within a 1500-token budget. Use when the topic id is unclear.',
        },
      },
      required: [],
    },
  },
  {
    name: 'lqc_why_failed',
    description: 'Explain why a specific LQ Council debate failed. Combines the debate transcript (which bots abstained in which rounds, with reasons) with Sentry issues tagged with the debate_id when Sentry is configured.',
    input_schema: {
      type: 'object',
      properties: {
        debate_id: { type: 'string', description: 'The debate UUID.' },
      },
      required: ['debate_id'],
    },
  },
  {
    name: 'lqc_recent_errors',
    description: 'Query Sentry for recent issues in the LQ Council backend. Requires LQC_SENTRY_* env vars; gracefully degrades otherwise.',
    input_schema: {
      type: 'object',
      properties: {
        since_minutes: { type: 'number', description: 'Lookback window in minutes (5-1440). Default 60.' },
        tag: { type: 'string', description: 'Optional Sentry search query (e.g. "bot_id:abc" or "release:<sha>").' },
      },
      required: [],
    },
  },
  {
    name: 'lqc_start_debate',
    description: 'Propose a new LQ Council debate. Returns a confirm_id and a summary (topic, auto-picked active bots, estimated cost). DOES NOT fire the debate — caller must pass the confirm_id back through lqc_confirm_debate within 10 minutes to actually start it. Use when a user in the LQcouncil-bound chat says something like "start a debate on X" or "let\'s debate X".',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The debate proposition, phrased as a substantive sentence the bots can argue for or against. Maximum 300 characters.',
        },
        bot_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional explicit list of bot ids to include. If omitted, all active bots are auto-selected.',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'lqc_confirm_debate',
    description: 'Confirm and fire a previously-proposed debate. Takes the confirm_id returned by lqc_start_debate. Single-use — a successful confirm consumes the proposal so it cannot be replayed. Returns the server-assigned debate_id on success.',
    input_schema: {
      type: 'object',
      properties: {
        confirm_id: {
          type: 'string',
          description: 'The 8-character hex id returned by lqc_start_debate.',
        },
      },
      required: ['confirm_id'],
    },
  },
  {
    name: 'lqc_live_llm',
    description: 'Report which LLM is currently serving the LQ Council analyser + final synthesis (MiniMax vs local llama-server) with timeouts and concurrency. Use when someone asks "what model is the council running on" or "is it still on MiniMax".',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'lqc_archive_debate',
    description: 'Soft-archive or un-archive a debate in LQ Council. Archived debates are hidden from the default list but preserved in the database; pass archived:false to reverse. Reversible — no confirmation needed.',
    input_schema: {
      type: 'object',
      properties: {
        debate_id: { type: 'string', description: 'The debate UUID.' },
        archived: { type: 'boolean', description: 'true to archive (default), false to unarchive.' },
      },
      required: ['debate_id'],
    },
  },
  {
    name: 'lqc_delete_debate',
    description: 'Permanently delete a debate and all child rows (responses, analyses, synthesis, debate_bots). NOT REVERSIBLE. Two-step: first call with {debate_id} stages the deletion and returns a confirmation prompt; second call with {debate_id, confirm:true} within 5 minutes actually fires the delete. Use `lqc_archive_debate` instead if the debate just needs to be hidden.',
    input_schema: {
      type: 'object',
      properties: {
        debate_id: { type: 'string', description: 'The debate UUID.' },
        confirm: { type: 'boolean', description: 'Pass true ONLY on the second call, after a prior stage call has returned the confirmation prompt for this same debate_id.' },
      },
      required: ['debate_id'],
    },
  },
  {
    name: 'lqc_debate_summary',
    description: 'Summarise one specific debate in one call: topic, status, bots, plus — if complete — the synthesis headlines (consensus points, live disagreements with both sides, minority positions, flagged capitulations, peer rankings). If still in flight, returns a per-round progress walkthrough. Use when someone asks "tell me about debate X", "what did they decide in X", "what\'s happening in that debate", "summarise debate X", etc.',
    input_schema: {
      type: 'object',
      properties: {
        debate_id: { type: 'string', description: 'The debate UUID. Use lqc_list_debates first if you only have a topic keyword.' },
      },
      required: ['debate_id'],
    },
  },
  {
    name: 'lqc_failing_bots',
    description: 'Scan all active LQ Council bots and list any whose recent-rounds failure rate is above a threshold (default 30%). Each entry shows the bot name, id, failure count, rate, dominant error_kind, and submitter. Use when someone asks "are any bots broken", "which bots are failing", "any bots in trouble", without naming a specific bot. Follow up with lqc_bot_diagnose using the returned bot_id for per-bot specifics.',
    input_schema: {
      type: 'object',
      properties: {
        threshold: { type: 'number', description: 'Failure-rate cutoff between 0 and 1. Default 0.3 (30%). Lower = more bots surface.' },
        limit: { type: 'number', description: 'How many recent rounds per bot to inspect (5-50). Default 20.' },
      },
      required: [],
    },
  },
  {
    name: 'lqc_full_smoke_test',
    description: 'Run a full 5-round smoke test against a candidate bot endpoint with fabricated peer context. Confirms the bot responds correctly on EVERY round, not just round 0. Each round is validated for: HTTP 2xx, valid JSON, required fields per round (challenge in round 2, position_change in round 4, confidence 0-100 integer in rounds 1-4). Returns per-round pass/fail with specific schema errors and targeted remediation hints. Use when a bot author wants to check their bot is truly ready for production — not just reachable. Slower and more expensive than lqc_validate_bot (5 LLM invocations on the candidate endpoint); run the quick validate first.',
    input_schema: {
      type: 'object',
      properties: {
        endpoint_url: { type: 'string', description: 'Full HTTPS URL of the candidate bot\'s /debate endpoint.' },
        token: { type: 'string', description: 'Bearer token the candidate bot expects. This is the bot\'s own token, NOT an LQC credential.' },
        topic: { type: 'string', description: 'A debate proposition string used for the synthetic test. Short and clear — one sentence works.' },
        role: { type: 'string', description: 'Which constitutional role to test under. Default proponent. Options: proponent, skeptic, devils_advocate, empiricist, steelman.' },
        per_round_timeout_ms: { type: 'number', description: 'Per-round timeout in milliseconds (10000-180000). Default 60000.' },
      },
      required: ['endpoint_url', 'token', 'topic'],
    },
  },
];

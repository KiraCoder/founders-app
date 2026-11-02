# Founders App — Brief for the Main Agent

**Owner:** Nuraaly Toktonazar uulu (co-founder, Asqa Zou holding, Osh, Kyrgyzstan)
**Co-founder / second user:** Talantbek Zhenishbek uulu ("Talant")
**Status:** idea stage. This brief is a starting point, not a fixed spec. You are expected to question it, improve it and suggest better options.

---

## 1. What we are building

An AI-powered **Founders App** (working name: Founder Cockpit) for the Asqa Zou group of companies. It is where the founders capture thoughts, plan, track, see the numbers, and get insights. Most importantly, it has **AI agents inside the app that push the founders to act** on each company's work.

The founders do not have people for every role (for example, there is no financial director). Instead, they want to "hire" AI agents for those roles. An agent is tuned once, then works on its own schedule: it asks for updates as days pass, chases if data is not uploaded, and delivers its analysis.

### Companies in the group
Each company is legally separate. Never mix their data.

| Company | What it is |
|---|---|
| **Kiwi Go** (ОсОО KiwiKG) | Courier delivery startup in Osh: intercity (Bishkek → Osh), in-city delivery, COD for shops |
| **Jobutify** (ОсОО Жобютифай) | The group's IT company. Builds the ERP, WMS and Kiwi Go apps. Run day-to-day by Edil |
| **Alura Brand** | The clothing brand. Gives materials and orders to the factory |
| **Alura Style** | The garment factory. Two factories tracked **separately**: ХБК and Ош Район |
| **Upsell Group** | Sales / e-commerce arm (Wildberries and other marketplaces) |
| **Marketing** | Planned marketing company serving all group companies |
| **Asqa Zou Holding** | The holding itself: intercompany matters |

The app must allow **adding more companies later**.

### Users
- **Now:** Nuraaly and Talant. Each has **their own todos and their own notifications**. A notification that is for Nuraaly must not go to Talant, and the other way round. Company pages, org charts and AI roles are probably shared between them; confirm this with Nuraaly.
- **Later:** some staff, with a workspace that feels like Linear but is built on the group's own structure (companies, divisions, departments, posts).

---

## 2. How we work on this build (important)

### Main agent + subagents
- **You are the main agent (orchestrator).** You own the plan, the order of work and the quality bar.
- Split work into parts and give them to **subagents** (for example database, backend, UI pages, Telegram bot, tests, review). Run independent parts in parallel.
- **The agent that writes something should not be the only one that checks it.** Use a separate reviewer or tester for important work.
- **You decide the chunks and their order.** Section 4 lists what the founders want; it is not a fixed sequence.

### The live control page
Before building, publish a **live control page** (a Claude artifact) and keep it updated during the whole build. Nuraaly will mainly work with you through it. It should show:

1. **Status:** current chunk, what each subagent is doing, what is done, what is blocked.
2. **Approval queue:** cards for decisions that need Nuraaly. Each card has a short explanation, options, your recommendation, links (for example a Claude Design screen or a preview deployment), and a clear Approve / Change / Comment action.
3. **Brainstorm board:** an open space where you and Nuraaly shape ideas together. You can post proposals, alternatives and questions. Nuraaly can change things, comment, or reject. If you think one idea is weak and another is better, say so and explain why.
4. **Decision log:** every decision made, with date and reason, so nothing is lost or silently changed.

If publishing a live artifact is not available in your environment, tell Nuraaly and propose the closest alternative (for example a `/control` page inside the app deployed to a preview URL, or a `CONTROL.md` in the repo).

### Freedom
You have **freedom to think, challenge and improve.** This brief may be wrong or incomplete. Suggest better structures, features, flows or tools when you see them. Brainstorm with Nuraaly on the control page before locking in big things.

### Always ask Nuraaly first before:
- **Choosing the AI provider for the in-app agents** (Claude, ChatGPT or other). Build an abstraction so the provider can be switched, but do not pick one without his confirmation.
- Anything that **costs money** (paid plans, paid APIs, domains).
- Anything **irreversible** (deleting data, destructive migrations on real data).
- Sending messages to **anyone other than the two founders**.
- **Secrets:** never put API keys or tokens in the code or the repo. Ask Nuraaly to add them as environment variables himself.

### Design before build, when useful
For important screens, design first in **Claude Design**, put the design link on the control page for approval, then hand it off to Claude Code to build. Use your judgment on which screens need this.

### Language
- Talk to Nuraaly in **simple, clear English**. Short messages, one decision at a time.
- At the end of a recommendation, add a short paragraph explaining **how you came to it**. Nuraaly asked for this.
- If something is unclear, **ask** instead of guessing.

---

## 3. Design direction

Follow the look of the founders' earlier **Founder Cockpit** (5 Oct 2026), which Nuraaly liked. You may refine it, but keep the palette and font.

**Layout:** WMS-style app shell. Grouped **left sidebar** on desktop, bottom tab bar on phone, sticky top bar with search, slide-out **agent panel on the right**. Laptop-first, but everything must work on a phone. Light mode is the default.

**Font:** `Golos Text` (Google Fonts, weights 400 / 500 / 600 / 700). Use tabular numbers for figures.

**Light theme tokens:**
```css
--bg: #F5F6F4;        --surface: #FFFFFF;     --sunk: #EEF0EC;
--line: #E1E4DF;      --ink: #16201A;         --muted: #58645D;
--accent: #1E6B49;    --accent-ink: #FFFFFF;  --accent-soft: #E1EFE7;
--warn: #875100;      --warn-soft: #FFF3D6;   --warn-line: #EED6A0;
--risk: #B3261E;      --risk-soft: #FCE8E6;   --risk-line: #F2C2BD;
--info: #1F4E8C;      --info-soft: #E4ECF7;
--shadow: 0 1px 2px rgba(16,24,20,.06), 0 6px 20px rgba(16,24,20,.06);
```

**Dark theme tokens (optional, for later):**
```css
--bg: #0F1411;        --surface: #161D19;     --sunk: #1D2621;
--line: #29332D;      --ink: #E5ECE7;         --muted: #9BA8A0;
--accent: #52B788;    --accent-ink: #06130C;  --accent-soft: #17321F;
--warn: #E8B252;      --warn-soft: #2D2412;   --warn-line: #57441F;
--risk: #F28B82;      --risk-soft: #3A1C19;   --risk-line: #6A2F2A;
--info: #8FB5EC;      --info-soft: #18243A;
```

**Style notes from the old cockpit:** 12px card radius, 8px buttons, thin 1px borders, small uppercase "eyebrow" labels, colored tags for status (ok / warn / risk / info), KPI cards that show **how fresh the data is** and turn warning-colored when data is stale.

**Interface language:** English. **Org structures are in Russian** (the team manages them more easily in Russian).

---

## 4. What the founders want (the product)

These are the wishes collected so far. The order is not fixed. Propose your own chunk plan.

### Must-haves
- **Company pages** for every company: overview, key numbers, projects, tasks, people, org structure, documents, and the AI roles working for that company.
- **Tasks and projects:** create, assign (to a founder or a person), deadlines, priorities, statuses. **Separate personal todo lists for Nuraaly and Talant.** Overdue tasks stay flagged until someone changes the deadline. Projects break down into tasks.
- **Reminders and pushing:** the system reminds each founder about their own tasks and chases what is late.
- **Telegram bot** as the first notification channel: each founder links their own Telegram, gets only their own messages (morning summary, reminders, overdue chases, agent requests), and can reply (for example mark done, upload a number, answer an agent's question). Nuraaly creates the bot himself via @BotFather.
- **Org structure** (Nuraaly liked this most in the old cockpit): editable per company, based on the **Vysotsky model: 7 divisions, 21 departments**, posts inside departments, one manager per post. Ideally a **drag-and-drop editor with AI help**. Labels in Russian. Kiwi Go's org scheme can be the first example to load.
- **People:** one shared people database across companies (one person can work for several companies, like the accountant). Company-based view with roles and salaries. It replaces their current Excel sheet. **Salaries are sensitive**: restrict access.

### AI roles (the core idea)
- A framework to **"hire" an AI agent for a role** in a company: what it is responsible for, which data it needs, how often it runs, what it reports, whom it asks.
- **Tune once, then it runs:** it asks for updates on schedule, **chases if data is not uploaded**, analyzes, and sends insights and alerts.
- **First role to build: AI Financial Analyst** (the group has no financial director). It asks for monthly financial data, chases if missing, analyzes per company, and flags problems.
- Other roles can follow the same framework later (for example HR, marketing, operations).
- Every page should have an agent the founders can talk to, which can improve that page over time.
- One **orchestrator agent** inside the app watches all projects and companies and decides what to push to whom and when. Do not let it spam: it should **park items until the right time** instead of asking the same question again and again. That was a problem in the old cockpit.

### Holding page
- Intercompany contracts, **monthly акты приёма-передачи** between group companies, debts between companies.
- Акты are the accountant's job (Elmurat). The founders do not upload them; they ask Elmurat. The app should **push the founders to ask about missing months**.
- Known intercompany flows: Alura Style sews for Alura Brand; Jobutify builds the ERP for Alura Style and the app/platform for Kiwi Go; Kiwi Go delivers for Alura Brand; the Marketing company will serve all group companies.

### Data from existing systems
The app should **pull numbers automatically** where possible. Until APIs are ready, allow manual entry and file upload.
- **Alura Style ERP** (built by Jobutify): output per day per factory, sewing orders, materials, defects/QC, piecework pay totals, headcount.
- **WMS** (wms.jobutify.com, built by Jobutify): stock, orders and operations per day, shipments, errors/returns.
- **Kiwi Go app** (built by Jobutify): orders per day and route, delivery statuses, COD collected and paid out, revenue, couriers.
- **Wildberries** seller API (token created in the WB seller portal).
- Nuraaly has asked Edil (Jobutify) for read-only API access. Design a clean **connector layer** so each source can be plugged in when its API is ready.

### Later
- **Employee workspace** like Linear, built on top of the group's own structure.
- **iOS app** with push notifications, built later by an iOS developer. Design the backend so a mobile app can use the same API, and build notifications as a **channel layer** (Telegram now, app push later) so switching is easy.

---

## 5. Suggested tech (you may propose better)

- **Next.js** for the web app and its backend.
- **Supabase** for the database (PostgreSQL), login, file storage and scheduled jobs. Use row-level security so each founder sees their own todos and only allowed people see salaries.
- **Vercel** for hosting, deployed from GitHub.
- **Telegram Bot API** for notifications.
- **AI provider: ask Nuraaly first.** Keep it behind an abstraction.

Why this default: Jobutify already builds the garment ERP with Next.js and Supabase, so Edil's team can maintain this app without learning a new stack. If you think something else is clearly better, propose it on the control page with reasons.

Free tiers are enough to start. Ask before anything paid.

---

## 6. Time and budget note

Nuraaly has **cloud session credits that expire on 5 November 2026 at 1:59 PM (GMT+6)**. Use them well: focus early on the foundation that does not depend on open questions (project setup, database, login for the two founders, app shell with sidebar, companies, tasks, Telegram basics). Brainstorming and design can run in parallel.

---

## 7. Your first steps

1. Read this brief fully. Check the repo state.
2. Publish the **live control page** and share the link with Nuraaly.
3. Post a **short first brainstorm round** on the control page: your understanding in a few lines, your biggest questions, and anything in this brief you would change.
4. Propose your **chunk plan and architecture** as an approval card.
5. After approval, start the first chunk with subagents. Keep the control page updated.

### Definition of done for each chunk
- Works end to end, with tests for the important logic.
- Deployed to a preview URL Nuraaly can open.
- Reviewed by an agent that did not write it.
- Short summary on the control page: what was built, what is next, and what needs Nuraaly.
- Nuraaly approves before the next chunk depends on it.

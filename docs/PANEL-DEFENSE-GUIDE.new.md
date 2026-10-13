# A.I.R. — Panel Defense Guide

**Audience:** Thesis / Capstone panel
**System:** A.I.R. — IoT Environmental Safety Monitoring Dashboard
**Stack:** ESP32 firmware · React + TypeScript · Supabase (PostgreSQL, RLS, Realtime, Edge Functions)

This document has four parts:

1. [The green and red lights — how a badge gets its colour](#1-the-green-and-red-lights)
2. [The report summary and calendar](#2-the-report-summary-and-calendar)
3. [A 3-minute walkthrough script](#3-a-3-minute-walkthrough-script)
4. [Panel questions with guided answers](#4-panel-questions-with-guided-answers)

---

## Before you demo

Run `supabase/migrations/20260915000000_reference_thresholds.sql` in the Supabase SQL editor **before** the defense. It has not been applied yet — the linked project's credentials return a 403 to the CLI. Until it runs, the saved LPG row still holds the old 1000 / 2000 / 5000 values and the cards will show the wrong LPG bands, while the code shows the right ones. That mismatch is visible on screen and it is the first thing a panel member would notice.

Once applied, verify in the SQL editor:

```sql
select * from public.platform_thresholds where id = 1;
-- co2 1000/2000/3500, lpg 1000/2100/4200,
-- temp 5/18/35, humidity 20/30/80
```

---

## 1. The green and red lights

### 1.1 The one-sentence answer

> "A light is not a hardware output. It is a **grade the dashboard computes** by comparing a raw sensor reading against the safety limits saved in the database. Green means the reading is inside every limit. Red means it is outside at least one. Amber and orange are the two steps in between."

This is the most important sentence in the defense, because it is the answer to *"why does the light disagree with the ESP32?"*

### 1.2 The four colours

Every badge, dot, gauge segment, row tint and number colour **on the live dashboard** comes from one map — `src/ui.tsx`, function `badgeStyles()`. There is no second colour table anywhere in the codebase.

| Colour | Grade | Badge text | Meaning |
|---|---|---|---|
| **Green** (teal `#0d9488`) | `ok` | `OK` | Inside every configured limit |
| **Amber** (`#d97706`) | `warning` | `Monitor` | Crossed the *warning* limit |
| **Orange** (`#ea6c2e`) | `high` | `High` | Crossed the *high* limit |
| **Red** (`#dc2626`) | `danger` | `DANGER` | Crossed the *danger* limit |
| Grey (`#64748b`) | — | `No sensor data recorded` | **Nothing was measured** |

> **Say this out loud:** "Grey is not a fifth grade. Grey means *we do not know*. The system refuses to show green for a sensor that has never reported, because a device that is silent and a device that is safe look identical if you colour them the same."

> **Scope note:** these four colours are used on the **live dashboard only**, where red is paired with an audible alarm and means "act now". The Reports calendar deliberately does **not** use them — see §2.4.

### 1.3 Where the colour comes from

```
ESP32 ──► readings table ──► dashboard computes grade ──► colour
         (raw numbers)      (raw numbers + saved        (one map,
                             thresholds)                one place)
```

The grade is calculated in `src/lib/thresholdConfig.ts` from **two inputs only**: the raw value and the saved thresholds. Never from a number the device supplied.

### 1.4 The grading rules

All boundaries are **inclusive** (`>=`), so a reading sitting exactly on a limit is graded by that limit, identically on the dashboard, in the SQL reports and in the PDF.

**CO₂ and LPG** — one-sided, ascending:

```
reading >= danger  ->  DANGER  (red)
reading >= high    ->  High    (orange)
reading >= warning ->  Monitor (amber)
otherwise          ->  OK      (green)
```

**Temperature** — two-sided (DHT22):

```
reading <= freeze  ->  DANGER  (red)      5 °C
reading <= cool    ->  Monitor (amber)   18 °C
reading >  heat    ->  DANGER  (red)     35 °C
otherwise          ->  OK      (green)   the comfortable band
```

**Humidity** — two-sided (DHT22):

```
reading <= dry     ->  DANGER  (red)     20 % RH
reading <= low     ->  Monitor (amber)  30 % RH
reading >  mold    ->  DANGER  (red)     80 % RH
otherwise          ->  OK      (green)
```

**The room's badge is the worst of the four.** A room with perfect CO₂ and a leaking LPG valve is red. Full stopping of one hazard is never masked by a good reading of another.

### 1.5 The limits, and where they come from

Saved in the database table `platform_thresholds`, edited on the **Platform Safety & System Configuration** page:

| Metric | Warning | High | Danger | Standard |
|---|---|---|---|---|
| CO₂ | 1000 ppm | 2000 ppm | 3500 ppm | ASHRAE 62.1 & OSHA |
| LPG | 1000 ppm | 2100 ppm | 4200 ppm | NFPA 54 / NFPA 715 & BS EN 50194-1 |
| Temperature | 5 °C | 18 °C | 35 °C | ASHRAE 55 |
| Humidity | 20 % RH | 30 % RH | 80 % RH | EPA & ASHRAE 62.1 |

**Three defences if challenged:**

1. **LPG is set as a fraction of the Lower Explosive Limit, not a health exposure limit.** 2100 ppm is 10 % LEL, 4200 ppm is 20 % LEL. The hazard is combustion, not toxicity, so the guide is NFPA 54 / NFPA 715 and BS EN 50194-1. The LEL is 21 000 ppm (2.1 % by volume).

2. **CO₂'s "High" tier (2000 ppm) is dashboard-only.** The ESP32 implements only warning (1000), alarm (3500) and critical (5000). The middle tier exists so the dashboard can grade a reading *between* two physical alarm points — 2500 ppm deserves to be orange, not green, even though no buzzer fires. **The hardware does not act on it; only the display does.**

3. **3500 ppm is deliberately below OSHA's 5000 ppm 8-hour limit.** The footnote on the card says so. We warn earlier than the regulation requires because the audience is students and staff, not industrial workers with respirators.

### 1.6 The three questions they *will* ask about the lights

**"Why not just use the severity the ESP32 sends?"**
> "Because the ESP32 compiles its thresholds into the firmware. They change only when we flash new firmware. The dashboard's limits are configurable in the browser. If we trusted the device's severity, an administrator could raise the LPG limit to 8000 ppm, save it, and the lights would stay green while the database said danger. Two sources of truth always disagree eventually. We have exactly one: the database. The device severity column is still stored and shown in report appendices, clearly labelled as *the device's own record*, not as the system verdict."

**"What if a threshold is changed at 3 a.m.?"**
> "The change is written to `platform_thresholds`, published to the `supabase_realtime` publication, and every open session receives the event and re-reads the row. Cards, badges, gauges, the alarm and the alert email all re-grade within a second. A refresh or a fresh login reads the same row, so the value survives both."

**"Can a normal user change the limits?"**
> "No, and it is enforced by the database, not by the interface. Row Level Security on `platform_thresholds` grants SELECT to every signed-in account but INSERT, UPDATE and DELETE only to an active, approved administrator. Hiding the buttons in the UI is cosmetic — RLS is the actual control. We also found and fixed a real hole here: the original policies were written `with check (true)`, which meant any signed-in account, including a pending unapproved one, could have rewritten the platform's safety limits through the REST API. We tested that path deliberately."

---

## 2. The report summary and calendar

### 2.1 One-sentence answer

> "The live dashboard answers *'what is happening right now?'* The report page answers *'what happened, and when?'* — and it is built so a reader can audit it rather than just trust it."

### 2.2 The Reports page, top to bottom

| # | Element | What it is |
|---|---|---|
| 1 | Year selector | Current year plus four back. No future years. |
| 2 | Device / Room filter | One device, or all rooms |
| 3 | Month calendar | One cell per day: no data, data, or data with a breach count |
| 4 | Selected-day panel | Min / average / max per metric, one chart, and the breach list |
| 5 | Monthly report grid | One PDF download button per month that has data |

### 2.3 The calendar — the four states

This is the part most likely to be misunderstood, so present it slowly.

| Day appearance | Condition | Meaning |
|---|---|---|
| **Grey number, no marker** | No readings that day | Nothing was recorded. **Not** "safe". |
| **Small grey dot** | ≥ 1 reading, **0** above limit | Data exists and stayed inside the limits |
| **Grey chip with a number** | N readings above limit | Data exists and N of those readings crossed a danger limit |
| Not clickable | In the future | Has not happened yet |

> **The key sentence:** "A blank day and a dot day are opposites, not relatives. A blank day tells you *nothing happened*. A dot day tells you *something happened and it stayed inside the limits*. The system will not let a gap look like a pass."

Hovering a day gives the full picture: the reading count, and for a breach day the count **and which sensors caused it** — *"1,440 readings, 12 above limit (CO2, LPG)"*. That names the investigation to open, not just the size of the problem.

A legend sits under the grid, so the three states are self-explanatory without a demonstration.

Every day and month boundary is **Asia/Manila**, on both the browser and the SQL side, because a reading at 23:30 belongs to that day locally even though it is already the next day in UTC.

### 2.4 Why the calendar carries no colour

**Worth defending rather than hiding.**

The calendar originally painted breach days red and clean days green. In practice that made an ordinary month of monitored operation look like an emergency, and it turned a **count of events** into a **health verdict on the room** — which the data does not support. A room is not "red"; a room had *N* readings above a limit on a given day.

So the day cell is uncoloured, and a breach is rendered as a **number**, with the causing sensors named on hover. Everything the colour was carrying is still there, as text and figures that survive printing, projection and colour-blindness.

**Colour in this system is reserved for the live dashboard**, where red means *evacuate now* and is paired with an audible alarm. That is the one place where a colour carries an immediate physical instruction. Historical reports are a tally, and a tally reads fine as a number.

> **If a panelist prefers the coloured version:** "We had it coloured and we moved away from it. The information is identical either way, because the count and the causing sensors were always available. What changed is that the calendar no longer implies a safety verdict it cannot substantiate."

### 2.5 What counts as a "danger reading" in a report

**This is a deliberate, defensible design decision — state it before they ask.**

The live dashboard grades four levels: OK, Monitor, High, DANGER.
Reports count **one**: *danger*.

> "A report is an accountability document. If we counted an amber 'Monitor' reading as a violation, the count would stop meaning anything — in a busy room, amber readings are normal operation, and the real breaches would be lost in the noise. So a breach count means exactly one thing: a reading crossed a danger limit. Amber and orange still appear in the dashboard and in the PDF's trend charts, where they guide an operator, but they are not counted as incidents. That separation is what makes the monthly number quotable."

### 2.6 The selected-day panel

- **Four metric tiles** — Min / **Avg** / Max for CO₂, LPG, Temperature, Humidity, with the unit.
- **"Measurements" counts real samples.** If a sensor returned nothing, it contributes nothing. A metric with no samples shows `-`, never `0`.
- **Chart** — 5-minute averages through the day, with the danger threshold drawn as a dashed line. **A gap in the line is a gap in the data, and it is drawn as a gap.** We do not connect the dots across a missing period, because that would invent readings that were never taken.
- **Breach table** — every individual reading that crossed a limit, paged 250 at a time, with the exact time and a **"Triggered by"** column naming which metric(s) caused it: CO₂, LPG, Temperature, Humidity.

> **Say this:** "One reading can breach two metrics. We count it once in the total and list both causes in the Triggered by column, so the total and the explanation never disagree."

### 2.7 The monthly PDF

Downloaded per month, for any month in the past with at least one reading. Months that have not happened, and months with no data, are **not shown** — an empty button is noise.

Contains: header with device and month · readings recorded · readings above limit · days with data · days with a breach · a per-metric statistics table · four trend charts with the threshold drawn · and an **Analysis** section written in prose.

The Analysis section is written to describe **only what is present in the data**. It does not infer causes, health effects or future conditions. If a day had readings but none reached a danger limit, it says so plainly — it does not report "conditions were fine", because absence of a breach is not proof of safety.

### 2.8 Data retention — answer this before they ask

> "Individual readings are not kept forever. After a month's report is generated and verified, the raw rows are deleted and only the daily aggregates survive. This is stated on the report itself: a panel member opening a report from a past month sees **AGGREGATED DATA — NOT RAW READINGS**, with the explanation. We would rather show a smaller amount of data honestly labelled than a larger one presented as if it were raw. Row-level detail for a past month is available through the companion CSV in the monthly archive."

---

## 3. A 3-minute walkthrough script

Say this in order. It follows the screen.

### 0:00 — The problem, in one breath

> "A.I.R. watches carbon dioxide, LPG, temperature and humidity in occupied rooms. Every ESP32 sends readings to the cloud. The dashboard decides, in real time, whether a room needs attention — and the Reports page lets an administrator prove, months later, exactly what was recorded and when."

### 0:30 — Live dashboard, point at the gauges

> "These are not hardware LEDs. The green, amber, orange and red bands are computed here, from the raw reading and the limits saved in the database. Look at the Reference Guides at the bottom — those same limits, with the standard each one comes from: ASHRAE 62.1 and OSHA for CO₂, NFPA 54, NFPA 715 and BS EN 50194-1 for LPG, ASHRAE 55 for temperature, EPA and ASHRAE 62.1 for humidity. The LPG limits are fractions of the Lower Explosive Limit, because the hazard there is combustion — 2100 ppm is 10 % LEL, 4200 ppm is 20 % LEL."

### 1:15 — Show a red badge

> "This room is red. The system did not take that from the device. It compared the reading against the saved LPG limit and graded it. And notice it is the *room* that is red, not one gauge — the worst of the four metrics wins, so a good CO₂ reading can never hide a gas leak."

### 1:45 — Settings page

> "An administrator can retune any of the twelve limits. The rule is ascending — warning below high below danger — and it is enforced twice: inline on the form, and as a CHECK constraint in the database. The database constraint is the real one; the form is a courtesy. Only an administrator can write, enforced by Row Level Security, and only an active, approved one."

### 2:15 — Reports page, the calendar

> "Now the historical side, and notice it is deliberately plainer than the dashboard. Each day is either blank — nothing was recorded — or carries a small dot meaning data was recorded and nothing crossed a limit. Where readings did cross a limit, the day shows the **number** of them. Hover and it tells you which sensors: 'twelve above limit, CO2 and LPG'. No colour here, because this page is a tally of events, not a verdict on the room — and a blank day is not a safe day, it is an absence of data, which is why we render it differently on purpose. Click a day and we show min, average and max per metric, the trend against the limit line, and every individual breach with its time and its cause. Every boundary is Asia/Manila."

### 2:45 — Close

> "One number is the whole design: the thresholds live in one table, and every light, badge, card, chart, report and alert email is derived from it. Change one cell and all of them change together. That is the single source of truth, and it is enforced by the database rather than by convention."

---

## 4. Panel questions with guided answers

### Group A — The design

**Q1. "What is your novel contribution? A dashboard with charts is common."**
> "Three things. First, the grading is computed from the saved configuration — the database — rather than trusted from the device, which means a configurable safety system cannot silently disagree with its own firmware. Second, the system distinguishes *no data* from *safe data* everywhere: sensors, cards, calendar, reports, PDFs. Most systems conflate them, and that is how a dead sensor gets reported as a healthy room. Third, the limits are administrator-tunable against named standards, with the ordering rule enforced by the database."

**Q2. "Why store thresholds in the database instead of hardcoding them?"**
> "Because hardcoding produced a real defect in our own system. The code default and the saved row drifted apart, so the LPG card was showing 2000 ppm while the firmware used a different value — and editing the code changed nothing, because the saved row wins. We found this by treating the database as the truth and asking what it actually held. Hardcoding is only safe when the values are truly constant. These are policy, not physics: a laboratory and a kitchen want different LPG limits."

**Q3. "Four colours — isn't that confusing? Why not just red and green?"**
> "Deliberate. Two colours force a false choice between 'fine' and 'wrong'. A reading of 1500 ppm CO₂ is not a problem and not normal — it is *worth watching*, and collapsing that into green hides the early warning that the whole system exists to provide. Four steps let an operator act in proportion: monitor, investigate, evacuate. It is also an accessibility point: the badge carries the word OK / Monitor / High / DANGER as well as the colour, so the meaning is never colour-only."

**Q4. "Reports only count 'danger'. Isn't that hiding the amber readings?"**
> "It is separating two different jobs. The dashboard grades all four levels because an operator needs to know what to watch. A report counts breaches because an incident count that includes routine amber readings stops being an incident count. The amber readings are not discarded — they are visible in the trend charts in the PDF, and the dashboard shows them in real time. If a panel member wants warning-tier counts in the reports, that is a reasonable extension and a small change to one SQL helper."

### Group B — Correctness and honesty

**Q5. "How do you know a room is actually safe?"**
> "We do not claim it is. A room with no breaches means *every reading recorded stayed inside the configured limits*. It does not claim the air was healthy, and it does not claim anything about periods with no readings — those are rendered as blank or as gaps in the chart, never as a pass. The reports and the PDF both state that they describe only what is present in the data and do not treat missing readings as safe."

**Q6. "What happens if the sensor dies?"**
> "Three layers. A device with no reading in the last 30 seconds is marked OFFLINE rather than showing a normal badge. A device that has *never* reported shows grey — 'No sensor data recorded' — and its value is null, not zero. And the Reports page lists registered devices that never reported separately from ones with clean data, so a silent device is visibly distinct. Treating a missing reading as zero is the specific failure this design exists to prevent."

**Q7. "Your rules use `>=`. What about a reading exactly on the limit?"**
> "It is graded by the limit it touches, and identically in all three places it is evaluated — the dashboard, the SQL report helpers and the PDF generator. That was not automatic. We audited each and made them use the same inclusive comparison, because a boundary disagreement means the badge and the report can contradict each other on the same number."

**Q8. "The LPG sensor is an MQ-6. Isn't it a semiconductor sensor, not a certified detector?"**
> "Correct, and we state it. The MQ-6 is a cheap semiconductor sensor with a resistive output that drifts and needs calibration; it is not a laboratory instrument and the ppm figures are indicative rather than certified. That is a stated limitation of the hardware, not of the software. What the software guarantees is that whatever the sensor reports is graded consistently against the configured limits and recorded with its timestamp. For a certified installation this table would be driven by a certified detector instead — and because every threshold is configurable, no code change would be needed."

### Group C — Security

**Q9. "How do you prevent an ordinary user from changing safety limits?"**
> "Row Level Security in PostgreSQL. Every authenticated account gets SELECT. INSERT, UPDATE and DELETE require a predicate that checks the caller is an active, approved administrator. The client-side hiding of the inputs is cosmetic; the policy is the control. We also enforce ordering with CHECK constraints, so even a direct API call cannot store a configuration where the high tier is below the warning tier and the middle band is unreachable."

**Q10. "Did you find security problems in your own system?"**
> "Yes, and we fixed them. The original policies on the thresholds table were written as `with check (true)`, which grants write access to *any* signed-in account — including one still pending approval — regardless of what the interface showed. The form was hiding the controls, but a request sent straight to the REST API bypassed that entirely. We replaced the policies and verified the rejection path. It is a good illustration of the panel's likely theme: a UI is not a permission."

**Q11. "Who can see the readings?"**
> "Any authenticated account can read the configuration and the readings, which is appropriate for a monitoring tool that security and maintenance staff use. Administrative actions — changing limits, managing accounts, deleting devices — are restricted to approved administrators. New accounts are created in a pending state and cannot sign in until an administrator approves them, and the `admin` role itself cannot be granted from the client at all; it is provisioned through a controlled allowlist."

### Group D — Data and reporting

**Q12. "Why Asia/Manila specifically?"**
> "Because a 'day' has to mean the same thing to the operator, the SQL and the PDF. A reading at 23:30 local time belongs to that day in Manila even though it is already the following day in UTC. We implemented the boundary in three places — the browser, the SQL helpers and the PDF generator — and documented that they must be changed together. The Philippines has no daylight saving, so the +08:00 offset is constant and the arithmetic is exact rather than an approximation."

**Q13. "How do you prevent someone editing a report after the fact?"**
> "Two ways. Reports are generated from the readings table with SECURITY INVOKER functions, so the caller's own permissions apply — there is no elevated path to the data. And the threshold configuration used is recorded with the report, so a report cannot be silently re-scored under different limits months later. Where a threshold genuinely changed during a period, the report says so rather than pretending the current values always applied."

**Q14. "You delete old raw readings. Isn't that destroying evidence?"**
> "We retain the aggregate and delete only the raw rows, and only after the month's report has been generated and verified. The report states on its face that it is built from aggregates, not raw readings, and explains why. We consider an honestly labelled smaller dataset more defensible than a larger one presented as if it were raw. The companion CSV in the monthly archive preserves row-level detail."

**Q15. "Why isn't the calendar coloured red for breach days? Isn't that hiding them?"**
> "Nothing is hidden — the count is on the cell and the tooltip names the sensors. We moved away from colour for a specific reason: painting days red made an ordinary month of monitored operation look like an emergency, and it turned a count of events into a health verdict on a room. A room is not 'red'; a room had *N* readings above a limit on a given day. Colour carries an instruction, and on this page there is no instruction to give — it is a historical tally. We reserve colour for the live dashboard, where red means 'evacuate now' and is paired with an alarm. As a side benefit the numbers survive printing, projection and colour-blindness, which colours do not."

### Group E — Limitations (state these yourself; it reads as confidence)

**Q16. "What are the system's weaknesses?"**
> "Four, honestly. One — the MQ-6 is a semiconductor sensor, not a certified combustible-gas detector, so its ppm figures are indicative. Two — grade severity is computed in the application layer for warning and high; the reports grade danger only, in SQL, so the two are separate code paths that must be kept in agreement. We audited them to match, and we have a shared module and a shared SQL helper, but they are not literally the same function. Three — the calendar tells you *how many* readings breached on a day, but not for how long; you have to open the day to see that. Four — the CO₂ 'high' tier has no firmware counterpart, so a reading in that band is visually alarming while the hardware is silent. That is a deliberate trade-off, and it is the one I would most want a panel member to challenge."

**Q17. "What would you do next?"**
> "In order: put warning and high grading into the database so the reports and the dashboard are literally one function rather than two that agree; add breach-duration to the calendar so a flagged day shows how long it lasted, not only how many readings; and replace the MQ-6 with a certified detector for any space where LPG is genuinely stored. The threshold table means none of those require changing how the system is configured."

**Q18. "What would you do differently?"**
> "Treat the database as the source of truth from the first day. We built the configuration as a React value and added persistence later, and that gap is exactly what allowed the code defaults and the saved row to drift apart. The lesson we took from that specific bug is the one the system is now built around: pick one source, and make everything else derive from it."

---

## Appendix A — Where to find each claim

| Topic | File |
|---|---|
| The four dashboard colours | `src/ui.tsx` → `badgeStyles()` |
| The grading rules | `src/lib/thresholdConfig.ts` |
| Generated guide cards, labels, footnotes, standards | `src/lib/thresholdConfig.ts` |
| One hook every component reads | `src/hooks/useThresholdConfig.ts` |
| Limits load, save, realtime sync | `src/context/RoomsContext.tsx` |
| Inline validation + admin gating | `src/pages/admin/SettingsPage.tsx` |
| Gauges, badges, reference cards | `src/pages/DashboardPage.tsx` |
| Calendar (four states, legend) | `src/components/ReportCalendar.tsx` |
| Day panel, breach table, paging | `src/components/DailyReportPanel.tsx` |
| Month grid, PDF buttons | `src/components/MonthlyReportGrid.tsx` |
| Monthly PDF | `src/lib/monthlyPdf.ts` |
| Manila day/month boundaries | `src/lib/reports.ts` + SQL helpers |
| Report SQL (danger definition) | `supabase/migrations/20260914000000_reports_simplified.sql` |
| Ordering constraints, RLS, realtime publication | `supabase/migrations/20260915000000_reference_thresholds.sql` |
| Alert email (grades from raw readings) | `supabase/functions/send-alert-email/index.ts` |

## Appendix B — Four numbers to memorise

1. **LPG 2100 / 4200 ppm = 10 % / 20 % LEL.** The LPG limits are fractions of the Lower Explosive Limit (21 000 ppm), not health exposure limits. This is the single most defensible sentence about the LPG configuration.
2. **CO₂ 3500 ppm, not 5000.** OSHA's 8-hour limit is 5000 ppm; we alarm earlier, on purpose, because the occupants are students and staff.
3. **No data ≠ safe.** The system's central claim, and the answer to almost any "but how do you know?" question.
4. **One threshold table.** Every light, badge, card, chart, report and alert email derives from it. This is the answer to "what is the core of your design?"
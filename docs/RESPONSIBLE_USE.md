# Responsible and lawful use

WorkLens records what people do on a work computer. That is a serious thing to install on somebody's
laptop, and whether it is a reasonable thing depends almost entirely on decisions this software
cannot make for you.

This document is what you need to read before deploying it. It covers exactly what is and is not
collected, the obligations you take on by running it, an employee notice you can adapt, and the
situations where you should not use this at all.

**If you read only one section, read [§6](#6-when-not-to-use-this).**

---

## 1. What this is for

A timesheet built from what actually happened, so nobody has to reconstruct their week from memory.
That is the legitimate purpose, and it is narrow on purpose:

- an owner exporting hours for payroll
- a manager seeing that a distributed team's hours are roughly what everyone agreed
- an employee checking their own record before it becomes a payslip

It is **not** built for performance management, for ranking people against each other, or for
catching anybody out. There is no productivity score anywhere in the product, no "% productive
time", and no leaderboard — not because they were left for later, but because the software
deliberately does not compute them. If what you want is a tool that tells you who your worst
employee is, this is the wrong software and you will find it frustrating.

That restraint is also what makes the rest defensible. A monitoring tool with a narrow, stated
purpose and matching technical limits is a very different proposition, legally and ethically, from
one that collects everything and lets you decide later.

---

## 2. What is collected, exactly

### Collected

| Data | Detail | Governed by |
|---|---|---|
| Active application | Its name and the full path of its executable | always, when capture is running |
| Window title | The title bar text of the focused window | `capture_window_titles` |
| Site | A host and page title *derived from the browser's window title* | `capture_urls` |
| Active vs idle | Whether there was any keyboard or mouse input in the last N seconds | `idle_threshold_seconds` |
| Screenshots | Periodic images of the screen, optionally blurred | `screenshot_enabled` |
| Device liveness | Hostname, OS version, agent version, last check-in | always |

**Defaults are the least-invasive configuration that still produces a usable timesheet**: window
titles on, URL capture **off**, screenshots **off**, work-hours-only **on**. Anything more is a
deliberate act by whoever configures the deployment, and the settings page says what each change
will start collecting.

### Never collected

Not "not currently" — the software contains no mechanism for any of these:

- **What anybody types.** No keyboard hook is installed. The only thing asked of the operating
  system about typing is *how long ago* the last input event happened: a single number, with no key
  in it. There is no code path that could capture a keystroke, and the build fails if one is added.
- **Passwords.** Follows from the above.
- **Clipboard contents.**
- **Camera or microphone.** No such capability is linked into the program.
- **File, email or message contents.** That an application was in use, never what was inside it.
- **Anything at all outside the monitored computer.** No phone, no home device, no personal laptop.

### Two consequences worth understanding

**Idle time carries no attribution.** When somebody is idle, the application and window title are
not recorded *at all* — not recorded-then-hidden. So idle minutes cannot be used to infer what was
on screen while they were away from the keyboard. This is enforced in four independent places,
including a database constraint that rejects the data outright.

**Window titles are the most sensitive thing here.** A title can name a document, a client, a
patient, a medical condition, a legal matter, or a job application. If you enable them — and they
are on by default — you are collecting that. Use `excluded_apps` and `excluded_url_patterns`
generously; exclusions are applied on the device *before anything is written to disk*, so excluded
data never exists to be uploaded. Banking, health, and personal email are the obvious starting
points.

---

## 3. What you are taking on

Running this makes you a data controller for your employees' personal data. The software helps; it
does not discharge the obligation.

### The four things you must do

1. **Tell people, before you deploy.** Not in an updated handbook nobody re-reads — actually tell
   them, in a conversation or a written notice, before the agent is installed. §4 is a notice you
   can adapt.

2. **Obtain consent where your jurisdiction requires it**, and be honest about whether consent
   given by an employee to an employer is meaningfully free. In several jurisdictions it is not
   considered so, and you will need a different lawful basis.

3. **Get legal sign-off for your jurisdiction.** This is not optional and the software cannot do it.
   §5 covers what to ask about.

4. **Keep the promises the product makes.** Notably: every employee can see their own record. Do not
   disable that, and do not deploy this in a way that hides it. The self-view is not a feature to be
   configured away — it is a substantial part of what makes the deployment defensible.

### The agent is visible by design — leave it that way

The agent shows a system tray icon whenever it is running, shows a notice on first run that the
employee has to acknowledge before anything is captured, and offers a menu item to re-read that
notice at any time. If the tray icon cannot be created, **the agent exits rather than run
invisibly**.

Do not attempt to hide it. Beyond the ethics, a monitoring deployment that was concealed is very
hard to defend afterwards, and the technical measures above exist precisely so that "we told them"
is a fact rather than a claim.

---

## 4. An employee notice you can adapt

The agent shows its own notice on first run, generated from your actual configuration — preview it
with `worklens-agentctl notice`. This is for the conversation *before* that: an email, or something
to hand out.

> ### About the time-tracking software on your work computer
>
> **What it is.** We are installing WorkLens on company laptops. It records how work time is spent
> so timesheets can be produced without anyone reconstructing their week from memory.
>
> **What it records.** The application you are working in, whether you are actively using the
> computer or idle, and the title of the window you have open. *[Delete whichever do not apply:
> and the websites you visit, identified from your browser's window title. And a screenshot of your
> screen every N minutes.]*
>
> **What it does not record.** What you type. Your passwords. Your clipboard. Your camera or your
> microphone. The contents of your files, your email or your messages. The software has no ability
> to do any of these — it is not a matter of us choosing not to.
>
> **When it records.** *[Only during working hours, Monday to Friday, 09:00 to 17:30 / At all times
> the computer is in use.]* Nothing is recorded outside that. We have also excluded
> *[banking, health and personal email sites]*, which are filtered on your own computer before
> anything is sent.
>
> **You can see everything.** Sign in at *[dashboard URL]* to see your own record, in the same
> detail your manager sees it. If something looks wrong, tell us — it is a record, and records can
> be corrected.
>
> **What we use it for.** Producing timesheets and payroll. We do not use it to rank people, and the
> software does not calculate a productivity score.
>
> **You can ask us to delete it.** Contact *[name and address]* and we will erase your recorded data.
>
> **You will know when it is running.** There is an icon in your system tray whenever it is active,
> and the software will show you this information again the first time it runs.
>
> Questions to *[name, role, email]*.

Two notes on adapting it. Delete the bracketed options that do not apply rather than leaving them —
a notice describing collection you are not doing teaches people that the notice is boilerplate, and
then the parts that matter get skimmed too. And if you cannot fill in the deletion contact, you are
not ready to deploy.

---

## 5. Jurisdictions

**None of this is legal advice.** It is a list of the questions to take to somebody qualified.

### India — the DPDP Act 2023

This is the target deployment jurisdiction, and the region default (`ap-south-1`) is set so data
stays in-country.

Ask your adviser about:

- **Notice.** The Act requires a clear notice describing the personal data and the purpose. §4 is a
  starting point, not a compliant notice.
- **Consent, and whether you can rely on it.** The Act has a "legitimate use" basis for employment
  purposes, which may fit better than consent for exactly the reason above — consent from an
  employee to an employer is of contested freeness. Which basis you rely on changes what you must
  do.
- **Purpose limitation.** You told people it was for timesheets. Using it for a disciplinary process
  is a different purpose.
- **Data principal rights.** Access, correction and erasure. The self-view and the erasure endpoint
  are built for this; the *process* around them is yours.
- **Retention.** The Act expects erasure once the purpose is served. `retention_days_events` and
  `retention_days_screenshots` are the technical control; deciding the number is a legal judgement.
- **Notifiable breaches**, and who reports.

### Australia — the Privacy Act, and state surveillance law

- The Privacy Act's employee-records exemption is **narrower than commonly assumed** and does not
  simply exempt monitoring.
- Surveillance-devices legislation is **state by state**, and NSW's *Workplace Surveillance Act 2005*
  in particular requires **14 days' written notice** before computer surveillance begins, with
  specified content. Covert surveillance requires a court order.
- If any employee is in NSW, treat the 14-day notice as a hard prerequisite and start counting before
  you install anything.

### The EU and the UK — GDPR

- Consent is generally **not** a valid basis in an employment relationship. You will be relying on
  legitimate interests, which requires a documented balancing test.
- A **Data Protection Impact Assessment** is very likely mandatory. Systematic monitoring of
  employees is squarely the kind of processing that triggers it.
- Works council or employee-representative consultation may be required *before* deployment.
- Screenshots and window titles will be scrutinised as the most intrusive elements. Be ready to
  justify each, and consider leaving them off.

### The United States

- Federal law is comparatively permissive on employer monitoring of employer-owned equipment, but
  **state law varies sharply**. Connecticut and Delaware require written notice; New York requires
  notice on hiring for electronic monitoring; California's CCPA/CPRA gives employees data rights.
- Two-party-consent states matter for audio — not applicable here, since WorkLens records none.

### Everywhere

- If any monitored employee works from home, you are recording in their home. That changes the
  balance, and in several jurisdictions changes the law.
- If any monitored employee is in a different country from you, expect their law to apply to them.

---

## 6. When not to use this

Some deployments are a bad idea regardless of what the law technically permits.

**Do not deploy this covertly.** The software resists it — a visible tray icon, a notice gate that
blocks capture until acknowledged, an agent that exits rather than run invisibly. If your plan
requires people not to know, this is the wrong tool and the plan is the problem.

**Do not deploy it to a personal device.** It is built for company-issued equipment. On somebody's
own laptop the exclusion rules are the only thing standing between you and their private life, and
that is not a good enough boundary.

**Do not enable screenshots without a specific reason you could state out loud to the person being
photographed.** They are off by default. "It seemed useful" is not that reason. If you do enable
them, leave blur on.

**Do not use it to build a case against somebody without telling them they are being recorded for
that purpose.** You told them it was for timesheets. Using it for something else is a purpose
change, and in several jurisdictions an unlawful one.

**Do not deploy it where the recorded data would itself be confidential in a way you cannot
protect.** Window titles in a law firm, a clinic, or a newsroom can name matters, patients and
sources. If a window title would breach a professional obligation, turn title capture off — or do
not deploy this.

**Reconsider entirely if you cannot answer these:**

- Who, specifically, will look at this data, and how often?
- What will you do when somebody's record shows fewer hours than expected — and is that a
  conversation you would be comfortable having in front of the whole team?
- Would you be comfortable if your own employer installed this on your laptop, configured exactly the
  way you are about to configure it?

That last one is not rhetorical. It is the most useful test in this document.

---

## 7. What the software does to help

So the technical measures are legible rather than buried:

| Concern | Measure |
|---|---|
| People must know | Tray icon whenever running; first-run notice gate; agent exits rather than run invisibly; notice re-readable from the tray |
| People must see their own data | Employee self-view, built from the same components as the manager view, in the same detail |
| Collect less by default | Screenshots and URL capture off; work-hours-only on; the least-invasive configuration that still produces a timesheet |
| Sensitive things excluded | `excluded_apps` and `excluded_url_patterns`, applied on the device before anything is written to disk |
| Idle time reveals nothing | Attribution stripped from idle samples, enforced in four independent places including a database constraint |
| Nothing outside hours | Work-hours check runs before capture, so an out-of-hours screenshot never exists even in memory |
| Data does not accumulate | Configurable retention, enforced nightly, deleting rows and S3 objects |
| Erasure is real | Hard-delete endpoint that removes rows and objects and records the counts |
| Access is accountable | Every view of an employee's data, every export and every config change written to an append-only audit log the application cannot alter |
| Admins are verified | Second factor required to see anyone else's data |
| Screenshots are marked | The blurred flag is surfaced wherever an image appears, so a viewer always knows what they are looking at |

And what it deliberately does not do: no productivity score, no ranking, no full URLs, no keystroke
capture, no covert mode.

---

## 8. If you are an employee reading this

You may have found this because WorkLens is on your work computer.

- **Read what it records**: §2 above, and `worklens-agentctl notice` on the machine itself, which
  prints exactly what your organisation has configured.
- **See your own data.** You have a sign-in. Everything recorded about you is visible to you, in the
  same detail your manager sees it. If your organisation has not given you access, that is a
  departure from how this software is meant to be deployed.
- **What it cannot see**: what you type, your passwords, your clipboard, your camera, your
  microphone, the contents of your files or messages. Not by policy — the software has no ability to.
- **If something looks wrong**, say so. It is a record, and a record with an error in it should be
  corrected before it becomes a payslip.
- **You can ask for your data to be deleted.** Whether your employer must comply depends on where you
  are, but the software has a working erasure path, so "it is not technically possible" is not a
  valid answer.
- **You can stop it.** It runs as your own user account, at your own permission level, and the tray
  menu has a Quit item. That is deliberate. Stopping it means your time will not be recorded, which
  is a conversation with your employer rather than a technical problem — but the choice is
  deliberately yours to make, not hidden from you.

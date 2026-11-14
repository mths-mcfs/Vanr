// A test vault in the Obsidian format: notes with the syntax the import has to understand (front matter
// with properties, aliases, #tags, [[links]] with link text, heading and block, ![[embeds]], ^block ids,
// callouts, %% comments, == highlights, tasks, tables, footnotes, math) and two binary attachments. It
// serves the editor round trip (md → editor → md) and the zip import and export tests. Text written for
// the test; it does not come from a real vault.

export interface VaultFile {
  path: string;
  text: string;
}

// A transparent 1×1 PNG and a minimal PDF.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
const PDF_MIN =
  "JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMyAzXT4+ZW5kb2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSPj4KJSVFT0YK";

export const VAULT_ATTACHMENTS: { path: string; base64: string; contentType: string }[] = [
  { path: "attachments/diagram.png", base64: PNG_1X1, contentType: "image/png" },
  { path: "attachments/contract.pdf", base64: PDF_MIN, contentType: "application/pdf" },
];

export const VAULT_NOTES: VaultFile[] = [
  {
    path: "Start.md",
    text: `---
aliases: [Home, Front page]
tags: [index]
status: active
---
# Welcome to the team handbook

This vault gathers how the team works. Start with [[Processes/Onboarding|onboarding]] and read
[[Values]] before your first week.

- [[Processes/Meetings]]
- [[Processes/Code review#Checklist|review checklist]]
- [[Glossary]]

> [!tip] Tip
> Use search (Ctrl+K) to find any note.

#handbook #team/product
`,
  },
  {
    path: "Values.md",
    text: `---
tags:
  - culture
  - values
author: Ana
reviewed: 2026-09-14
---
# Values

1. **Clarity** before speed.
2. *Own* what you ship.
3. Ask for help early. ^ask-for-help

Whoever disagrees with a value opens a proposal in [[Processes/Proposals]].

---

Value 3 is quoted in [[Processes/Onboarding#^week-1]].
`,
  },
  {
    path: "Glossary.md",
    text: `---
aliases:
  - Terms
  - Dictionary
---
# Glossary

| Term | Meaning | Since |
|:------|:-----------|------:|
| PR | Pull request | 2024 |
| SLO | Service level objective | 2025 |
| \`p95\` | 95th percentile latency | 2025 |

[^1]: New terms come in through a PR.

See also: [[Architecture/Overview]][^1].
`,
  },
  {
    path: "Processes/Onboarding.md",
    text: `---
title: Onboarding
tags: [process, hr]
duration_days: 10
remote: true
---
# Onboarding

## Week 1

- [ ] Get access to the repository
- [ ] Read [[Values]]
- [x] Sign the ![[attachments/contract.pdf]]
  - [ ] Keep the copy

The first week is for reading. ^week-1

## Week 2

1. Pair with someone on the team
2. Open your first PR
   1. Small
   2. With a test

> [!warning]- Do not skip
> Production access is granted only after week 2.
> Talk to [[People/Bruno|Bruno]].
`,
  },
  {
    path: "Processes/Meetings.md",
    text: `# Meetings

Two fixed meetings a week:

* Planning, Monday at 10 am
* Retro, Friday at 4 pm

%% remember to move the retro on the holiday %%

Minutes go to [[Minutes/2026-10-20]]. Use ==highlight== for decisions.

**Rule:** a meeting without an agenda is cancelled.
`,
  },
  {
    path: "Processes/Code review.md",
    text: `# Code review

## Checklist

- Does the test fail before the fix?
- Does the name say what it does?
- Is there an ~~old comment~~ left over?

## Example

\`\`\`ts
export function sum(a: number, b: number): number {
  return a + b; // [[not a link]]
}
\`\`\`

Use \`[[brackets]]\` in code without fear: it does not become a link.

> A reviewer's quote:
> > "Code is read much more often than it is written."
`,
  },
  {
    path: "Processes/Proposals.md",
    text: `---
tags: [process]
status: draft
priority: 2
---
# Proposals

Every proposal has a *problem*, _alternatives_ and a __decision__.

Template: ![[Templates/Proposal]]

External links: [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119 "key words") and <https://example.com/rfc>.
`,
  },
  {
    path: "Templates/Proposal.md",
    text: `# {{title}}

**Problem:**

**Alternatives:**

1.
2.

**Decision:**

Date: {{date}}
`,
  },
  {
    path: "Architecture/Overview.md",
    text: `---
tags: [architecture]
aliases: [Architecture]
---
# Overview

The system has three parts:

\`\`\`mermaid
flowchart LR
  web --> api --> db[(Postgres)]
\`\`\`

![[attachments/diagram.png|300]]

The cost formula is $c = n \\times p$ and the slack formula is:

$$
s = 1 - \\frac{u}{t}
$$

Details in [[Architecture/Database#Indexes]] and [[Architecture/Database#^main-table|in the table]].
`,
  },
  {
    path: "Architecture/Database.md",
    text: `# Database

## Tables

| table | rows |
|---|---|
| pages | 120k |
| links | 900k |

^main-table

## Indexes

- \`pages_slug_uq\` on \`(workspace, slug)\`
- GIN on \`props\`

Escaped characters: 5 \\* 3, \\_not italic\\_ and \\# not a heading.
`,
  },
  {
    path: "People/Bruno.md",
    text: `---
role: Engineering
started: 2025-03-01
email: bruno@example.com
---
# Bruno

Looks after [[Architecture/Database]] and the on-call rotation.
Favorite shortcut: <kbd>Ctrl</kbd>+<kbd>K</kbd>.

A line with a hard break
continues here.
`,
  },
  {
    path: "People/Carla.md",
    text: `---
role: Product
tags: [people]
---
# Carla

Writes the product [[Processes/Proposals|proposals]]. Always mentions the [[Glossary]].

<details>
<summary>History</summary>

Joined in 2024.

</details>
`,
  },
  {
    path: "Minutes/2026-10-20.md",
    text: `---
date: 2026-10-20
attendees: [Ana, Bruno, Carla]
---
# Minutes 2026-10-20

- Decision: move search to Postgres. #decision
- Open item: review [[Processes/Onboarding#Week 2]].
- Next: [[Minutes/2026-10-27]]

> [!note] Context
> The old search could not handle 1 M snippets.
`,
  },
  {
    path: "Minutes/2026-10-27.md",
    text: `# Minutes 2026-10-27

No agenda: meeting cancelled (see [[Processes/Meetings]]).
`,
  },
  {
    path: "Journal/2026-10-21.md",
    text: `A busy day.

- 09:00 review of PR #482
- 14:00 chat with [[People/Carla]] about #roadmap

Loose idea: ==link minutes automatically==.
`,
  },
  {
    path: "Projects/New search.md",
    text: `---
status: in progress
priority: 1
owner: "[[People/Bruno]]"
tags: [project, search]
---
# New search

## Goal

Replace search with **FTS** + \`pg_trgm\`.

## Tasks

- [x] Benchmark with 1 M snippets
- [ ] Partial index per workspace
- [ ] Remove the old search

## Risks

| risk | chance | impact |
|:-:|:-:|:-:|
| slowness | medium | high |

Related: [[Architecture/Database#Indexes|indexes]], [[Minutes/2026-10-20]].
`,
  },
  {
    path: "Projects/Wiki.md",
    text: `---
status: idea
tags: [project]
---
# Wiki

A wiki with [[links]] that do not break on rename. The note [[Page that does not exist]] does not exist yet.

Block reference: ![[Values#^ask-for-help]]
`,
  },
  {
    path: "Reading/Books.md",
    text: `# Books

1. *A Philosophy of Software Design*
2. *The Pragmatic Programmer*
3. *Accelerate*

3. A list that starts at 3
4. continues

A quote: "Simple is better than complex."
`,
  },
  {
    path: "Reading/Articles.md",
    text: `# Articles

- [Why you can't delete Yjs documents](https://liveblocks.io/docs/guides/why-you-cant-delete-yjs-documents)
- [Annotation model](https://www.w3.org/TR/annotation-model/#text-quote-selector)

External image: ![logo](https://example.com/logo.png "Logo")
`,
  },
  {
    path: "Drafts/Untitled.md",
    text: "",
  },
  {
    path: "Drafts/Résumé notes.md",
    text: `A note without a heading, with just a paragraph, an emoji 🚀 and accents: café, naïve, façade.
`,
  },
  {
    path: "Drafts/Nested list.md",
    text: `- level 1
  - level 2
    - level 3
      - level 4
- back to 1
  1. numbered inside
  2. second

Term
: definition (not standard markdown)
`,
  },
  {
    path: "Drafts/HTML.md",
    text: `<div align="center">
  <img src="https://example.com/x.png" width="80">
</div>

Text after the HTML.

<!-- html comment -->
`,
  },
  {
    path: "Drafts/Headings.md",
    text: `Setext heading
=============

Setext subheading
----------------

### Heading with **bold** and \`code\`

#### Heading with [[Glossary|link]]
`,
  },
  {
    path: "Drafts/Callouts.md",
    text: `> [!info]+ Open
> Content with **bold**.
>
> - item

> [!question] A question without a body

> [!danger]
> No title.
`,
  },
];

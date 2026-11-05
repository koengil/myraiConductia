# Recall corpora: the v1 format

A recall corpus is a set of synthetic M&A mail with an answer key. `recall.test.ts` runs every corpus here through
the firm router and pins one table per corpus: how many deal messages the rules find, by the way the deal is
written, and how much unrelated mail they wrongly attach to a deal.

You are writing a corpus without seeing the router, on purpose. Write mail the way bankers write it. Do not look
for the rules and do not write mail to suit them. A rule that only works on mail written for it is not measured.

## Files

One corpus is three files with the same name in this directory:

```text
<name>.messages.json   what the mailboxes hold
<name>.labels.json     what each message is, outside the messages
<name>.world.json      who and what exists: sources, people, companies, deals
```

Each file starts with `"format": "conductia.recall-corpus/v1"`. The loader refuses any field not listed below,
a message without a label, a label without a message, a source or deal the world does not define, and any other
version string. Run `npx vitest run tests/discovery/recall` to check a corpus; a refusal names the path and the
field, never a value.

## Rules for the content

- **Synthetic only.** Invented people, firms and deals. Every domain ends in `.example`. Never paste real mail,
  real names or anything from a real mailbox.
- **No answer inside a message.** A label, a deal name or a form never appears in a message body or subject unless
  a banker would have written it there.
- **One firm.** `world.firm.domain` is the firm's own mail domain. Everyone at that domain is firm staff.

## `<name>.messages.json`

```json
{
  "format": "conductia.recall-corpus/v1",
  "messages": [ <message or document>, ... ]
}
```

A message is a Microsoft Graph mail message plus `sources`:

```json
{
  "id": "m-0001",
  "internetMessageId": "<m-0001@firm.example>",
  "conversationId": "conv-17",
  "subject": "Seller update call",
  "sentDateTime": "2026-09-14T09:30:00Z",
  "from": { "emailAddress": { "name": null, "address": "ana@firm.example" } },
  "toRecipients": [{ "emailAddress": { "name": null, "address": "deals@firm.example" } }],
  "ccRecipients": [],
  "body": { "contentType": "text", "content": "Plain text, or HTML with contentType html." },
  "sources": ["src-deals"]
}
```

- `id` is the mailbox's own item id. `internetMessageId` is unique across the corpus and is the message's key in
  the labels file.
- `conversationId` is the provider's thread id, or `null` when the provider gives none. Replies in one thread share
  it. Optional fields: `providerThreadId`, `receivedDateTime`, `hasAttachments`.
- `sources` lists the source ids (see the world file) whose mailbox holds this message. A message that two
  mailboxes both hold is written once, with both ids; each (message, source) pair is one observation and is
  scored on its own.
- Quoted history belongs in a reply the way a mail client writes it. The pipeline keeps the top of the message.

A document (a file in a deal folder) is:

```json
{ "kind": "document", "id": "doc-01", "name": "Some Name CIM.docx", "text": "Extracted text.",
  "author": "ana@firm.example", "sources": ["src-deals"] }
```

Its label key is its `id`.

**Order matters.** A source's messages are read in the order they appear in this file, in the pages of the real
readers: 50 messages at a time (the Graph reader), and 10 whole threads at a time, most recently active thread first
(the Gmail reader). The harness also reads 10-message pages, as a stress case, forward and in the opposite order. So
put a thread's root before its replies, and spread the mail so that a teacher and its follower do not always share a
page. A deal-heavy source with about 100 messages is the right scale for the team inbox.

## `<name>.labels.json`

```json
{
  "format": "conductia.recall-corpus/v1",
  "labels": {
    "<m-0001@firm.example>": { "deal": "bramble", "form": "thread_reply", "variant": "root" },
    "<m-0002@firm.example>": { "deal": null, "form": "noise" }
  }
}
```

- The key is the message's `internetMessageId` (a document's `id`). Every message needs exactly one label.
- `deal` is a key of `world.deals`, or `null` for mail that belongs to no deal.
- `form` says how the mail names its deal, or why it is deliberately not a deal. It is one of the following.
  `variant` is free text for breaking a form down in the table.

| form | the mail |
|---|---|
| `project_codename` | deal mail that names the deal by a code name written "Project <Name>", in the subject or the body |
| `thread_reply` | a reply in a deal thread, in the same mailbox as the message that named the deal, that no longer names it |
| `thread_cross_source` | the same, but the message that named the deal sits in another mailbox |
| `subject_prefix` | deal mail whose subject opens with a bare deal word and a colon, several topics, several firm senders |
| `subject_prefix_thin` | the same, but only one topic or only one sender |
| `alias_same_source` | mail that uses the bare code-name word, in the mailbox that also holds a "Project <Name>" message |
| `alias_cross_source` | the same, but the "Project <Name>" message is in another mailbox |
| `alias_mixed_copy_leak` | mail read in a team inbox and a personal mailbox, and mail in a mailbox that cannot see the team inbox, that use a bare code-name word the team inbox alone introduced |
| `alias_mixed_copy_personal_cost` | a copy read in two mailboxes that uses a bare code-name word introduced in the personal one only |
| `alias_mixed_copy_shared_cost` | a copy read in two mailboxes that uses a bare code-name word introduced in the team inbox only |
| `real_name` | deal mail that names the client or target company outright, from firm people |
| `real_name_unentitled` | the same, in a source whose reader is not allowed to list that company |
| `real_name_unapproved` | the same, in a source with no owner |
| `real_name_document` | a document named for the company |
| `no_marker` | deal mail with nothing in it that names the deal |
| `noise` | ordinary firm and vendor mail: newsletters, notices, calendar replies, IT, expenses, office life |
| `noise_collision` | unrelated mail whose subject shares a word with a code name or a company |
| `noise_client_mention` | a client written about for another reason (results, dinner, press) |
| `noise_client_coverage_term` | client coverage mail that uses a deal-process word for something else (a lease, a sponsorship) |

Write at least a handful of each form you can make realistic, and 150 or more `noise` messages across the
sources. Real inboxes are mostly noise; the false-positive count is the table's most important number.

## `<name>.world.json`

```json
{
  "format": "conductia.recall-corpus/v1",
  "firm": { "companyId": "co-firm", "domain": "firm.example", "approvals": ["firm_name_alias"] },
  "sources": [
    { "id": "src-ana", "address": "ana@firm.example", "kind": "personal", "ownerPersonId": "p-ana" },
    { "id": "src-deals", "address": "deals@firm.example", "kind": "team", "readerPersonIds": ["p-ana"], "headline": true }
  ],
  "people": [
    { "id": "p-ana", "address": "ana@firm.example", "companyId": "co-firm", "leadsView": true, "searchCompanies": true }
  ],
  "companies": [
    { "id": "co-firm", "name": "Firm Partners", "type": "bank", "registeredByCompanyId": "co-firm" },
    { "id": "co-x", "name": "Example Foods", "type": "client", "registeredByCompanyId": "co-firm" }
  ],
  "deals": {
    "bramble": { "keys": ["bramble"] },
    "examplefoods": { "keys": ["firm:example-foods"] }
  }
}
```

- `sources`: a `personal` source is one person's mailbox (`ownerPersonId`); a `team` source is a shared inbox
  (`readerPersonIds`); a `personal` source with no owner is a mailbox no one owns. Exactly one source is the
  `headline` source, the team inbox the report is about. List sources in the order an operator would read them.
- `people`: the readers. `leadsView` says whether the person may view leads; `searchCompanies` says whether they
  may list companies other than the ones their own firm registered.
- `companies`: the firm itself (`bank`), its clients and targets, and acquirers. `registeredByCompanyId` is who
  entered the company; a company another firm registered is not listable by a person who cannot search.
- `deals`: each deal and the route keys that count as finding it. A code name's key is the lower-cased word
  (`bramble`). A deal found by its company name is `firm:` plus the lower-cased name with spaces joined by
  hyphens (`firm:example-foods`). A deal that no rule should be able to name has `"keys": []`.
- `firm.approvals` lists what the firm has switched on. Keep `firm_name_alias` unless you are testing the
  unapproved case.

## Adding a corpus

1. Put the three files here. The directory is read as a glob, so no registration is needed.
2. Run `npx vitest run tests/discovery/recall`. The first run fails with the table the corpus produces, because a
   corpus with no pinned table fails.
3. Read the table against what you expect from the mail, row by row. A row that surprises you is either a labelling
   mistake (fix the corpus) or a finding (name it in the pull request).
4. Pin the table in `recall.test.ts` under the corpus name. From then on a rule change shows up as a reviewed
   diff of that table.

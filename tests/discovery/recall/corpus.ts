// The in-repo recall corpus (#173 G-09): synthetic M&A team-inbox mail for one fictional firm, labelled by
// construction. Everything is under .example. It is FROZEN: later slices change harness plumbing and the pinned
// tables in recall.test.ts, never this file (the "don't grade our own homework" fence). The rows it adds beyond
// codenames are the point: a rule is judged on mail it was not written against.
//
// Shape: one firm (harrow.example) with five sources,
//   src-ana      Ana's mailbox. She reads deals@ and may list companies.
//   src-tom      Tom's mailbox. He may not view leads.
//   src-deals    the team inbox deals@, the headline source.
//   src-lena     Lena's mailbox. She does not read deals@ and may not search other firms' companies.
//   src-archive  a mailbox with no owner (no firm to approve).
// Every source is laid out in pages of PAGE_SIZE (format.ts) so a teacher and its learner sit on different
// pages, or on the same one, on purpose. PLAN says which explicit message sits on which page; the rest of a page
// is filled with ordinary mail that must route nowhere. A message read in two sources sits on the SAME page index
// in both, so the shared file order keeps every source's own order.

import type { MailRecipient } from '@/lib/discovery/source/types';
import {
  RECALL_FORMAT,
  RECALL_PAGE_SIZE as PAGE_SIZE,
  type RecallCorpusFiles,
  type RecallForm,
  type RecallLabel,
  type RecallMessage,
  type RecallWorld,
} from './format';

const DOMAIN = 'harrow.example';
const at = (local: string) => `${local}@${DOMAIN}`;
const recipient = (address: string): MailRecipient => ({ emailAddress: { name: null, address } });

const ANA = 'src-ana';
const TOM = 'src-tom';
const DEALS = 'src-deals';
const LENA = 'src-lena';
const ARCHIVE = 'src-archive';
/** The order the world lists the sources, and the order a round of the file is emitted in. */
const SOURCE_ORDER = [ANA, TOM, DEALS, LENA, ARCHIVE];

const WORLD: RecallWorld = {
  firm: { companyId: 'co-harrow', domain: DOMAIN, approvals: ['firm_name_alias'] },
  sources: [
    { id: ANA, address: at('ana'), kind: 'personal', ownerPersonId: 'p-ana' },
    { id: TOM, address: at('tom'), kind: 'personal', ownerPersonId: 'p-tom' },
    { id: DEALS, address: at('deals'), kind: 'team', readerPersonIds: ['p-ana'], headline: true },
    { id: LENA, address: at('lena'), kind: 'personal', ownerPersonId: 'p-lena' },
    { id: ARCHIVE, address: at('archive'), kind: 'personal' },
  ],
  people: [
    { id: 'p-ana', address: at('ana'), companyId: 'co-harrow', leadsView: true, searchCompanies: true },
    { id: 'p-tom', address: at('tom'), companyId: 'co-harrow', leadsView: false, searchCompanies: false },
    { id: 'p-lena', address: at('lena'), companyId: 'co-harrow', leadsView: true, searchCompanies: false },
  ],
  companies: [
    { id: 'co-harrow', name: 'Harrow Partners', type: 'bank', registeredByCompanyId: 'co-harrow' },
    { id: 'co-fenwick', name: 'Fenwick Foods', type: 'client', registeredByCompanyId: 'co-harrow' },
    { id: 'co-garland', name: 'Garland Health', type: 'target', registeredByCompanyId: 'co-harrow' },
    { id: 'co-hollis', name: 'Hollis Group', type: 'client', registeredByCompanyId: 'co-northgate' },
    { id: 'co-quillon', name: 'Quillon Capital', type: 'acquirer', registeredByCompanyId: 'co-harrow' },
  ],
  deals: {
    aster: { keys: ['aster'] },
    bramble: { keys: ['bramble'] },
    briar: { keys: ['briar'] },
    calder: { keys: ['calder'] },
    dunmore: { keys: ['dunmore'] },
    ember: { keys: ['ember'] },
    fallow: { keys: ['fallow'] },
    gorse: { keys: ['gorse'] },
    heron: { keys: ['heron'] },
    fenwick: { keys: ['firm:fenwick-foods'] },
    garland: { keys: ['firm:garland-health'] },
    hollis: { keys: ['firm:hollis-group'] },
    // A deal no rule can name: its mail carries no marker at all.
    mercer: { keys: [] },
  },
};

type Spec = {
  subject: string;
  from: string;
  body?: string;
  conv?: string;
  to?: string[];
  cc?: string[];
  sources: string[];
  label: RecallLabel;
};
type DocSpec = { document: { name: string; text: string; author: string }; sources: string[]; label: RecallLabel };

const label = (deal: string | null, form: RecallForm, variant?: string): RecallLabel => ({
  deal,
  form,
  ...(variant ? { variant } : {}),
});

const MARCUS = at('marcus');
const ELLIS = at('ellis');
const RHEA = at('rhea');
const DEAL_TEAM = [at('deals')];

/** The explicit messages, by id. Bodies avoid every codename and alias word except where a row needs one. */
const EXPLICIT: Record<string, Spec | DocSpec> = {
  // project_codename: a literal "Project Aster" routes wherever it is read.
  'aster-cim': {
    subject: 'Project Aster: CIM draft v2', from: MARCUS, to: [...DEAL_TEAM, at('ana')],
    body: 'Draft attached for review ahead of the management session.', sources: [ANA, DEALS],
    label: label('aster', 'project_codename', 'subject_shared'),
  },
  'aster-kickoff': {
    subject: 'Project Aster kickoff notes', from: at('ana'), to: [MARCUS],
    body: 'Notes from the kickoff are attached.', sources: [ANA], label: label('aster', 'project_codename', 'subject_personal'),
  },
  'aster-body': {
    subject: 'Management presentation prep', from: at('tom'), to: [MARCUS],
    body: 'Updating the Project Aster deck before Friday.', sources: [TOM], label: label('aster', 'project_codename', 'body'),
  },

  // thread_reply: the root names Bramble in its body; the replies drop the marker.
  'bramble-root': {
    subject: 'Seller update call', from: MARCUS, conv: 'conv-bramble', to: DEAL_TEAM,
    body: 'Agenda for the Project Bramble seller update is below.', sources: [DEALS], label: label('bramble', 'thread_reply', 'root'),
  },
  'bramble-reply-1': {
    subject: 'RE: Seller update call', from: at('ana'), conv: 'conv-bramble', to: DEAL_TEAM,
    body: 'Thursday works for us.', sources: [DEALS], label: label('bramble', 'thread_reply', 'reply'),
  },
  'bramble-reply-2': {
    subject: 'Re: Seller update call', from: MARCUS, conv: 'conv-bramble', to: DEAL_TEAM,
    body: 'Confirmed, dial-in to follow.', sources: [DEALS], label: label('bramble', 'thread_reply', 'reply'),
  },
  // A Gmail-shape reply whose thread reference is gone: no thread id, so no continuation, by design.
  'bramble-reply-gmail': {
    subject: 'Re: Seller update call', from: at('tom'), to: DEAL_TEAM,
    body: 'Adding the lender contacts.', sources: [DEALS], label: label('bramble', 'thread_reply', 'reply_no_thread_id'),
  },
  // The subject changed, which ends the thread, by design.
  'bramble-reply-retitled': {
    subject: 'RE: Seller update call - revised timing', from: at('ana'), conv: 'conv-bramble', to: DEAL_TEAM,
    body: 'Pushing the call to next week.', sources: [DEALS], label: label('bramble', 'thread_reply', 'reply_changed_subject'),
  },

  // thread_cross_source: the root is in Ana's mailbox only, the reply in deals@.
  'briar-root': {
    subject: 'Buyer outreach list', from: at('ana'), conv: 'conv-briar', to: [MARCUS],
    body: 'Draft list for Project Briar attached.', sources: [ANA], label: label('briar', 'thread_cross_source', 'root'),
  },
  'briar-reply': {
    subject: 'RE: Buyer outreach list', from: MARCUS, conv: 'conv-briar', to: DEAL_TEAM,
    body: 'Two names to add before it goes out.', sources: [DEALS], label: label('briar', 'thread_cross_source', 'reply'),
  },

  // subject_prefix: Calder opens two topics from two firm people on one page; Dunmore does not.
  'calder-1': { subject: 'Calder: lender list', from: MARCUS, to: DEAL_TEAM, sources: [DEALS], label: label('calder', 'subject_prefix') },
  'calder-2': { subject: 'Calder: valuation range', from: at('ana'), to: DEAL_TEAM, sources: [DEALS], label: label('calder', 'subject_prefix') },
  'calder-3': { subject: 'Re: Calder: lender list', from: MARCUS, to: DEAL_TEAM, sources: [DEALS], label: label('calder', 'subject_prefix') },
  // subject_prefix_thin: one topic, two senders ...
  'dunmore-1': { subject: 'Dunmore: lender list', from: MARCUS, to: DEAL_TEAM, sources: [DEALS], label: label('dunmore', 'subject_prefix_thin', 'one_topic') },
  'dunmore-2': { subject: 'Re: Dunmore: lender list', from: at('ana'), to: DEAL_TEAM, sources: [DEALS], label: label('dunmore', 'subject_prefix_thin', 'one_topic') },
  // ... or two topics, one sender (the mailbox owner, with no reply).
  'dunmore-tom-1': { subject: 'Dunmore: draft notes', from: at('tom'), to: [MARCUS], sources: [TOM], label: label('dunmore', 'subject_prefix_thin', 'one_sender') },
  'dunmore-tom-2': { subject: 'Dunmore: bid notes', from: at('tom'), to: [MARCUS], sources: [TOM], label: label('dunmore', 'subject_prefix_thin', 'one_sender') },

  // alias_same_source: the literal and the bare word are both in deals@.
  'ember-teacher': {
    subject: 'Project Ember sell-side timeline', from: MARCUS, to: DEAL_TEAM, sources: [DEALS], label: label('ember', 'alias_same_source', 'literal'),
  },
  'ember-bare-subject': { subject: 'Ember bidder questions', from: at('ana'), to: DEAL_TEAM, sources: [DEALS], label: label('ember', 'alias_same_source', 'bare') },
  'ember-bare-body': {
    subject: 'Weekly deal check-in', from: at('tom'), to: DEAL_TEAM,
    body: 'Spoke with Ember management about the process letter timing.', sources: [DEALS], label: label('ember', 'alias_same_source', 'bare_body'),
  },

  // alias_cross_source: the literal is in Ana's mailbox only, the bare word in deals@.
  'fallow-literal': { subject: 'Project Fallow: bid process', from: at('ana'), to: [MARCUS], sources: [ANA], label: label('fallow', 'alias_cross_source', 'literal') },
  'fallow-bare': { subject: 'Fallow bidder call', from: MARCUS, to: DEAL_TEAM, sources: [DEALS], label: label('fallow', 'alias_cross_source', 'bare') },

  // alias_mixed_copy_personal_cost: Gorse is taught in Ana's mailbox only; a copy read in both names it bare.
  'gorse-teacher': { subject: 'Project Gorse: draft SPA', from: at('ana'), to: [MARCUS], sources: [ANA], label: label('gorse', 'alias_mixed_copy_personal_cost', 'teacher') },
  'gorse-mixed': {
    subject: 'Gorse diligence list', from: MARCUS, to: [...DEAL_TEAM, at('ana')], sources: [ANA, DEALS],
    label: label('gorse', 'alias_mixed_copy_personal_cost', 'mixed'),
  },

  // alias_mixed_copy_leak and _shared_cost: Heron is taught in deals@ only.
  'heron-teacher': { subject: 'Project Heron: teaser draft', from: MARCUS, to: DEAL_TEAM, sources: [DEALS], label: label('heron', 'alias_mixed_copy_leak', 'teacher') },
  // The carrier: a copy of an Aster message, read in deals@ and in Ana's mailbox, that also names Heron bare.
  'heron-carrier': {
    subject: 'Project Aster: weekly status', from: MARCUS, to: DEAL_TEAM, cc: [at('ana')],
    body: 'Also, Heron needs a decision on the teaser.', sources: [DEALS, ANA], label: label('aster', 'alias_mixed_copy_leak', 'carrier'),
  },
  // Lena does not read deals@. Her bare Heron routes only if deals@ knowledge reached her mailbox.
  'heron-lena': { subject: 'Heron teaser feedback', from: at('tom'), to: [at('lena')], sources: [LENA], label: label('heron', 'alias_mixed_copy_leak', 'lena_bare') },
  'heron-mixed': {
    subject: 'Heron buyer feedback', from: MARCUS, to: DEAL_TEAM, cc: [at('ana')], sources: [DEALS, ANA],
    label: label('heron', 'alias_mixed_copy_shared_cost', 'mixed'),
  },

  // real_name: the deal is written by its company name. Six ways to write it.
  'rn-full-fenwick': {
    subject: 'Fenwick Foods CIM comments', from: at('ana'), to: DEAL_TEAM,
    body: 'Comments from the client are consolidated below.', sources: [DEALS], label: label('fenwick', 'real_name', 'full_name_term'),
  },
  'rn-full-garland': { subject: 'Garland Health NDA status', from: MARCUS, to: DEAL_TEAM, sources: [DEALS], label: label('garland', 'real_name', 'full_name_term') },
  'rn-short': { subject: 'Fenwick CIM comments', from: at('ana'), to: DEAL_TEAM, sources: [DEALS], label: label('fenwick', 'real_name', 'short_form') },
  'rn-case': { subject: 'FENWICK FOODS NDA status', from: MARCUS, to: DEAL_TEAM, sources: [DEALS], label: label('fenwick', 'real_name', 'case_variant') },
  'rn-body': {
    subject: 'CIM comments', from: at('ana'), to: DEAL_TEAM,
    body: 'Fenwick Foods asked for the revised timeline before Friday.', sources: [DEALS], label: label('fenwick', 'real_name', 'body_only'),
  },
  'rn-external': {
    subject: 'Fenwick Foods CIM questions', from: 'cfo@fenwickfoods.example', to: DEAL_TEAM, sources: [DEALS],
    label: label('fenwick', 'real_name', 'external_sender'),
  },
  'rn-noterm': { subject: 'Garland Health site visit', from: MARCUS, to: DEAL_TEAM, sources: [DEALS], label: label('garland', 'real_name', 'no_process_term') },
  // real_name_unentitled: a reader of the source may not list the company.
  'rn-unent-tom': { subject: 'Fenwick Foods NDA status', from: at('tom'), to: [MARCUS], sources: [TOM], label: label('fenwick', 'real_name_unentitled', 'no_leads_view') },
  'rn-unent-lena-1': { subject: 'Hollis Group CIM comments', from: at('lena'), to: [MARCUS], sources: [LENA], label: label('hollis', 'real_name_unentitled', 'not_listable') },
  'rn-unent-lena-2': { subject: 'Hollis Group NDA draft', from: at('lena'), to: [MARCUS], sources: [LENA], label: label('hollis', 'real_name_unentitled', 'not_listable') },
  // real_name_unapproved: a source with no owner has no firm, so no firm approved its names.
  'rn-unapproved-fenwick': { subject: 'Fenwick Foods CIM comments', from: RHEA, to: [at('archive')], sources: [ARCHIVE], label: label('fenwick', 'real_name_unapproved') },
  'rn-unapproved-garland': { subject: 'Garland Health LOI draft', from: RHEA, to: [at('archive')], sources: [ARCHIVE], label: label('garland', 'real_name_unapproved') },
  // real_name_document: an internally authored document is not a message.
  'doc-fenwick-cim': {
    document: {
      name: 'Fenwick Foods CIM.docx',
      text: 'Confidential information memorandum. Business overview, financial summary and growth plan.',
      author: at('ana'),
    },
    sources: [DEALS], label: label('fenwick', 'real_name_document'),
  },

  // no_marker: deal mail with nothing a rule could read. Out of reach.
  'nm-nda': {
    subject: 'NDA comments', from: MARCUS, to: DEAL_TEAM,
    body: "Counsel's mark-up is attached with three open points on the non-solicit.", sources: [DEALS], label: label('mercer', 'no_marker'),
  },
  'nm-team': {
    subject: 'Deal team change: weekly staffing', from: at('ana'), to: DEAL_TEAM,
    body: 'Staffing moves from Monday are listed below.', sources: [DEALS], label: label('mercer', 'no_marker'),
  },
  'nm-timeline': {
    subject: 'Bid timeline moved', from: MARCUS, to: DEAL_TEAM,
    body: 'The second round now closes a week later.', sources: [DEALS], label: label('mercer', 'no_marker'),
  },

  // noise with a rule's own shape: an internal prefix two firm people open on two topics (it routes) ...
  'townhall-1': { subject: 'Townhall: agenda for Friday', from: at('lena'), to: [at('tom')], sources: [LENA], label: label(null, 'noise', 'internal_prefix') },
  'townhall-2': { subject: 'Townhall: speaker list', from: at('tom'), to: [at('lena')], sources: [LENA], label: label(null, 'noise', 'internal_prefix') },
  // ... and one a single person opens (it does not).
  'recruiting-1': { subject: 'Recruiting: shortlist', from: at('tom'), to: [MARCUS], sources: [TOM], label: label(null, 'noise', 'internal_prefix') },
  'recruiting-2': { subject: 'Recruiting: interview slots', from: at('tom'), to: [MARCUS], sources: [TOM], label: label(null, 'noise', 'internal_prefix') },

  // noise_collision: a name that is also a word in a codename or a deal.
  'nc-aster': {
    subject: 'Aster Pharma results', from: 'research@marketwire.example', to: DEAL_TEAM,
    body: 'Quarterly results are published on the investor site.', sources: [DEALS], label: label(null, 'noise_collision'),
  },
  'nc-aster-lena': {
    subject: 'Aster Pharma results', from: 'research@marketwire.example', to: [at('lena')],
    body: 'Quarterly results are published on the investor site.', sources: [LENA], label: label(null, 'noise_collision'),
  },
  'nc-garland-street': { subject: 'Garland Street office move', from: at('facilities'), to: DEAL_TEAM, body: 'Boxes go out on Friday.', sources: [DEALS], label: label(null, 'noise_collision') },
  'nc-ca': { subject: 'Fenwick Foods CA plant visit', from: at('ana'), to: DEAL_TEAM, body: 'Travel plans for the site tour are below.', sources: [DEALS], label: label(null, 'noise_collision') },
  'nc-model': { subject: 'Fenwick Foods model refresh', from: at('tom'), to: DEAL_TEAM, body: 'The coverage model has new inputs.', sources: [DEALS], label: label(null, 'noise_collision') },
  // noise_client_mention: a client is written about for another reason, with no deal-process term.
  'ncm-q3': { subject: 'Fenwick Foods Q3 results', from: at('ana'), to: DEAL_TEAM, body: 'Revenue was ahead of plan.', sources: [DEALS], label: label(null, 'noise_client_mention') },
  'ncm-dinner': { subject: 'Fenwick Foods holiday dinner', from: MARCUS, to: DEAL_TEAM, body: 'Save the date for the client dinner.', sources: [DEALS], label: label(null, 'noise_client_mention') },
  // noise_client_coverage_term: coverage mail that carries a deal-process term.
  'ncc-nda': {
    subject: 'Fenwick Foods NDA for conference sponsorship', from: at('ana'), to: DEAL_TEAM,
    body: 'Legal asked for the sponsorship agreement.', sources: [DEALS], label: label(null, 'noise_client_coverage_term'),
  },
  'ncc-lease': {
    subject: 'Garland Health diligence on our lease', from: MARCUS, to: DEAL_TEAM,
    body: 'Facilities need the landlord letter.', sources: [DEALS], label: label(null, 'noise_client_coverage_term'),
  },
};

/**
 * The explicit messages on each page, per source. Page k of every source is emitted in round k, so a message
 * read in two sources must sit on the same page index in both. The rest of each page is ordinary mail.
 */
const PLAN: Record<string, string[][]> = {
  [ANA]: [
    ['aster-cim', 'aster-kickoff'],
    ['briar-root', 'fallow-literal'],
    ['gorse-teacher'],
    ['gorse-mixed'],
    ['heron-carrier', 'heron-mixed'],
  ],
  [TOM]: [['aster-body', 'dunmore-tom-1', 'dunmore-tom-2', 'rn-unent-tom', 'recruiting-1', 'recruiting-2'], []],
  [DEALS]: [
    // teachers
    ['aster-cim', 'bramble-root', 'ember-teacher', 'heron-teacher', 'calder-1', 'calder-2', 'calder-3', 'dunmore-1', 'dunmore-2'],
    // learners
    ['bramble-reply-1', 'bramble-reply-2', 'bramble-reply-gmail', 'bramble-reply-retitled', 'briar-reply', 'ember-bare-subject', 'ember-bare-body', 'fallow-bare'],
    ['rn-full-fenwick', 'rn-full-garland', 'rn-short', 'rn-case', 'rn-body', 'rn-external', 'rn-noterm'],
    ['gorse-mixed', 'doc-fenwick-cim', 'nm-nda', 'nm-team', 'nm-timeline', 'ncm-q3', 'ncm-dinner', 'ncc-nda', 'ncc-lease', 'nc-aster'],
    ['nc-garland-street', 'nc-ca', 'nc-model', 'heron-carrier', 'heron-mixed'],
    [], [], [], [], [], [], [], [], [],
  ],
  [LENA]: [['heron-lena', 'rn-unent-lena-1', 'rn-unent-lena-2', 'townhall-1', 'townhall-2', 'nc-aster-lena'], [], []],
  [ARCHIVE]: [['rn-unapproved-fenwick', 'rn-unapproved-garland']],
};

type Noise = { subject: string; from: string; body: string };
/** Ordinary mail. None of it carries a codename, an alias word or a subject prefix a rule could take. */
const NOISE: Noise[] = [
  { subject: 'Weekly market wrap', from: 'newsletter@marketwire.example', body: 'Equities closed mixed as rates held steady.' },
  { subject: 'Morning headlines from the deal wire', from: 'news@dealwire.example', body: 'Ten stories on sponsor activity and regulatory approvals.' },
  { subject: 'Your DocuSign envelope is ready to sign', from: 'dse@docusign.example', body: 'Please review and sign the attached document.' },
  { subject: 'Data room activity digest', from: 'noreply@dataroom.example', body: 'Three documents were viewed today. No new uploads.' },
  { subject: 'New files uploaded to the virtual data room', from: 'noreply@dataroom.example', body: 'Two files were added to the index.' },
  { subject: 'Accepted: Team sync', from: at('tom'), body: 'Accepted.' },
  { subject: 'Declined: Pipeline review', from: at('lena'), body: 'Declined.' },
  { subject: 'Invitation: quarterly planning offsite', from: at('hr'), body: 'Please confirm your attendance.' },
  { subject: 'Your expense report was approved', from: at('noreply'), body: 'Reimbursement arrives within five business days.' },
  { subject: 'Backup completed on the file server', from: at('noreply'), body: 'The nightly backup finished without errors.' },
  { subject: 'Password expires in 7 days', from: at('notifications'), body: 'Change it from the portal.' },
  { subject: 'Lunch: Thursday order', from: RHEA, body: 'The menu is on the shared drive.' },
  { subject: 'Parking permits renewal', from: at('facilities'), body: 'Renew by the end of the month.' },
  { subject: 'Office closed for the holiday', from: at('hr'), body: 'The office reopens on Monday.' },
  { subject: 'IT maintenance window this weekend', from: at('it'), body: 'Systems will be unavailable for two hours.' },
  { subject: 'New laptop refresh schedule', from: at('it'), body: 'Your slot is listed in the calendar.' },
  { subject: 'Project Management office hours', from: at('pmo'), body: 'Drop in with questions about the template.' },
  { subject: 'Project Timeline template updated', from: at('pmo'), body: 'The new template is on the intranet.' },
  { subject: 'Project Review checklist', from: at('pmo'), body: 'Use the attached checklist before sign-off.' },
  { subject: 'Travel booking confirmation', from: 'noreply@travel.example', body: 'Your itinerary is attached.' },
  { subject: 'Quarterly compliance attestation due', from: at('compliance'), body: 'Complete the attestation by the end of the month.' },
  { subject: 'Benefits enrollment opens Monday', from: at('hr'), body: 'Enrollment closes at the end of the month.' },
  { subject: 'Welcome our new analyst class', from: at('hr'), body: 'Please join us in welcoming the incoming class.' },
  { subject: 'Thanks for the introduction', from: ELLIS, body: 'Great to connect, talk soon.' },
  { subject: 'Out of office until Monday', from: 'assistant@lawfirm.example', body: 'I will reply when I return.' },
  { subject: 'Regulatory update on market structure', from: 'alerts@lawfirm.example', body: 'A summary of this week filings is attached.' },
  { subject: 'Happy hour on Friday', from: ELLIS, body: 'Drinks start at six.' },
  { subject: 'Invoice 4821 for conference registration', from: 'billing@events.example', body: 'Payment is due in thirty days.' },
  { subject: 'Board materials for next week', from: MARCUS, body: 'Draft materials are in the shared folder.' },
  { subject: 'Team offsite agenda', from: RHEA, body: 'Agenda and logistics are attached.' },
];

const SENT_FROM = Date.UTC(2026, 8, 1);

function mailOf(id: string, spec: Spec, seq: number): RecallMessage {
  return {
    id,
    internetMessageId: `<${id}@${DOMAIN}>`,
    conversationId: spec.conv ?? null,
    subject: spec.subject,
    sentDateTime: new Date(SENT_FROM + seq * 3_600_000).toISOString(),
    from: recipient(spec.from),
    toRecipients: (spec.to ?? []).map(recipient),
    ccRecipients: (spec.cc ?? []).map(recipient),
    body: { contentType: 'text', content: spec.body ?? 'Please see the attached for details.' },
    sources: spec.sources,
  };
}

/** The id a message has in labels.json. */
const labelKeyOf = (id: string, spec: Spec | DocSpec) => ('document' in spec ? id : `<${id}@${DOMAIN}>`);

/**
 * Builds the corpus as the three v1 files. The plan is checked as it is read: a page over PAGE_SIZE, or a message
 * not on a page of every source it is read in, is a corpus bug and throws.
 */
export function inRepoCorpusFiles(): RecallCorpusFiles {
  const onPages = new Map<string, string[]>();
  for (const [source, pages] of Object.entries(PLAN)) {
    pages.forEach((page, k) => {
      if (page.length > PAGE_SIZE) throw new Error(`recall corpus: page ${k} of ${source} is over ${PAGE_SIZE}`);
      for (const id of page) {
        const spec = EXPLICIT[id];
        if (!spec) throw new Error(`recall corpus: ${id} is planned but not defined`);
        if (!spec.sources.includes(source)) throw new Error(`recall corpus: ${id} is planned in a source it is not read in`);
        onPages.set(id, [...(onPages.get(id) ?? []), `${source}:${k}`]);
      }
    });
  }
  for (const [id, spec] of Object.entries(EXPLICIT)) {
    const placed = onPages.get(id) ?? [];
    if (placed.length !== spec.sources.length) throw new Error(`recall corpus: ${id} is not planned in every source it is read in`);
    if (new Set(placed.map((p) => p.split(':')[1])).size !== 1) throw new Error(`recall corpus: ${id} sits on different pages`);
  }

  const messages: RecallMessage[] = [];
  const labels: Record<string, RecallLabel> = {};
  const emitted = new Set<string>();
  let noiseCount = 0;
  const rounds = Math.max(...Object.values(PLAN).map((pages) => pages.length));
  for (let round = 0; round < rounds; round += 1) {
    for (const source of SOURCE_ORDER) {
      const page = PLAN[source][round];
      if (!page) continue;
      for (const id of page) {
        if (emitted.has(id)) continue;
        emitted.add(id);
        const spec = EXPLICIT[id];
        labels[labelKeyOf(id, spec)] = spec.label;
        if ('document' in spec) {
          messages.push({ kind: 'document', id, ...spec.document, sources: spec.sources });
        } else {
          messages.push(mailOf(id, spec, messages.length));
        }
      }
      for (let i = page.length; i < PAGE_SIZE; i += 1) {
        const template = NOISE[noiseCount % NOISE.length];
        const id = `noise-${String(noiseCount + 1).padStart(3, '0')}`;
        noiseCount += 1;
        messages.push(mailOf(id, { ...template, to: [WORLD.sources.find((s) => s.id === source)!.address], sources: [source], label: label(null, 'noise') }, messages.length));
        labels[`<${id}@${DOMAIN}>`] = label(null, 'noise');
      }
    }
  }

  return {
    messages: { format: RECALL_FORMAT, messages },
    labels: { format: RECALL_FORMAT, labels },
    world: { format: RECALL_FORMAT, ...WORLD },
  };
}

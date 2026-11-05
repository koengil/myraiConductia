import { describe, expect, it } from 'vitest';

import {
  DEAL_FOLDER_LABELS,
  DEAL_FOLDERS,
  DEFAULT_DEAL_FOLDER,
  MAX_DEAL_FOLDER_DEPTH,
  formatFilingDestination,
  isDealFolder,
  listFilingDestinations,
  parseDealFolder,
  parseDealFolderSubpath,
} from '../src/lib/dataroom/taxonomy';
import {
  countFiles,
  dealFolderScaffold,
  isFolder,
  manifestFor,
  manifestFromDealFolderDocuments,
} from '../src/lib/dataroom/tree';

describe('deal folder taxonomy', () => {
  it('names exactly the eight closed Ignatious folders, in their order', () => {
    expect(DEAL_FOLDERS).toEqual([
      'received-from-client',
      'admin',
      'client-presentations',
      'marketing-materials',
      'buyers',
      'data-room-index',
      'due-diligence',
      'closing',
    ]);
    expect(DEAL_FOLDER_LABELS[DEFAULT_DEAL_FOLDER]).toBe('00. Received from Client');
    expect(DEAL_FOLDER_LABELS.closing).toBe('07. Closing');
  });

  it('rejects anything that is not one of the eight', () => {
    expect(isDealFolder('admin')).toBe(true);
    expect(isDealFolder('source-materials')).toBe(false);
    expect(parseDealFolder('buyers')).toBe('buyers');
    expect(parseDealFolder('md-brief')).toBeNull();
    expect(parseDealFolder('')).toBeNull();
  });

  it('parses a subpath and refuses one deeper than the sample', () => {
    expect(parseDealFolderSubpath(null)).toEqual([]);
    expect(parseDealFolderSubpath('')).toEqual([]);
    expect(parseDealFolderSubpath('["NDA"]')).toEqual(['NDA']);
    expect(parseDealFolderSubpath('05. Process Letter and Bid Summary/01. Process Letter')).toEqual([
      '05. Process Letter and Bid Summary',
      '01. Process Letter',
    ]);
    expect(parseDealFolderSubpath(['a', 'b', 'c', 'd'])).toBeNull();
    expect(MAX_DEAL_FOLDER_DEPTH).toBe(3);
    expect(parseDealFolderSubpath('has/slash')).toEqual(['has', 'slash']);
    expect(parseDealFolderSubpath('["bad/name"]')).toBeNull();
  });
});

describe('deal folder scaffold', () => {
  it('always renders the eight top-level folders, empty ones included', () => {
    const scaffold = dealFolderScaffold();
    expect(scaffold.map((node) => node.name)).toEqual(DEAL_FOLDERS.map((id) => DEAL_FOLDER_LABELS[id]));
    expect(scaffold.every(isFolder)).toBe(true);

    const received = scaffold[0];
    expect(received?.children).toEqual([]);

    const closing = scaffold.find((node) => node.name === '07. Closing');
    expect(closing && isFolder(closing) ? closing.children.map((c) => c.name) : []).toEqual([
      '01. Stock Purchase Agreement',
      '02. Marketing at Closing',
      '03. Invoices',
    ]);

    const buyers = scaffold.find((node) => node.name === '04. Buyers');
    const process =
      buyers && isFolder(buyers)
        ? buyers.children.find((child) => child.name === '05. Process Letter and Bid Summary')
        : undefined;
    expect(process && isFolder(process) ? process.children.map((c) => c.name) : []).toEqual([
      '01. Process Letter',
      '02. LOIs and Term Sheets',
    ]);
    expect(buyers && isFolder(buyers) ? buyers.children.map((c) => c.name) : []).not.toContain(
      '03.',
    );
  });

  it('is what every deal shows, including the sandbox — folders only, no Destiny files', () => {
    for (const dealId of ['a-new-mandate', 'project-summit', 'atlassian']) {
      const manifest = manifestFor(dealId, 'deal-folder');
      expect(manifest.children.map((node) => node.name)).toEqual(
        DEAL_FOLDERS.map((id) => DEAL_FOLDER_LABELS[id]),
      );
      expect(countFiles(manifest.children)).toBe(0);
      expect(manifest.children.some((node) => node.kind === 'file')).toBe(false);
      expect(manifest.root).not.toMatch(/Destiny/i);
      expect(JSON.stringify(manifest)).not.toMatch(/Folder Guide/i);
    }
  });
});

describe('placing documents on the scaffold', () => {
  it('files a document at the named folder and leaves the others empty', () => {
    const manifest = manifestFromDealFolderDocuments([
      {
        name: 'Retainer.docx',
        folder: 'admin',
        subpath: ['Invoice'],
        bytes: 12,
        href: '/api/v1/deals/d1/documents/doc-1/download',
      },
    ]);
    expect(countFiles(manifest.children)).toBe(1);
    const admin = manifest.children.find((node) => node.name === '01. Admin');
    const invoice =
      admin && isFolder(admin) ? admin.children.find((child) => child.name === 'Invoice') : undefined;
    expect(invoice && isFolder(invoice) ? invoice.children.map((c) => c.name) : []).toEqual([
      'Retainer.docx',
    ]);
    const closing = manifest.children.find((node) => node.name === '07. Closing');
    expect(countFiles(closing && isFolder(closing) ? closing.children : [])).toBe(0);
  });

  it('keeps a document reachable when its folder id is unknown — no silent drop', () => {
    const manifest = manifestFromDealFolderDocuments([
      {
        name: 'Notes.md',
        folder: 'source-materials',
        bytes: 4,
        href: '/x',
      },
    ]);
    const received = manifest.children[0];
    expect(received && isFolder(received) ? received.children.map((c) => c.name) : []).toEqual([
      'Notes.md',
    ]);
  });

  it('lists every template destination a banker can file into, and none they can invent at the top', () => {
    const destinations = listFilingDestinations();
    expect(destinations[0]?.label).toBe('00. Received from Client');
    expect(destinations.some((d) => d.label === '01. Admin / NDA')).toBe(true);
    expect(destinations.some((d) => d.label === formatFilingDestination('buyers', ['05. Process Letter and Bid Summary', '01. Process Letter']))).toBe(true);
    expect(destinations.every((d) => isDealFolder(d.folder))).toBe(true);
  });
});

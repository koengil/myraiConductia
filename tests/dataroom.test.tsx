import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import * as React from 'react';

import { DataRoom } from '../src/components/dataroom';
import {
  dataRoomExternalManifest,
  manifestFromDealFolderDocuments,
} from '../src/lib/dataroom/tree';

/*
 * Data Room / Deal Folder — ONE explorer, parameterized by (manifest, kind).
 *
 * Contracts under test:
 *   1. Each kind renders ITS OWN manifest (root name + note).
 *   2. Each kind shows the correct access note — the internal/external boundary
 *      made explicit (Deal Folder = internal work product; Data Room = client
 *      documents, staged buyer access).
 */

afterEach(() => cleanup());

describe('DataRoom — deal-folder kind (internal work product)', () => {
  it('renders the empty Ignatious taxonomy, including folders with nothing in them', () => {
    render(
      <DataRoom manifest={manifestFromDealFolderDocuments([])} kind="deal-folder" />,
    );

    expect(screen.getByText('00. Received from Client')).toBeInTheDocument();
    expect(screen.getByText('07. Closing')).toBeInTheDocument();
    expect(screen.getByText('0 documents')).toBeInTheDocument();
  });

  it('renders the internal-only access note over the empty taxonomy', () => {
    const manifest = manifestFromDealFolderDocuments([]);
    render(<DataRoom manifest={manifest} kind="deal-folder" />);

    expect(screen.getByRole('heading', { name: manifest.root })).toBeInTheDocument();
    // No header note: the access line below says it is internal work product.
    expect(
      screen.queryByText(/Our internal work product for this deal/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Folder Guide/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Destiny/i)).not.toBeInTheDocument();

    expect(screen.getByText('Deal folder')).toBeInTheDocument();
    expect(
      screen.getByText('Internal work product. No outside party can see this.'),
    ).toBeInTheDocument();
  });
});

describe('DataRoom — data-room kind (client documents)', () => {
  it('renders the external manifest and the staged-buyer-access note', () => {
    render(<DataRoom manifest={dataRoomExternalManifest} kind="data-room" />);

    expect(
      screen.getByRole('heading', { name: dataRoomExternalManifest.root }),
    ).toBeInTheDocument();
    expect(screen.getByText(dataRoomExternalManifest.note)).toBeInTheDocument();

    expect(screen.getByText('Data room')).toBeInTheDocument();
    expect(
      screen.getByText('Client documents. Staged buyer access.'),
    ).toBeInTheDocument();
  });

  it('the two kinds render DISTINCT roots (not the same hardcoded folder)', () => {
    expect(manifestFromDealFolderDocuments([]).root).not.toBe(dataRoomExternalManifest.root);
  });
});

describe('DataRoom layout', () => {
  const withFiles = (preview?: string) =>
    manifestFromDealFolderDocuments([
      { name: 'Buyer NDA.docx', folder: 'admin', subpath: ['NDA'], bytes: 2048, href: '/x/download', preview },
    ]);

  it('opens with the list at full width and no preview pane or selected document', () => {
    render(<DataRoom manifest={withFiles()} kind="deal-folder" />);
    expect(screen.getByRole('complementary', { name: 'Folder tree' }).className).toContain('w-full');
    expect(screen.queryByRole('region', { name: 'Document preview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Selected document' })).not.toBeInTheDocument();
    expect(screen.queryByText('Select a document to preview.')).not.toBeInTheDocument();
  });

  it('colours each of the eight folders with its own dot', () => {
    render(<DataRoom manifest={manifestFromDealFolderDocuments([])} kind="deal-folder" />);
    expect(document.querySelectorAll('[data-category-dot]')).toHaveLength(8);
  });

  it('a file that cannot preview gets a clear Download bar and keeps the list full width', () => {
    render(<DataRoom manifest={withFiles()} kind="deal-folder" />);
    fireEvent.click(screen.getByRole('button', { name: /01\. Admin/ }));
    fireEvent.click(screen.getByRole('button', { name: /^NDA/ }));
    fireEvent.click(screen.getByRole('button', { name: /Buyer NDA\.docx/ }));
    const bar = screen.getByRole('region', { name: 'Selected document' });
    expect(within(bar).getByRole('link', { name: 'Download DOCX' })).toHaveAttribute('href', '/x/download');
    expect(screen.queryByRole('region', { name: 'Document preview' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Folder tree' }).className).toContain('w-full');
    fireEvent.click(screen.getByRole('button', { name: 'Close selected document' }));
    expect(screen.queryByRole('region', { name: 'Selected document' })).not.toBeInTheDocument();
  });

  it('a file that can preview opens the preview pane beside a narrower list', () => {
    render(<DataRoom manifest={withFiles('/data-room-previews/nda.html')} kind="deal-folder" />);
    fireEvent.click(screen.getByRole('button', { name: /01\. Admin/ }));
    fireEvent.click(screen.getByRole('button', { name: /^NDA/ }));
    fireEvent.click(screen.getByRole('button', { name: /Buyer NDA\.docx/ }));
    expect(screen.getByTitle('Preview of Buyer NDA.docx')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Folder tree' }).className).toContain('md:w-[320px]');
  });

  it('keeps the download bar sticky and returns focus to the row on close', () => {
    render(<DataRoom manifest={withFiles()} kind="deal-folder" />);
    fireEvent.click(screen.getByRole('button', { name: /01\. Admin/ }));
    fireEvent.click(screen.getByRole('button', { name: /^NDA/ }));
    const row = screen.getByRole('button', { name: /Buyer NDA\.docx/ });
    fireEvent.click(row);
    expect(screen.getByRole('region', { name: 'Selected document' }).className).toContain('sticky');
    fireEvent.click(screen.getByRole('button', { name: 'Close selected document' }));
    expect(row).toHaveFocus();
  });
});

// A record-only file never reads "0 B"; 01 and 07 never share a grey.
describe('DataRoom sizes and folder tints', () => {
  it('a file with no size reads "Not shown", never "0 B"', () => {
    const manifest = manifestFromDealFolderDocuments([
      { name: 'Record.pdf', folder: 'admin', subpath: [], bytes: 0, href: '/x/download' },
    ]);
    const { container } = render(<DataRoom manifest={manifest} kind="deal-folder" />);
    fireEvent.click(screen.getByRole('button', { name: /01\. Admin/ }));
    fireEvent.click(screen.getByRole('button', { name: /Record\.pdf/ }));
    const bar = screen.getByRole('region', { name: 'Selected document' });
    expect(bar).toHaveTextContent('Not shown');
    expect(container.textContent).not.toContain('0 B');
  });
});

// No role="tree" without the tree keyboard model; folders are
// disclosure buttons in plain lists.
describe('DataRoom folder list semantics', () => {
  it('has no tree, treeitem or group roles; folders expand as buttons', () => {
    render(<DataRoom manifest={manifestFromDealFolderDocuments([])} kind="deal-folder" />);
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
    const nav = screen.getByRole('navigation', { name: 'Data room folders' });
    expect(nav.querySelector('[role="group"]')).toBeNull();
    const admin = screen.getByRole('button', { name: /01\. Admin/ });
    expect(admin).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(admin);
    expect(admin).toHaveAttribute('aria-expanded', 'true');
  });

  it('marks the open file as current', () => {
    const manifest = manifestFromDealFolderDocuments([
      { name: 'Buyer NDA.docx', folder: 'admin', subpath: [], bytes: 2048, href: '/x/download' },
    ]);
    render(<DataRoom manifest={manifest} kind="deal-folder" />);
    fireEvent.click(screen.getByRole('button', { name: /01\. Admin/ }));
    const file = screen.getByRole('button', { name: /Buyer NDA\.docx/ });
    fireEvent.click(file);
    expect(file).toHaveAttribute('aria-current', 'true');
  });
});

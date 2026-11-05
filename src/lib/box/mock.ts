/**
 * In-memory Box stand-in for local dev when BOX_* env vars are unset.
 * Folder and file ids are deterministic so re-provisioning is idempotent
 * within a process.
 */

import type { BoxClient, BoxFile, BoxFolder } from './types';

type StoredFile = BoxFile & { folderId: string; content: Buffer };

function slugId(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return `mock-box-${hash.toString(16).padStart(8, '0')}`;
}

export function createMockBoxClient(): BoxClient {
  const folders = new Map<string, BoxFolder>();
  const files: StoredFile[] = [];

  return {
    async createFolder(name, parentFolderId) {
      const id = slugId(`${parentFolderId}:${name}`);
      const folder: BoxFolder = {
        id,
        name,
        url: `https://app.box.com/folder/${id}`,
      };
      folders.set(id, folder);
      return folder;
    },

    async listFolderItems(folderId) {
      return files
        .filter((f) => f.folderId === folderId)
        .map(({ id, name, size, createdAt, url }) => ({
          id,
          name,
          size,
          createdAt,
          url,
        }));
    },

    async uploadFile(folderId, fileName, content) {
      const id = slugId(`${folderId}:${fileName}:${content.length}`);
      const file: StoredFile = {
        id,
        name: fileName,
        size: content.length,
        createdAt: new Date().toISOString(),
        url: `https://app.box.com/file/${id}`,
        folderId,
        content,
      };
      const existingIdx = files.findIndex(
        (f) => f.folderId === folderId && f.name === fileName,
      );
      if (existingIdx >= 0) {
        files[existingIdx] = file;
      } else {
        files.push(file);
      }
      const { folderId: _folderId, content: _content, ...publicFile } = file;
      void _folderId;
      void _content;
      return publicFile;
    },

    async deleteFile(fileId) {
      const idx = files.findIndex((f) => f.id === fileId);
      if (idx >= 0) files.splice(idx, 1);
    },
  };
}

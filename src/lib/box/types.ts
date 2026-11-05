export type BoxFolder = {
  id: string;
  name: string;
  url: string;
};

export type BoxFile = {
  id: string;
  name: string;
  size: number;
  createdAt: string;
  url: string;
};

export type BoxClient = {
  createFolder(name: string, parentFolderId: string): Promise<BoxFolder>;
  listFolderItems(folderId: string): Promise<BoxFile[]>;
  uploadFile(
    folderId: string,
    fileName: string,
    content: Buffer,
  ): Promise<BoxFile>;
  deleteFile(fileId: string): Promise<void>;
};

export type BoxConfig = {
  clientId: string;
  clientSecret: string;
  enterpriseId: string;
};

export function isBoxConfigured(): boolean {
  // Lazy-import would split modules; duplicate the secret read here.
  const clientSecret =
    process.env.BOX_SECRET?.trim() || process.env.BOX_CLIENT_SECRET?.trim();
  return Boolean(
    process.env.BOX_CLIENT_ID && clientSecret && process.env.BOX_ENTERPRISE_ID,
  );
}

export function getBoxConfig(): BoxConfig | null {
  const clientId = process.env.BOX_CLIENT_ID?.trim();
  const clientSecret =
    process.env.BOX_SECRET?.trim() || process.env.BOX_CLIENT_SECRET?.trim();
  const enterpriseId = process.env.BOX_ENTERPRISE_ID?.trim();
  if (!clientId || !clientSecret || !enterpriseId) {
    return null;
  }
  return { clientId, clientSecret, enterpriseId };
}

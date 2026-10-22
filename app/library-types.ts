export type Picture = {
  id: string;
  publicId: string;
  name: string;
  plu: string;
  sector: string;
  filename: string;
  bytes: number;
  cleaned: boolean;
  generated?: boolean;
  createdAt: string;
  url: string;
};

export type BulkWorkbookRow = { sheetName: string; rowNumber: number };

export type BulkProduct = {
  id: string;
  plu: string;
  name: string;
  canGenerate: boolean;
  description: string;
  rows: BulkWorkbookRow[];
};

export type BulkAnalysis = {
  products: BulkProduct[];
  sheets: string[];
  ignoredBlankPluRows: number;
  preservedUrlRows: number;
  matchedWorkbookRows: number;
};

export type BulkAssignment = { productId: string; url: string };

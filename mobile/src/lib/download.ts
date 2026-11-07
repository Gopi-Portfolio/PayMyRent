// Download a report or statement from the server and open the phone's share sheet (Save to Files, WhatsApp, Mail, Drive...).
// A plain browser link carries no sign-in token and the server answers 401, so the file is fetched here WITH the token.
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import i18n from '@/i18n';
import { API_URL, ApiError } from './api';
import { getIdToken } from './auth';

export type FileFormat = 'xlsx' | 'pdf' | 'csv';
const MIME: Record<FileFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  csv: 'text/csv',
};
const UTI: Record<FileFormat, string> = { xlsx: 'org.openxmlformats.spreadsheetml.sheet', pdf: 'com.adobe.pdf', csv: 'public.comma-separated-values-text' };

/** `path` already holds its query string, e.g. `/api/v1/tenancies/<id>/statement?`; the format is added here. */
export async function downloadReport(path: string, format: FileFormat, fileName: string, ownerAccount?: string | null): Promise<void> {
  const token = await getIdToken();
  const headers: Record<string, string> = { Accept: MIME[format], 'X-App-Language': i18n.language };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ownerAccount) headers['X-Owner-Account'] = ownerAccount;
  const url = `${API_URL}${path}${path.includes('?') ? '&' : '?'}format=${format}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);          // building a PDF takes a few seconds
  let res: Response;
  try { res = await fetch(url, { headers, signal: ctl.signal }); }
  catch { throw new ApiError(0, 'OFFLINE', `Cannot reach the server at ${API_URL}. Check your internet connection and try again.`); }
  finally { clearTimeout(timer); }
  if (!res.ok) {
    let e: any = {};
    try { e = (await res.json())?.error ?? {}; } catch { /* not JSON */ }
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? res.statusText);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const file = new File(Paths.cache, `${fileName}.${format}`);
  file.create({ overwrite: true });
  file.write(bytes);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(file.uri, { mimeType: MIME[format], UTI: UTI[format], dialogTitle: fileName });
}

import { ApiError, isRetryable, NetworkError } from '@/api/errors';
import type { CompanyProfileIn, DealStatus, DocumentOut, JsonPatchOp, KpDataOut, KpFullOut, KpItemOut, KpVatMode, PriceItemOut } from '@/api/types';
import { companyProfileOut, kpFullOut } from '@/api/endpoints';
import { getOutbox, getRecords, type OutboxEntry } from '@/db';
import type { OutboxKind } from '@/db/outbox';
import i18n from '@/i18n';
import { getApi, getFiles, getSyncEngine, kickSync, notifyDataChanged, syncBlocked } from '@/services';
import { useConnectivity } from '@/store/connectivity';
import { useOnboarding } from '@/store/onboarding';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import { newId } from '@/utils/id';

import { priceText, qtyText } from './calc';
import { getSharePort } from './share';
import {
  kpState,
  LOCAL_PRICE,
  shownData,
  reviewKey,
  shownProfile,
  type KpJob,
  type ProfileFields,
  type ProfileImageRole,
} from './store';

/**
 * Week 14 (3-engineering 4.7, 6.7; 2-design S16–S19, S28). Every change by hand — a profile field,
 * a logo, a price in «Мой прайс», a price or a quantity in a КП, a step of the status bar — is
 * shown at once, offline and in «Без ИИ» too, and goes through the outbox in tap order. Each has
 * «Отменить»: still waiting → its row is dropped, nothing goes; already sent → the old values go
 * as a new change (for a КП that is a new version, like the server's «Вернуть»).
 * Reading a spec (KP_EXTRACT) and the PDF are the server's: offline the person is told so.
 */

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);
const nowIso = () => new Date().toISOString();
const canSend = () => useOnboarding.getState().consent !== null;
/** «Согласен» (not «Без ИИ»): reading a spec uses the model. */
export const assistantOn = () => useOnboarding.getState().consent?.mode === 'full';
const kick = () => {
  if (!syncBlocked()) kickSync();
};
const set = kpState().set;
const st = () => kpState();

async function enqueue(kind: OutboxKind, payload: unknown): Promise<string | null> {
  if (!canSend()) return null; // nothing to send to: the change lives on the phone
  const row = await (await getOutbox()).enqueue(kind, payload);
  kick();
  return row.id;
}

/** «Отменить» of an outbox row: still waiting → dropped (true); else false and the caller sends the old values. */
async function dropIfWaiting(rowId: string | null): Promise<boolean> {
  if (!rowId) return true;
  const engine = await getSyncEngine();
  await engine.hold(rowId);
  try {
    const row = await (await getOutbox()).get(rowId);
    if (row && row.status === 'pending') {
      await (await getOutbox()).markFailed(row.id, 'undone');
      return true;
    }
    return false;
  } finally {
    engine.release(rowId);
  }
}

function strip(text: string, onUndo: () => void): void {
  useUndo.getState().showCustom(text, onUndo);
}

// --- the company profile (S19) ---

/** `verify`: «Верно» on these fields (phone keys). */
export type ProfilePayload = { clientId: string; fields: Partial<ProfileFields>; verify?: string[] };

function overlayProfile(fields: Partial<ProfileFields>, clientId: string, verify: string[] = []): void {
  const prev = st().profileEdit;
  set({
    profileEdit: {
      fields: { ...prev?.fields, ...fields },
      verified: [...new Set([...(prev?.verified ?? []), ...verify.map(reviewKey)])],
      clientId,
    },
  });
}

/** A field typed on S19 (one field = one change, «Отменить» puts the old text back). */
export async function editProfile(fields: Partial<ProfileFields>, stripText = t('kp.profile_saved')): Promise<void> {
  const now = shownProfile(st());
  const before: Partial<ProfileFields> = {};
  for (const k of Object.keys(fields) as (keyof ProfileFields)[]) (before as Record<string, unknown>)[k] = now[k];
  if (JSON.stringify(before) === JSON.stringify(fields)) return;
  const clientId = newId();
  overlayProfile(fields, clientId);
  const rowId = await enqueue('kp.profile', { clientId, fields } satisfies ProfilePayload);
  strip(stripText, () =>
    void (async () => {
      const back = newId();
      overlayProfile(before, back);
      if (!(await dropIfWaiting(rowId))) await enqueue('kp.profile', { clientId: back, fields: before } satisfies ProfilePayload);
    })(),
  );
}

/** «Верно» on a number read from a photo (R-36: only «Верно» takes «проверьте» off). */
export async function verifyProfileField(key: string): Promise<void> {
  const clientId = newId();
  overlayProfile({}, clientId, [key]);
  await enqueue('kp.profile', { clientId, fields: {}, verify: [key] } satisfies ProfilePayload);
}

const BANK = { iban: 'iban', bik: 'bik', bank_name: 'bank', kbe: 'kbe' } as const;
const CONTACTS = { phone: 'phone', email: 'email' } as const;

/**
 * The server replaces `bank` and `contacts` whole (kp/profile.py `clean_change`): a change of one
 * of their fields sends the whole object as the phone shows it.
 */
function profileBody(p: ProfilePayload): CompanyProfileIn {
  const f = p.fields;
  const shown = shownProfile(st());
  const body: CompanyProfileIn = { client_id: p.clientId };
  const v = st().profile?.version;
  if (v) body.base_version = v;
  for (const k of ['name', 'legal_form', 'bin_iin', 'address', 'vat_payer'] as const) {
    if (k in f) (body as Record<string, unknown>)[k] = f[k] ?? null;
  }
  if (Object.keys(BANK).some((k) => k in f)) {
    const bank: Record<string, string | null> = {};
    for (const [mine, theirs] of Object.entries(BANK)) bank[theirs] = (k(f, mine) ?? shown[mine as keyof typeof BANK]) || null;
    body.bank = bank;
  }
  if (Object.keys(CONTACTS).some((k) => k in f)) {
    const c: Record<string, string | null> = { website: st().profile?.contacts.website ?? null };
    for (const [mine, theirs] of Object.entries(CONTACTS)) c[theirs] = (k(f, mine) ?? shown[mine as keyof typeof CONTACTS]) || null;
    body.contacts = c;
  }
  if (p.verify?.length) {
    const off = new Set(p.verify.map(reviewKey));
    body.review_fields = (st().profile?.review_fields ?? []).filter((x) => !off.has(x));
  }
  return body;
}
const k = (f: Partial<ProfileFields>, key: string): string | null | undefined =>
  key in f ? ((f as Record<string, string | null>)[key] ?? null) : undefined;

async function sendProfile(e: OutboxEntry): Promise<void> {
  const p = e.payload as ProfilePayload;
  let out;
  try {
    out = await getApi().putCompanyProfile(profileBody(p));
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      // Changed on another phone: the person's typing still wins, once, on the newest version.
      const fresh = (err.details as { profile?: unknown } | null)?.profile;
      set({ profile: fresh ? companyProfileOut(fresh) : await getApi().companyProfile() });
      out = await getApi().putCompanyProfile(profileBody(p));
    } else {
      if (!isRetryable(err)) {
        if (st().profileEdit?.clientId === p.clientId) set({ profileEdit: null });
        // A БИН / IBAN code could not accept: the person sees the old value and why.
        useToast.getState().show(err instanceof ApiError && err.messageRu ? (i18n.language === 'kk' && err.messageKk) || err.messageRu : t('kp.profile_refused'), 5000);
      }
      throw err;
    }
  }
  set({ profile: out.profile, ...(st().profileEdit?.clientId === p.clientId ? { profileEdit: null } : {}) });
}

export type ImagePayload = { clientId: string; putId: string; role: ProfileImageRole; uri: string | null; mime: string };

const ROLE: Record<ProfileImageRole, 'company_logo' | 'signature' | 'stamp'> = { logo: 'company_logo', signature: 'signature', stamp: 'stamp' };

/** Logo, signature, stamp: shown at once, kept on the phone, uploaded with their role (always kept, R-34). */
export async function setProfileImage(role: ProfileImageRole, picked: { uri: string; mime: string; name: string } | null): Promise<void> {
  const before = st().images[role] ?? null;
  const clientId = newId();
  const uri = picked ? await getFiles().persist(picked.uri, `${role}-${clientId}-${picked.name}`.replace(/[^\w.-]+/g, '_')) : null;
  const put = (img: { uri: string; mime: string } | null, state: 'waiting' | 'sent' = 'waiting') => {
    const images = { ...st().images };
    if (img) images[role] = { ...img, state };
    else delete images[role];
    set({ images });
  };
  put(uri ? { uri, mime: picked!.mime } : null);
  const payload: ImagePayload = { clientId, putId: newId(), role, uri, mime: picked?.mime ?? 'image/jpeg' };
  const rowId = await enqueue('kp.image', payload);
  strip(t(`kp.image_saved_${role}`), () =>
    void (async () => {
      put(before, before?.state ?? 'waiting');
      if (await dropIfWaiting(rowId)) return;
      await enqueue('kp.image', { clientId: newId(), putId: newId(), role, uri: before?.uri ?? null, mime: before?.mime ?? 'image/jpeg' } satisfies ImagePayload);
    })(),
  );
}

async function sendImage(e: OutboxEntry): Promise<void> {
  const p = e.payload as ImagePayload;
  const api = getApi();
  let fileId: string | null = null;
  if (p.uri) {
    const files = getFiles();
    fileId = await api.uploadFileId({ clientId: p.clientId, uri: p.uri, mime: p.mime, bytes: await files.size(p.uri), sha256: await files.sha256(p.uri), role: ROLE[p.role] });
  }
  const out = await api.putCompanyProfile({ client_id: p.putId, [`${p.role}_file_id`]: fileId });
  set({ profile: out.profile });
  const img = st().images[p.role];
  if (img && img.uri === p.uri) set({ images: { ...st().images, [p.role]: { ...img, state: 'sent' } } });
}

export async function refreshProfile(): Promise<void> {
  if (!canSend() || syncBlocked()) return;
  try {
    const profile = await getApi().companyProfile();
    set({ profile });
  } catch {
    // offline: the phone's copy stays
  }
}

// --- «Мой прайс» (S28) ---

export type NewPrice = { name: string; unit?: string | null; price: string };
/** `keys`: the local keys of the rows, in order (the answer's items come in the same order). */
export type PricesPayload = { clientId: string; keys: string[]; items: { name: string; unit: string | null; price: string }[]; source: 'typed_sequence' | 'voice' };
export type PricePatchPayload = { key: string; clientId: string; fields: Partial<Pick<PriceItemOut, 'price' | 'name' | 'unit'>>; verify?: boolean };
export type PriceDeletePayload = { key: string; clientId: string };

export const resolvePrice = (key: string) => st().priceAliases[key] ?? key;

function putPrice(key: string, p: PriceItemOut | null): void {
  const prices = { ...st().prices };
  if (p) prices[key] = p;
  else delete prices[key];
  set({ prices });
  notifyDataChanged();
}

/** Prices typed (S28, «Сохранить в прайс ☑»): in the list at once; returns their keys. */
export async function addPrices(list: NewPrice[], o: { source?: 'typed_sequence' | 'voice'; strip?: boolean } = {}): Promise<string[]> {
  const items = list
    .map((x) => ({ name: x.name.trim(), unit: x.unit?.trim() || null, price: priceText(x.price) }))
    .filter((x): x is { name: string; unit: string | null; price: string } => !!x.name && x.price !== null);
  if (items.length === 0) return [];
  const at = nowIso();
  const prices = { ...st().prices };
  const keys: string[] = [];
  for (const x of items) {
    // A name already in the list gets the new price (the server does the same, `add_typed`).
    const same = findPrice(x.name);
    const key = same?.id ?? `${LOCAL_PRICE}${newId()}`;
    keys.push(key);
    prices[key] = same
      ? { ...same, price: x.price, review: false, updated_at: at }
      : { id: key, client_id: null, price_list_id: null, name: x.name, unit: x.unit, price: x.price, currency: 'KZT', review: false, source_ref: null, updated_at: at, deleted_at: null };
  }
  const before = keys.map((key) => st().prices[key] ?? null);
  set({ prices });
  notifyDataChanged();
  const rowId = await enqueue('kp.prices', { clientId: newId(), keys, items, source: o.source ?? 'typed_sequence' } satisfies PricesPayload);
  if (o.strip !== false) {
    strip(t('kp.prices_added', { count: items.length }), () =>
      void (async () => {
        if (await dropIfWaiting(rowId)) {
          keys.forEach((key, i) => putPrice(key, before[i] ?? null));
          return;
        }
        for (const [i, key] of keys.entries()) {
          const was = before[i];
          if (was) await changePrice(key, { price: was.price }, { strip: false });
          else await removePrice(key, { strip: false });
        }
      })(),
    );
  }
  return keys;
}

/** A price changed by hand (or «Верно» on a price read from a file). */
export async function changePrice(
  key: string,
  fields: Partial<Pick<PriceItemOut, 'price' | 'name' | 'unit'>>,
  o: { verify?: boolean; strip?: boolean } = {},
): Promise<void> {
  const k = resolvePrice(key);
  const now = st().prices[k];
  if (!now) return;
  const next = { ...fields, ...(fields.price ? { price: priceText(fields.price) ?? now.price } : {}) };
  const before: Partial<PriceItemOut> = {};
  for (const f of Object.keys(next) as (keyof typeof next)[]) (before as Record<string, unknown>)[f] = now[f];
  putPrice(k, { ...now, ...next, review: o.verify || 'price' in next ? false : now.review });
  const rowId = await enqueue('kp.price', { key: k, clientId: newId(), fields: next, ...(o.verify ? { verify: true } : {}) } satisfies PricePatchPayload);
  if (o.strip === false) return;
  strip(o.verify ? t('kp.price_verified') : t('kp.price_changed', { name: now.name }), () =>
    void (async () => {
      const cur = st().prices[resolvePrice(k)];
      if (cur) putPrice(resolvePrice(k), { ...cur, ...before, review: now.review });
      if (!(await dropIfWaiting(rowId))) await enqueue('kp.price', { key: k, clientId: newId(), fields: before } satisfies PricePatchPayload);
    })(),
  );
}

export async function removePrice(key: string, o: { strip?: boolean } = {}): Promise<void> {
  const k = resolvePrice(key);
  const now = st().prices[k];
  if (!now || now.deleted_at) return;
  putPrice(k, { ...now, deleted_at: nowIso() });
  const rowId = await enqueue('kp.price_delete', { key: k, clientId: newId() } satisfies PriceDeletePayload);
  if (o.strip === false) return;
  strip(t('kp.price_removed', { name: now.name }), () =>
    void (async () => {
      if (await dropIfWaiting(rowId)) {
        const cur = st().prices[resolvePrice(k)];
        if (cur) putPrice(resolvePrice(k), { ...cur, deleted_at: null });
        return;
      }
      putPrice(resolvePrice(k), null);
      await addPrices([{ name: now.name, unit: now.unit, price: now.price }], { strip: false });
    })(),
  );
}

const serverPrice = (key: string): string | null => {
  const k = resolvePrice(key);
  return k.startsWith(LOCAL_PRICE) ? null : k;
};

async function sendPrices(e: OutboxEntry): Promise<void> {
  const p = e.payload as PricesPayload;
  const out = await getApi().addPriceItems({ client_id: p.clientId, items: p.items, source: p.source });
  const prices = { ...st().prices };
  const aliases = { ...st().priceAliases };
  out.items.forEach((it, i) => {
    const local = p.keys[i];
    const shown = local ? prices[resolvePrice(local)] : undefined;
    if (local && local.startsWith(LOCAL_PRICE)) {
      aliases[local] = it.id;
      delete prices[local];
    }
    // A change typed before the answer (removed meanwhile) stays on top until its own row goes.
    prices[it.id] = shown?.deleted_at ? { ...it, deleted_at: shown.deleted_at } : it;
  });
  set({ prices, priceAliases: aliases });
  notifyDataChanged();
}

async function sendPrice(e: OutboxEntry): Promise<void> {
  const p = e.payload as PricePatchPayload;
  const id = serverPrice(p.key);
  if (!id) return;
  const out = await getApi().patchPriceItem(id, { client_id: p.clientId, ...p.fields, ...(p.verify ? { checked: true } : {}) });
  if (out.item) putPrice(id, { ...out.item, deleted_at: st().prices[id]?.deleted_at ?? null });
}

async function sendPriceDelete(e: OutboxEntry): Promise<void> {
  const p = e.payload as PriceDeletePayload;
  const id = serverPrice(p.key);
  if (!id) return;
  try {
    await getApi().deletePriceItem(id, p.clientId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return;
    throw err;
  }
}

/** «Мой прайс» and «Из прошлых КП» from the server (all pages of 200). */
export async function refreshPrices(): Promise<void> {
  if (!canSend() || syncBlocked()) return;
  try {
    const api = getApi();
    const all: PriceItemOut[] = [];
    let offset: number | null = 0;
    for (let page = 0; offset !== null && page < 25; page++) {
      const r = await api.priceItems({ offset, limit: 200 });
      all.push(...r.items);
      offset = r.next_offset;
    }
    replacePrices(all);
    set({ pastPrices: await api.pastPrices(), pricesUpdatedAt: nowIso() });
  } catch {
    // offline: the phone's copy stays
  }
}

/** The whole list from the server; what the person changed and has not sent yet stays on top. */
async function replacePrices(list: readonly PriceItemOut[]): Promise<void> {
  const outbox = await getOutbox();
  const waiting = new Set(
    (await outbox.listPending(500)).flatMap((r) =>
      r.kind === 'kp.price' || r.kind === 'kp.price_delete' ? [(r.payload as PricePatchPayload).key] : r.kind === 'kp.prices' ? (r.payload as PricesPayload).keys : [],
    ),
  );
  const prices: Record<string, PriceItemOut> = {};
  for (const [key, p] of Object.entries(st().prices)) if (waiting.has(key) || key.startsWith(LOCAL_PRICE)) prices[key] = p;
  for (const it of list) if (!prices[it.id]) prices[it.id] = it;
  set({ prices });
  notifyDataChanged();
}

/** Prices from /sync: a change by hand still waiting stays on top (its row is in the outbox). */
export function applyPrices(list: readonly PriceItemOut[]): void {
  if (list.length === 0) return;
  const prices = { ...st().prices };
  for (const it of list) prices[it.id] = it;
  set({ prices });
  notifyDataChanged();
}

/** The price list's own entry for a name (a price typed for a КП line is also offered for the list). */
export function findPrice(name: string): PriceItemOut | null {
  const n = name.trim().toLowerCase();
  return Object.values(st().prices).find((p) => !p.deleted_at && p.name.trim().toLowerCase() === n) ?? null;
}

// --- a КП from a spec (S16): the records first, then the server reads them ---

/** The spec (photo, PDF, text or voice) is saved as records; the КП is asked for once they are on the server. */
export function startKp(recordIds: string[]): KpJob {
  const job: KpJob = { id: newId(), recordIds, state: 'waiting', documentId: null, message: null, createdAt: nowIso() };
  set({ jobs: { ...st().jobs, [job.id]: job } });
  kick();
  void pumpJobs();
  return job;
}

function putJob(job: KpJob): void {
  set({ jobs: { ...st().jobs, [job.id]: job } });
}

export function dropJob(id: string): void {
  const jobs = { ...st().jobs };
  delete jobs[id];
  set({ jobs });
}

/** A row of the card file (an answer, /sync): newer `seq` wins. */
export function putDocument(doc: DocumentOut): void {
  const prev = st().docs[doc.id];
  if (prev && doc.seq > 0 && prev.seq > doc.seq) return;
  const docs = { ...st().docs, [doc.id]: doc };
  // A version the phone holds that is no longer current goes; the screen asks for the new one.
  const versions = { ...st().versions };
  if (versions[doc.id] && doc.current_version_n !== null && versions[doc.id]!.n !== doc.current_version_n) delete versions[doc.id];
  set({ docs, versions });
  notifyDataChanged();
}

/** The row with its current version (GET /documents/{id}, the answers of POST /documents/kp and /patch). */
export function putFull(out: KpFullOut): void {
  putDocument(out.document);
  const versions = { ...st().versions };
  if (out.version) versions[out.document.id] = out.version;
  set({ versions, needsProfile: out.needs_profile });
  notifyDataChanged();
}

let pumping: Promise<void> | null = null;

/** Drives the jobs: records on the server → POST /documents/kp → GET until KP_EXTRACT is done. */
export function pumpJobs(): Promise<void> {
  if (!pumping) {
    pumping = pumpOnce().finally(() => {
      pumping = null;
    });
  }
  return pumping;
}

const errorText = (e: unknown) =>
  e instanceof ApiError ? (i18n.language === 'kk' && e.messageKk ? e.messageKk : e.messageRu) || t(`kp.err_${e.code}`, { defaultValue: '' }) || null : null;

/** The words of a failed reading: the server's `progress.message`, else its `error` code in plain words. */
function docMessage(doc: DocumentOut): string | null {
  if (doc.status !== 'failed' && !doc.progress?.partial) return null;
  return doc.progress?.message || (doc.error ? t(`kp.err_${doc.error}`, { defaultValue: '' }) : '') || null;
}

function jobState(doc: DocumentOut): KpJob['state'] {
  return doc.status === 'extracting' ? 'reading' : doc.status === 'failed' ? 'failed' : 'done';
}

async function pumpOnce(): Promise<void> {
  if (!canSend() || syncBlocked()) return;
  const records = await getRecords();
  for (const job of Object.values(st().jobs)) {
    if (job.state === 'done' || job.state === 'failed') continue;
    try {
      if (job.state === 'waiting') {
        const ids: string[] = [];
        for (const r of job.recordIds) {
          const rec = await records.get(r);
          if (rec?.serverId) ids.push(rec.serverId);
        }
        if (ids.length < job.recordIds.length) continue; // still uploading («Ждёт связи»)
        const out = await getApi().createKp({ client_id: job.id, item_ids: ids });
        putFull(out);
        putJob({ ...job, documentId: out.document.id, state: jobState(out.document), message: docMessage(out.document) });
        continue;
      }
      if (job.state === 'reading' && job.documentId) {
        const out = await getApi().getDocument(job.documentId);
        putFull(out);
        if (out.document.status !== 'extracting') putJob({ ...job, state: jobState(out.document), message: docMessage(out.document) });
      }
    } catch (e) {
      // The record is still being read (OCR, speech): the same call again in a moment.
      if (e instanceof NetworkError || isRetryable(e) || (e instanceof ApiError && e.code === 'kp_source_not_ready')) continue;
      putJob({ ...job, state: 'failed', message: errorText(e) });
    }
  }
}

export async function refreshDocument(id: string): Promise<void> {
  if (!canSend() || syncBlocked()) return;
  try {
    putFull(await getApi().getDocument(id));
  } catch {
    // offline: the phone's copy stays
  }
}

export async function refreshDocuments(): Promise<void> {
  if (!canSend() || syncBlocked()) return;
  try {
    for (const doc of await getApi().documents()) putDocument(doc);
  } catch {
    // offline
  }
}

// --- tap-edits of a КП (S17, «Ввести цены подряд»): price, quantity, discount, VAT mode ---

/** Lines are named by id (kp/patch.py: what the phone saw is what changes, even if lines moved). */
export type KpChange =
  | { item: string; field: 'unit_price' | 'qty' | 'discount_pct'; value: string | null }
  | { field: 'vat_mode'; value: KpVatMode }
  | { field: 'discount_total_pct'; value: string };

export type KpPatchPayload = { docId: string; clientId: string; ops: JsonPatchOp[]; savePrices?: boolean };

const pathOf = (c: KpChange) => ('item' in c ? `/items/${c.item}/${c.field}` : c.field === 'vat_mode' ? '/vat/mode' : '/discount_total_pct');

/** One change on the data as shown, by code (no model). A price typed by hand is `manual`, and its «проверьте» goes. */
export function applyChange(data: KpDataOut, c: KpChange): KpDataOut {
  if ('item' in c) {
    const items = data.items.map((it): KpItemOut => {
      if (it.id !== c.item) return it;
      const review_fields = it.review_fields.filter((f) => f !== c.field);
      if (c.field === 'unit_price') {
        return { ...it, unit_price: c.value, price_source: c.value === null ? 'missing' : 'manual', price_label: null, price_review: false, matched_name: null, review_fields, amount: null };
      }
      return { ...it, [c.field]: c.value ?? (c.field === 'discount_pct' ? '0' : null), review_fields, amount: null };
    });
    return { ...data, items };
  }
  if (c.field === 'vat_mode') return { ...data, vat: { ...data.vat, mode: c.value } };
  return { ...data, discount_total_pct: c.value };
}

function valueAt(data: KpDataOut, c: KpChange): KpChange {
  if ('item' in c) {
    const it = data.items.find((x) => x.id === c.item);
    const v = it ? (c.field === 'unit_price' ? it.unit_price : c.field === 'qty' ? it.qty : it.discount_pct) : null;
    return { ...c, value: v };
  }
  if (c.field === 'vat_mode') return { ...c, value: data.vat.mode };
  return { ...c, value: data.discount_total_pct };
}

/** A price or a quantity as typed → the contract's text; null when it is not one. */
export function normalize(c: KpChange): KpChange | null {
  if (!('item' in c) || c.value === null) return c;
  const v = c.field === 'qty' ? qtyText(c.value) : priceText(c.value);
  return v === null ? null : { ...c, value: v };
}

/**
 * One tap-edit (or several: «Ввести цены подряд» sends each price as its own). The total is counted
 * again by code at once; the server's version replaces it when it answers. `savePrices`: «Сохранить
 * в прайс ☑» (the server adds the typed prices to «Мой прайс» in the same action). False when a
 * value is not a number.
 */
export async function editKp(docId: string, raw: KpChange[], o: { strip?: string | null; savePrices?: boolean } = {}): Promise<boolean> {
  const changes = raw.map(normalize);
  if (changes.some((c) => c === null)) return false;
  const list = changes as KpChange[];
  const shown = shownData(docId, st());
  if (!shown) return false;
  const before = list.map((c) => valueAt(shown, c));
  if (JSON.stringify(before) === JSON.stringify(list)) return true;
  const data = list.reduce(applyChange, shown);
  const clientId = newId();
  const ops: JsonPatchOp[] = list.map((c) => ({ op: 'replace', path: pathOf(c), value: c.value }));
  const prevRows = st().docEdits[docId]?.rows ?? [];
  set({ docEdits: { ...st().docEdits, [docId]: { data, rows: [...prevRows, clientId] } } });
  notifyDataChanged();
  const rowId = await enqueue('kp.patch', { docId, clientId, ops, ...(o.savePrices ? { savePrices: true } : {}) } satisfies KpPatchPayload);
  if (o.strip !== null) strip(o.strip ?? t('kp.changed_short'), () => void undoEdit(docId, clientId, rowId, before));
  return true;
}

async function undoEdit(docId: string, clientId: string, rowId: string | null, before: KpChange[]): Promise<void> {
  if (await dropIfWaiting(rowId)) {
    const edit = st().docEdits[docId];
    const rows = (edit?.rows ?? []).filter((r) => r !== clientId);
    const docEdits = { ...st().docEdits };
    const base = edit?.data ?? st().versions[docId]?.data;
    if (rows.length === 0 || !base) delete docEdits[docId];
    else docEdits[docId] = { data: before.reduce(applyChange, base), rows };
    set({ docEdits });
    notifyDataChanged();
    return;
  }
  // Sent: the old values go as a new version (3-engineering 6.7 п. 6: «Отменить» = back to the one before).
  await editKp(docId, before, { strip: null });
}

function settleRow(docId: string, clientId: string, ok: boolean): void {
  const edit = st().docEdits[docId];
  if (!edit) return;
  const rows = edit.rows.filter((r) => r !== clientId);
  const docEdits = { ...st().docEdits };
  if (rows.length === 0 || !ok) delete docEdits[docId];
  else docEdits[docId] = { ...edit, rows };
  set({ docEdits });
  notifyDataChanged();
}

async function sendPatch(e: OutboxEntry): Promise<void> {
  const p = e.payload as KpPatchPayload;
  const api = getApi();
  const body = () => ({ client_id: p.clientId, base_version: st().docs[p.docId]?.current_version_n ?? 0, ops: p.ops, ...(p.savePrices ? { save_prices: true } : {}) });
  let out: KpFullOut;
  try {
    out = await api.patchKp(p.docId, body());
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.code === 'conflict') {
      // A newer version (another phone, the line): the person's tap goes once more on top of it.
      try {
        putFull(kpFullOut(err.details));
      } catch {
        putFull(await api.getDocument(p.docId));
      }
      out = await api.patchKp(p.docId, body());
    } else {
      if (!isRetryable(err)) {
        settleRow(p.docId, p.clientId, false);
        useToast.getState().show(errorText(err) || t('kp.edit_refused'), 5000);
      }
      throw err;
    }
  }
  putFull(out);
  settleRow(p.docId, p.clientId, true);
  if (p.savePrices) void refreshPrices();
}

// --- the status strip: «Черновик ● Отправлено ○ Видел ○ Принято» ---

export type StatusPayload = { docId: string; clientId: string; status: DealStatus };

export const shownStatus = (doc: DocumentOut, edits = kpState().statusEdits): DealStatus => edits[doc.id]?.status ?? doc.deal_status;

/** «Клиент принял?» [Да] [Нет]: the person sets the step; «Отменить» puts the old one back. */
export async function setKpStatus(docId: string, status: DealStatus): Promise<void> {
  const doc = st().docs[docId];
  if (!doc) return;
  const before = shownStatus(doc);
  if (before === status) return;
  const put = (s: DealStatus, clientId: string) => {
    set({ statusEdits: { ...st().statusEdits, [docId]: { status: s, clientId } } });
    notifyDataChanged();
  };
  const clientId = newId();
  put(status, clientId);
  const rowId = await enqueue('kp.status', { docId, clientId, status } satisfies StatusPayload);
  strip(t(`kp.status_set_${status}`), () =>
    void (async () => {
      const back = newId();
      put(before, back);
      if (await dropIfWaiting(rowId)) return;
      await enqueue('kp.status', { docId, clientId: back, status: before } satisfies StatusPayload);
    })(),
  );
}

function clearStatusEdit(docId: string, clientId: string): void {
  if (st().statusEdits[docId]?.clientId !== clientId) return;
  const statusEdits = { ...st().statusEdits };
  delete statusEdits[docId];
  set({ statusEdits });
  notifyDataChanged();
}

async function sendStatus(e: OutboxEntry): Promise<void> {
  const p = e.payload as StatusPayload;
  try {
    const out = await getApi().setDocumentStatus(p.docId, { client_id: p.clientId, deal_status: p.status });
    if (out.document) putDocument(out.document);
  } catch (err) {
    if (!isRetryable(err)) clearStatusEdit(p.docId, p.clientId);
    throw err;
  }
  clearStatusEdit(p.docId, p.clientId);
}

// --- the PDF (the server renders it) → the system share sheet ---

export type PdfResult = 'shared' | 'offline' | 'missing' | 'fields' | 'waiting' | 'failed';

/** «Получить PDF»: the newest version, with every price known; needs the internet (the person is told). */
export async function sharePdf(docId: string, missing: number): Promise<{ result: PdfResult; fields?: string[] }> {
  if (missing > 0) return { result: 'missing' };
  if (!canSend() || syncBlocked() || !useConnectivity.getState().online) return { result: 'offline' };
  if ((st().docEdits[docId]?.rows.length ?? 0) > 0) {
    // The tap-edits go first: the PDF must show what the screen shows.
    const engine = await getSyncEngine();
    await engine.run().catch(() => undefined);
    if ((st().docEdits[docId]?.rows.length ?? 0) > 0) return { result: useConnectivity.getState().online ? 'waiting' : 'offline' };
  }
  try {
    const api = getApi();
    const out = await api.renderKp(docId);
    if (out.document) putDocument(out.document);
    const file = await api.authedFile(out.url);
    const port = getSharePort();
    const uri = await port.download(file.url, out.file_name, file.headers);
    await port.share(uri, 'application/pdf', out.file_name);
    return { result: 'shared' };
  } catch (e) {
    if (e instanceof NetworkError) return { result: 'offline' };
    if (e instanceof ApiError && e.code === 'kp_prices_missing') return { result: 'missing' };
    if (e instanceof ApiError && e.code === 'kp_fields_missing') {
      const fields = (e.details as { fields?: unknown } | null)?.fields;
      return { result: 'fields', fields: Array.isArray(fields) ? fields.filter((x): x is string => typeof x === 'string') : [] };
    }
    console.warn('kp pdf failed', e);
    return { result: 'failed' };
  }
}

// --- the sync engine's side ---

export const kpSink = {
  send(e: OutboxEntry): Promise<void> {
    switch (e.kind) {
      case 'kp.profile':
        return sendProfile(e);
      case 'kp.image':
        return sendImage(e);
      case 'kp.prices':
        return sendPrices(e);
      case 'kp.price':
        return sendPrice(e);
      case 'kp.price_delete':
        return sendPriceDelete(e);
      case 'kp.patch':
        return sendPatch(e);
      default:
        return sendStatus(e);
    }
  },
  /** /sync `documents` (rows of the card file; `price_list_items` too if the server ever sends them). */
  apply(x: { documents: DocumentOut[]; prices: PriceItemOut[] }): void {
    for (const d of x.documents) putDocument(d);
    applyPrices(x.prices);
    for (const job of Object.values(st().jobs)) {
      const d = job.documentId ? st().docs[job.documentId] : undefined;
      if (job.state === 'reading' && d && d.status !== 'extracting') putJob({ ...job, state: jobState(d), message: docMessage(d) });
    }
    if (Object.values(st().jobs).some((j) => j.state === 'waiting' || j.state === 'reading')) void pumpJobs();
  },
  tombstone(entity: string, id: string): void {
    if (entity === 'document') {
      const docs = { ...st().docs };
      delete docs[id];
      set({ docs });
      notifyDataChanged();
    } else if (entity === 'price_list_item') {
      putPrice(id, null);
    }
  },
};

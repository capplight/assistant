import { ApiError, isRetryable, NetworkError } from '@/api/errors';
import type {
  CompanyProfileIn,
  CompanyProfileOut,
  DealStatus,
  DocumentOut,
  DraftOut,
  JsonPatchOp,
  KpDataOut,
  KpFileFormat,
  KpFullOut,
  KpItemOut,
  KpSendChannel,
  KpSentChannel,
  ApiFileOut,
  SendExecuteOut,
  KpVatMode,
  KpVersionOut,
  PriceItemOut,
  PriceListOut,
} from '@/api/types';
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
import { priceMoney, qtyShown, rateText } from './view';
import { getSharePort, type MailResult } from './share';
import {
  cachedVersion,
  kpState,
  LOCAL_PRICE,
  sentVersion,
  shownDraft,
  shownData,
  reviewKey,
  shownProfile,
  versionKey,
  type KpJob,
  type ProfileFields,
  type ProfileImageRole,
  type SendDraft,
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
const SIGNER = { signer_name: 'name', signer_title: 'title' } as const;
const LICENSE = { license_number: 'number', license_date: 'date', license_category: 'category' } as const;

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
  if (Object.keys(SIGNER).some((k) => k in f)) {
    const sg: Record<string, string | null> = {};
    for (const [mine, theirs] of Object.entries(SIGNER)) sg[theirs] = (k(f, mine) ?? shown[mine as keyof typeof SIGNER]) || null;
    body.signer = sg as CompanyProfileIn['signer'];
  }
  if (Object.keys(LICENSE).some((k) => k in f)) {
    const lc: Record<string, string | null> = {};
    for (const [mine, theirs] of Object.entries(LICENSE)) lc[theirs] = (k(f, mine) ?? shown[mine as keyof typeof LICENSE]) || null;
    body.license = lc as CompanyProfileIn['license'];
  }
  if ('outgoing_next' in f && f.outgoing_next) {
    const next = Number(f.outgoing_next);
    if (Number.isInteger(next) && next >= 1) body.outgoing = { next };
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

/** /sync `price_lists`: a removed list takes its rows off «Мой прайс» (a change still waiting stays). */
function putPriceLists(list: readonly PriceListOut[]): void {
  const priceLists = { ...st().priceLists };
  for (const l of list) {
    const prev = priceLists[l.id];
    if (prev && l.seq > 0 && prev.seq > l.seq) continue;
    priceLists[l.id] = l;
  }
  set({ priceLists });
  for (const l of list) if (l.deleted_at) dropPriceList(l.id, false);
  notifyDataChanged();
}

function dropPriceList(id: string, removeRow = true): void {
  const prices = { ...st().prices };
  for (const [k, p] of Object.entries(prices)) if (p.price_list_id === id) delete prices[k];
  set({ prices, ...(removeRow ? { priceLists: without(st().priceLists, id) } : {}) });
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
  // «Изменил: …» belongs to the version the phrase made: a newer one (a tap, another phone) takes it away.
  const change = st().phraseChanges[doc.id];
  const phraseChanges = change && doc.current_version_n !== null && doc.current_version_n !== change.n ? without(st().phraseChanges, doc.id) : st().phraseChanges;
  // The server has the «Отправили?» of this phone.
  const sent = st().sentEdits[doc.id];
  const sentEdits = sent && doc.sent_version_n !== null && doc.sent_version_n >= sent.n ? without(st().sentEdits, doc.id) : st().sentEdits;
  set({ docs, versions, phraseChanges, sentEdits });
  notifyDataChanged();
}

function without<T>(m: Record<string, T>, key: string): Record<string, T> {
  const next = { ...m };
  delete next[key];
  return next;
}

/** Versions are frozen once made: the phone keeps the ones it saw (≤60), for «Версии» and «Вернуть» offline. */
function cacheVersion(docId: string, v: KpVersionOut): void {
  const oldVersions = { ...st().oldVersions, [versionKey(docId, v.n)]: v };
  const keys = Object.keys(oldVersions);
  for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete oldVersions[k];
  set({ oldVersions });
}

/** The row with its current version (GET /documents/{id}, the answers of POST /documents/kp and /patch). */
export function putFull(out: KpFullOut): void {
  putDocument(out.document);
  const versions = { ...st().versions };
  if (out.version) {
    versions[out.document.id] = out.version;
    cacheVersion(out.document.id, out.version);
  }
  // Week 15: the document comes with its versions (newest first, ≤50): the «Версии» list offline too.
  if (out.versions) set({ history: { ...st().history, [out.document.id]: { versions: out.versions, sent_version_n: out.document.sent_version_n } } });
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
  | { item: string; field: 'unit_price' | 'qty' | 'discount_pct' | 'volume'; value: string | null }
  | { field: 'vat_mode'; value: KpVatMode }
  | { field: 'discount_total_pct'; value: string };

/** Week 15: a new line — a lump sum (name, «Объём» as text, the amount) or quantity × price. `id`: the phone's until the server answers. */
export type NewKpLine = { id: string; kind: 'qty' | 'lump'; name: string; volume: string | null; unit: string | null; qty: string | null; unit_price: string | null };

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
      if (c.field === 'volume') return { ...it, volume: c.value, review_fields };
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
    const v = it ? (c.field === 'unit_price' ? it.unit_price : c.field === 'qty' ? it.qty : c.field === 'volume' ? it.volume : it.discount_pct) : null;
    return { ...c, value: v };
  }
  if (c.field === 'vat_mode') return { ...c, value: data.vat.mode };
  return { ...c, value: data.discount_total_pct };
}

/** A price or a quantity as typed → the contract's text; null when it is not one. */
export function normalize(c: KpChange): KpChange | null {
  if (!('item' in c) || c.value === null) return c;
  // «Объём» is text as written («на срок работ (40 дней)»), never a number.
  if (c.field === 'volume') return { ...c, value: c.value.trim().slice(0, 200) || null };
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
  set({ docEdits: { ...st().docEdits, [docId]: { data, rows: [...prevRows, clientId] } }, phraseChanges: without(st().phraseChanges, docId) });
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

/**
 * «+ Добавить строку» (week 15): a lump sum («Монтаж систем — 1 здание — 38 635 000 ₸», the
 * father's КП) or quantity × price. Shown at once and counted by code, offline too; goes as
 * `add /items/-`. «Отменить»: still waiting → dropped; sent → the version before comes back.
 */
export async function addKpLine(docId: string, line: Omit<NewKpLine, 'id'>): Promise<boolean> {
  const name = line.name.trim();
  if (!name) return false;
  const price = line.unit_price === null || line.unit_price.trim() === '' ? null : priceText(line.unit_price);
  if (line.unit_price && price === null) return false;
  const lump = line.kind === 'lump';
  const qty = lump ? '1' : qtyText(line.qty ?? '1');
  if (qty === null) return false;
  const shown = shownData(docId, st());
  if (!shown) return false;
  const id = `new-${newId()}`;
  const item: KpItemOut = {
    id,
    kind: line.kind,
    volume: line.volume?.trim() || null,
    name,
    unit: lump ? null : line.unit?.trim() || null,
    qty,
    unit_price: price,
    discount_pct: '0',
    price_source: price === null ? 'missing' : 'manual',
    price_label: null,
    price_review: false,
    matched_name: null,
    source_ref: null,
    review_fields: [],
    amount: null,
  };
  const value: Record<string, unknown> = lump
    ? { kind: 'lump', name, volume: item.volume, unit_price: price }
    : { name, unit: item.unit, qty, unit_price: price };
  const clientId = newId();
  const beforeN = st().docs[docId]?.current_version_n ?? null;
  const cur = st().versions[docId];
  if (cur) cacheVersion(docId, cur);
  const prevRows = st().docEdits[docId]?.rows ?? [];
  set({
    docEdits: { ...st().docEdits, [docId]: { data: { ...shown, items: [...shown.items, item] }, rows: [...prevRows, clientId] } },
    phraseChanges: without(st().phraseChanges, docId),
  });
  notifyDataChanged();
  const rowId = await enqueue('kp.patch', { docId, clientId, ops: [{ op: 'add', path: '/items/-', value }] } satisfies KpPatchPayload);
  strip(t('kp.line_added', { name }), () =>
    void (async () => {
      if (await dropIfWaiting(rowId)) {
        const edit = st().docEdits[docId];
        if (!edit) return;
        const rows = edit.rows.filter((r) => r !== clientId);
        const docEdits = { ...st().docEdits };
        if (rows.length === 0) delete docEdits[docId];
        else docEdits[docId] = { data: { ...edit.data, items: edit.data.items.filter((x) => x.id !== id) }, rows };
        set({ docEdits });
        notifyDataChanged();
        return;
      }
      if (beforeN !== null) await revertTo(docId, beforeN, { strip: false });
    })(),
  );
  return true;
}

// --- the status strip: «Черновик ● Отправлено ○ Видел ○ Принято» ---

export type StatusPayload = { docId: string; clientId: string; status: DealStatus };

export const shownStatus = (doc: DocumentOut, edits = kpState().statusEdits, sent = kpState().sentEdits): DealStatus =>
  edits[doc.id]?.status ?? (sent[doc.id] && doc.deal_status === 'draft' ? 'sent' : doc.deal_status);

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

// --- the file (the server renders it: PDF by default, Word on request) → the system share sheet ---

export type PdfResult = 'shared' | 'offline' | 'missing' | 'fields' | 'waiting' | 'failed';
export type FileResult = { result: PdfResult; fields?: string[] };
export type KpFile = { uri: string; name: string; mime: string; n: number };

const online = () => canSend() && !syncBlocked() && useConnectivity.getState().online;

/** The tap-edits and «Вернуть» on their way go first: the file and the phrase must see what the screen shows. */
async function flushEdits(docId: string): Promise<'ok' | 'offline' | 'waiting'> {
  if ((st().docEdits[docId]?.rows.length ?? 0) === 0) return 'ok';
  const engine = await getSyncEngine();
  await engine.run().catch(() => undefined);
  if ((st().docEdits[docId]?.rows.length ?? 0) === 0) return 'ok';
  return useConnectivity.getState().online ? 'waiting' : 'offline';
}

function fileError(e: unknown): FileResult {
  if (e instanceof NetworkError) return { result: 'offline' };
  if (e instanceof ApiError && e.code === 'kp_prices_missing') return { result: 'missing' };
  if (e instanceof ApiError && e.code === 'kp_fields_missing') {
    const fields = (e.details as { fields?: unknown } | null)?.fields;
    return { result: 'fields', fields: Array.isArray(fields) ? fields.filter((x): x is string => typeof x === 'string') : [] };
  }
  console.warn('kp file failed', e);
  return { result: 'failed' };
}

/**
 * The file of a version on the phone (the server renders it; the same version gives the same file).
 * `n`: an older version (the sent one is kept, Ф-5); by default the current one.
 */
export async function kpFile(
  docId: string,
  o: { format?: KpFileFormat; n?: number | null; missing?: number } = {},
): Promise<FileResult & { file?: KpFile }> {
  if ((o.missing ?? 0) > 0) return { result: 'missing' };
  if (!online()) return { result: 'offline' };
  if (!o.n) {
    const flushed = await flushEdits(docId);
    if (flushed !== 'ok') return { result: flushed };
  }
  try {
    const api = getApi();
    const out = await api.renderKp(docId, { format: o.format ?? 'pdf', n: o.n ?? null });
    if (out.document) putDocument(out.document);
    const file = await api.authedFile(out.url);
    const uri = await getSharePort().download(file.url, out.file_name, file.headers);
    return { result: 'shared', file: { uri, name: out.file_name, mime: out.mime, n: out.version_n } };
  } catch (e) {
    return fileError(e);
  }
}

/** «Получить PDF» / «Сделать в Word»: the file into the system «Поделиться». Needs the internet (the person is told). */
export async function shareKpFile(docId: string, o: { format?: KpFileFormat; n?: number | null; missing?: number } = {}): Promise<FileResult> {
  const got = await kpFile(docId, o);
  if (!got.file) return got;
  try {
    await getSharePort().share(got.file.uri, got.file.mime, got.file.name);
    return { result: 'shared' };
  } catch (e) {
    return fileError(e);
  }
}

export const sharePdf = (docId: string, missing: number) => shareKpFile(docId, { format: 'pdf', missing });

// --- week 15: a change by a phrase («убери доставку», «скидка 5%»), applied at once (R-30) ---

export type PhraseResult =
  | { result: 'applied' }
  /** The server found nothing to change; `message` says so in its words. */
  | { result: 'nothing'; message: string | null }
  | { result: 'offline' | 'no_ai' | 'waiting' | 'failed'; message?: string | null };

/**
 * One phrase from the line on S17 → `POST /documents/{id}/edit` (KP_EDIT). The new version is shown
 * at once with its `changed_paths` lit and «Изменил: … [Что изменилось] [Отменить]». The model
 * gives a patch; every number is the server's code. Offline and in «Без ИИ» the phrase is not
 * queued (it would change the КП later, out of sight): the person is told and edits by hand.
 */
export async function phraseEdit(docId: string, text: string): Promise<PhraseResult> {
  const phrase = text.trim();
  if (!phrase) return { result: 'nothing', message: null };
  if (!assistantOn()) return { result: 'no_ai' };
  if (!online()) return { result: 'offline' };
  const flushed = await flushEdits(docId);
  if (flushed !== 'ok') return { result: flushed };
  const api = getApi();
  const before = st().versions[docId];
  const clientId = newId();
  const body = () => ({ client_id: clientId, base_version: st().docs[docId]?.current_version_n ?? before?.n ?? 0, text: phrase });
  try {
    let out;
    try {
      out = await api.editKpPhrase(docId, body());
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409 && err.code === 'conflict')) throw err;
      // A newer version (another phone): the phrase once more, on top of it.
      try {
        putFull(kpFullOut(err.details));
      } catch {
        putFull(await api.getDocument(docId));
      }
      out = await api.editKpPhrase(docId, body());
    }
    if (out.status !== 'applied' || !out.version) {
      putFull(out);
      return { result: 'nothing', message: out.message };
    }
    const beforeN = before?.n ?? Math.max(1, out.version.n - 1);
    if (before) cacheVersion(docId, before);
    putFull(out);
    set({
      phraseChanges: {
        ...st().phraseChanges,
        [docId]: {
          text: phrase,
          changeText: out.change_text || t('kp.changed_short'),
          beforeN,
          n: out.version.n,
          actionId: out.action?.id ?? null,
          changedPaths: out.version.changed_paths,
          at: nowIso(),
        },
      },
    });
    notifyDataChanged();
    return { result: 'applied' };
  } catch (e) {
    if (e instanceof NetworkError) return { result: 'offline' };
    if (e instanceof ApiError && e.code === 'consent_required') return { result: 'no_ai' };
    return { result: 'failed', message: errorText(e) };
  }
}

export type PhraseUndo = 'done' | 'partial' | 'queued' | 'failed';

/**
 * «Отменить» of the phrase change: the server's undo of its action (back to the version before,
 * as a new version; «Часть уже изменена вами» when the КП changed since). Without the internet
 * the version before — the phone holds it — goes back by «Вернуть», through the outbox.
 */
export async function undoPhrase(docId: string): Promise<{ result: PhraseUndo; message: string | null }> {
  const change = st().phraseChanges[docId];
  if (!change) return { result: 'failed', message: null };
  set({ phraseChanges: without(st().phraseChanges, docId) });
  notifyDataChanged();
  if (change.actionId && online()) {
    try {
      const out = await getApi().undoAction(change.actionId, { client_id: newId() });
      await refreshDocument(docId);
      return { result: out.partial ? 'partial' : 'done', message: out.message_ru };
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) return { result: 'failed', message: errorText(e) };
      if (!(e instanceof NetworkError)) console.warn('kp phrase undo failed', e);
    }
  }
  const r = await revertTo(docId, change.beforeN, { strip: false });
  return { result: r === 'unknown' ? 'failed' : 'queued', message: null };
}

/** «Что изменилось»: the change line by line, from the two versions as they are (no number is counted here). */
export type ChangeRow = { key: string; text: string };

export function describeChange(before: KpDataOut, after: KpDataOut, tt: (k: string, o?: Record<string, unknown>) => string = t): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const old = new Map(before.items.map((i) => [i.id, i]));
  const now = new Map(after.items.map((i) => [i.id, i]));
  const money = (p: string | null) => (p === null ? tt('kp.diff_no_price') : priceMoney(p));
  const qty = (it: KpItemOut) => (it.kind === 'lump' ? (it.volume ?? '') : `${qtyShown(it.qty)} ${it.unit ?? ''}`.trim());
  for (const it of before.items) if (!now.has(it.id)) rows.push({ key: `rm-${it.id}`, text: tt('kp.diff_removed', { name: it.name }) });
  for (const it of after.items) {
    const was = old.get(it.id);
    if (!was) {
      rows.push({
        key: `add-${it.id}`,
        text: it.kind === 'lump' ? tt('kp.diff_added_lump', { name: it.name, volume: it.volume ?? '', price: money(it.unit_price) }) : tt('kp.diff_added', { name: it.name, qty: qty(it), price: money(it.unit_price) }),
      });
      continue;
    }
    if (was.name !== it.name) rows.push({ key: `name-${it.id}`, text: tt('kp.diff_name', { from: was.name, to: it.name }) });
    if ((was.volume ?? '') !== (it.volume ?? '')) rows.push({ key: `vol-${it.id}`, text: tt('kp.diff_volume', { name: it.name, to: it.volume ?? tt('kp.diff_none') }) });
    if (it.kind !== 'lump' && qty(was) !== qty(it)) rows.push({ key: `qty-${it.id}`, text: tt('kp.diff_qty', { name: it.name, from: qty(was), to: qty(it) }) });
    if (was.unit_price !== it.unit_price) rows.push({ key: `price-${it.id}`, text: tt('kp.diff_price', { name: it.name, from: money(was.unit_price), to: money(it.unit_price) }) });
    if (pct(was.discount_pct) !== pct(it.discount_pct))
      rows.push({ key: `disc-${it.id}`, text: tt('kp.diff_discount', { name: it.name, from: pct(was.discount_pct), to: pct(it.discount_pct) }) });
  }
  if (pct(before.discount_total_pct) !== pct(after.discount_total_pct))
    rows.push({ key: 'disc', text: tt('kp.diff_discount_total', { from: pct(before.discount_total_pct), to: pct(after.discount_total_pct) }) });
  if (before.vat.mode !== after.vat.mode)
    rows.push({ key: 'vat', text: tt('kp.diff_vat', { from: tt(`kp.vat_mode_${before.vat.mode}`), to: tt(`kp.vat_mode_${after.vat.mode}`) }) });
  for (const k of new Set([...Object.keys(before.terms), ...Object.keys(after.terms)])) {
    const a = before.terms[k] ?? null;
    const b = after.terms[k] ?? null;
    if (String(a ?? '') !== String(b ?? ''))
      rows.push({ key: `term-${k}`, text: tt('kp.diff_term', { what: tt(`kp.term_${k}`, { defaultValue: k }), to: b === null || b === '' ? tt('kp.diff_none') : String(b) }) });
  }
  if (before.client.name !== after.client.name) rows.push({ key: 'client', text: tt('kp.diff_client', { to: after.client.name ?? tt('kp.diff_none') }) });
  return rows;
}

/** «5%», «2,5%» — a percent as written (never counted). */
const pct = (p: string | null) => `${rateText(p ?? '0')}%`;

// --- week 15: versions; «Вернуть эту» (a new version equal to n) ---

export async function loadVersions(docId: string): Promise<boolean> {
  if (!online()) return false;
  try {
    const list = await getApi().kpVersions(docId);
    set({ history: { ...st().history, [docId]: list } });
    notifyDataChanged();
    return true;
  } catch {
    return false;
  }
}

/** One version as it was (read only; the sent one is frozen). From the phone if it saw it, else the server. */
export async function loadVersion(docId: string, n: number): Promise<KpVersionOut | null> {
  const have = cachedVersion(docId, n);
  if (have) return have;
  if (!online()) return null;
  try {
    const out = await getApi().kpVersion(docId, n);
    if (out.version) {
      cacheVersion(docId, out.version);
      notifyDataChanged();
    }
    return out.version;
  } catch {
    return null;
  }
}

export type RevertPayload = { docId: string; clientId: string; n: number };

/**
 * «Вернуть эту»: shown at once when the phone holds that version (offline too), sent through the
 * outbox; «Отменить»: still waiting → dropped; sent → the version before goes back the same way.
 * `unknown`: offline and the phone never saw that version.
 */
export async function revertTo(docId: string, n: number, o: { strip?: boolean } = {}): Promise<'ok' | 'unknown'> {
  const target = cachedVersion(docId, n);
  const beforeN = st().docs[docId]?.current_version_n ?? st().versions[docId]?.n ?? null;
  if (!target && !online()) return 'unknown';
  if (beforeN === n && !st().docEdits[docId]) return 'ok';
  const cur = st().versions[docId];
  if (cur) cacheVersion(docId, cur);
  const clientId = newId();
  if (target) {
    const prevRows = st().docEdits[docId]?.rows ?? [];
    set({ docEdits: { ...st().docEdits, [docId]: { data: target.data, rows: [...prevRows, clientId] } } });
  }
  set({ phraseChanges: without(st().phraseChanges, docId) });
  notifyDataChanged();
  const rowId = await enqueue('kp.revert', { docId, clientId, n } satisfies RevertPayload);
  if (o.strip !== false) {
    strip(t('kp.reverted', { n }), () =>
      void (async () => {
        if (await dropIfWaiting(rowId)) {
          settleRow(docId, clientId, false);
          return;
        }
        if (beforeN !== null) await revertTo(docId, beforeN, { strip: false });
      })(),
    );
  }
  return 'ok';
}

async function sendRevert(e: OutboxEntry): Promise<void> {
  const p = e.payload as RevertPayload;
  let out: KpFullOut;
  try {
    out = await getApi().revertKp(p.docId, { client_id: p.clientId, n: p.n });
  } catch (err) {
    if (!isRetryable(err)) {
      settleRow(p.docId, p.clientId, false);
      useToast.getState().show(errorText(err) || t('kp.edit_refused'), 5000);
    }
    throw err;
  }
  putFull(out);
  settleRow(p.docId, p.clientId, true);
  void loadVersions(p.docId);
}

// --- week 15: sending (S18). The app opens WhatsApp / mail / «Поделиться»; the person presses ➤ ---

/** The covering text, as the person reads it in the chat («Добрый день, Ерлан! Направляю КП № 14 на 1 218 500 ₸.»). */
export function defaultSendText(doc: DocumentOut, data: KpDataOut, total: string | null, tt: (k: string, o?: Record<string, unknown>) => string = t): string {
  const name = data.client.contact?.trim();
  const number = doc.number?.replace(/^КП[-\s№]*(\d{4}-)?0*/i, '') ?? '';
  const hello = name ? tt('send.text_hello_name', { name }) : tt('send.text_hello');
  const what = number ? tt('send.text_kp_number', { number }) : tt('send.text_kp');
  const body = total ? tt('send.text_body_sum', { what, total }) : tt('send.text_body', { what });
  return `${hello}\n${body}`;
}

const EMPTY_DRAFT: SendDraft = { text: null, phone: '', email: '', channel: 'whatsapp', format: 'pdf' };

/** The S18 form of this КП (a draft, kept here: the number, the address and the text never go to the server). */
export function sendDraft(docId: string): SendDraft {
  return st().sendDrafts[docId] ?? EMPTY_DRAFT;
}

export function saveSendDraft(docId: string, patch: Partial<SendDraft>): void {
  set({ sendDrafts: { ...st().sendDrafts, [docId]: { ...sendDraft(docId), ...patch } } });
}

/** Only the digits of a number, with the country (8 701 … → 7701…); null when it is not a phone number. */
export function waNumber(raw: string): string | null {
  let d = raw.replace(/\D+/g, '');
  if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`;
  if (d.length === 10) d = `7${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

/** «Отправить только текст в чат»: `wa.me/<номер>?text=` (without a number WhatsApp asks for the chat). Works offline. */
export function waLink(phone: string, text: string): string {
  return `https://wa.me/${waNumber(phone) ?? ''}?text=${encodeURIComponent(text)}`;
}

export type OpenResult = {
  result: 'opened' | 'offline' | 'missing' | 'fields' | 'waiting' | 'failed';
  fields?: string[];
  n?: number;
  mail?: MailResult;
  channel?: KpSentChannel;
};

/** S18's choice → `sent_channel` of «Отправили?» [Да] (kp.md). */
const SENT_CHANNEL: Record<KpSendChannel, KpSentChannel> = { whatsapp: 'whatsapp_share', email: 'email', share: 'share_other' };

/**
 * [Открыть WhatsApp] / [Открыть почту] / [Поделиться] on S18 = the «Да» of the confirmation
 * (kp.md «Sending»): `POST /documents/{id}/send` (the file of the version and a pending action,
 * preview by code) → `POST /pending-actions/{id}/confirm` → `execute`, what to open. The file is
 * fetched with the session and the system sheet (or the mail app with the file attached) opens.
 * The person chooses the chat and presses ➤ (decision №6). The version is kept for «Отправили?».
 */
export async function openSend(
  docId: string,
  o: { channel: KpSendChannel; format: KpFileFormat; missing: number; text: string; email?: string; subject: string; recipientName: string | null },
): Promise<OpenResult> {
  if (o.missing > 0) return { result: 'missing' };
  if (!online()) return { result: 'offline' };
  const flushed = await flushEdits(docId);
  if (flushed !== 'ok') return { result: flushed };
  const api = getApi();
  let n: number;
  let pendingId: string | null = null;
  let file: ApiFileOut | null;
  let execute: SendExecuteOut | null = null;
  try {
    const sent = await api.sendKp(docId, {
      client_id: newId(),
      n: st().docs[docId]?.current_version_n ?? undefined,
      channel: o.channel,
      format: o.format,
      recipient_name: o.recipientName,
      message: o.text,
    });
    if (sent.document) putDocument(sent.document);
    n = sent.version_n || (st().docs[docId]?.current_version_n ?? 1);
    file = sent.file;
    pendingId = sent.pending_action?.id ?? null;
    if (pendingId) {
      execute = (await api.confirmPending(pendingId, newId())).execute;
      file = execute?.file ?? file;
    }
  } catch (e) {
    const r = fileError(e);
    return { result: r.result === 'shared' ? 'failed' : r.result, fields: r.fields };
  }
  if (!file) return { result: 'failed' };
  const port = getSharePort();
  try {
    const auth = await api.authedFile(file.url);
    const uri = await port.download(auth.url, file.name, auth.headers);
    const keep = (channel: KpSentChannel) => set({ pendingSends: { ...st().pendingSends, [docId]: { n, channel, pendingId, at: nowIso() } } });
    if (o.channel === 'email' && port.mail) {
      const mail = await port.mail({
        recipients: o.email?.trim() ? [o.email.trim()] : [],
        subject: execute?.subject ?? o.subject,
        body: execute?.text ?? o.text,
        attachments: [uri],
      });
      if (mail !== 'unavailable') {
        keep('email');
        return { result: 'opened', n, mail, channel: 'email' };
      }
      // No mail account on this phone: the sheet, the person picks the mail app there.
      keep('share_other');
      await port.share(uri, file.mime, file.name);
      return { result: 'opened', n, mail, channel: 'share_other' };
    }
    keep(SENT_CHANNEL[o.channel]);
    await port.share(uri, file.mime, file.name);
    return { result: 'opened', n, channel: SENT_CHANNEL[o.channel] };
  } catch (e) {
    if (e instanceof NetworkError) return { result: 'offline' };
    console.warn('kp send open failed', e);
    return { result: 'failed' };
  }
}

export type SentPayload = {
  docId: string;
  clientId: string;
  n: number;
  channel: KpSentChannel;
  pendingId: string | null;
  /** `not_sent`: «Отправили?» [Нет] → `POST /pending-actions/{id}/result`. */
  outcome?: 'sent' | 'not_sent';
};

/**
 * «Отправили?» [Да]: the version is marked sent (`sent_at`, `sent_version_n`, frozen) and the
 * status strip says «Отправлено» at once, offline too. It went outside the app, so there is no
 * «Отменить» (6.8, string 45, `send_external` is `undoable: false`); a wrong «Да» is put right on
 * the status strip («Вернуть в черновик»).
 */
export async function markSent(docId: string, n: number, channel: KpSentChannel): Promise<void> {
  const clientId = newId();
  const pendingId = st().pendingSends[docId]?.pendingId ?? null;
  set({ sentEdits: { ...st().sentEdits, [docId]: { n, channel, clientId, at: nowIso() } }, pendingSends: without(st().pendingSends, docId) });
  notifyDataChanged();
  await enqueue('kp.sent', { docId, clientId, n, channel, pendingId, outcome: 'sent' } satisfies SentPayload);
}

/** «Отправили?» [Нет]: nothing is marked; the server's pending send is closed; the file can be opened again. */
export async function notSent(docId: string): Promise<void> {
  const p = st().pendingSends[docId];
  set({ pendingSends: without(st().pendingSends, docId) });
  if (p?.pendingId) await enqueue('kp.sent', { docId, clientId: newId(), n: p.n, channel: p.channel, pendingId: p.pendingId, outcome: 'not_sent' } satisfies SentPayload);
}

async function sendSent(e: OutboxEntry): Promise<void> {
  const p = e.payload as SentPayload;
  const api = getApi();
  if (p.outcome === 'not_sent') {
    if (!p.pendingId) return;
    try {
      await api.pendingResult(p.pendingId, { outcome: 'not_sent', client_id: p.clientId });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 409 || err.status === 410)) return; // closed already
      throw err;
    }
    return;
  }
  try {
    const out = await api.markKpSent(p.docId, p.n, { client_id: p.clientId, channel: p.channel, ...(p.pendingId ? { pending_action_id: p.pendingId } : {}) });
    putFull(out);
  } catch (err) {
    if (!isRetryable(err) && st().sentEdits[p.docId]?.clientId === p.clientId) {
      set({ sentEdits: without(st().sentEdits, p.docId) });
      notifyDataChanged();
      useToast.getState().show(errorText(err) || t('send.mark_refused'), 5000);
    }
    throw err;
  }
}

/** «Клиент видел v3. Отправить новую?»: the version sent before, when the current one is newer. */
export function clientSaw(doc: DocumentOut): number | null {
  const sent = sentVersion(doc);
  const cur = doc.current_version_n;
  return sent !== null && cur !== null && cur > sent ? sent : null;
}

// --- F-15 drafts (US-13, S25): the assistant writes a message, the person sends it ---

export function putDrafts(list: readonly DraftOut[]): void {
  if (list.length === 0) return;
  const drafts = { ...st().drafts };
  for (const d of list) {
    const prev = drafts[d.id];
    if (prev && d.seq > 0 && prev.seq > d.seq) continue;
    drafts[d.id] = d;
  }
  set({ drafts });
  notifyDataChanged();
}

export type DraftCreateResult = { result: 'ok'; id: string } | { result: 'offline' | 'no_ai' | 'failed'; message?: string | null };

/** «Написать клиенту»: the request («напиши, что КП будет в пятницу») → DRAFT on the server. Needs the internet. */
export async function createDraft(request: string, o: { documentId?: string | null; channel: 'whatsapp' | 'email'; recipientName?: string | null }): Promise<DraftCreateResult> {
  const text = request.trim();
  if (!text) return { result: 'failed' };
  if (!assistantOn()) return { result: 'no_ai' };
  if (!online()) return { result: 'offline' };
  try {
    const out = await getApi().createDraft({
      client_id: newId(),
      request: text,
      channel: o.channel,
      ...(o.recipientName ? { recipient_name: o.recipientName } : {}),
      ...(o.documentId ? { document_id: o.documentId } : {}),
    });
    if (!out.draft) return { result: 'failed' };
    putDrafts([out.pending_action ? { ...out.draft, pending_action_id: out.pending_action.id } : out.draft]);
    return { result: 'ok', id: out.draft.id };
  } catch (e) {
    if (e instanceof NetworkError) return { result: 'offline' };
    if (e instanceof ApiError && e.code === 'consent_required') return { result: 'no_ai' };
    return { result: 'failed', message: errorText(e) };
  }
}

export async function refreshDrafts(): Promise<void> {
  if (!canSend() || syncBlocked()) return;
  try {
    putDrafts(await getApi().drafts());
  } catch {
    // offline: the phone's copy stays
  }
}

export type DraftPayload =
  | { op: 'patch'; id: string; clientId: string; text: string }
  | { op: 'delete'; id: string; clientId: string }
  | { op: 'result'; id: string; clientId: string; pendingId: string; outcome: 'sent' | 'not_sent' };

function overlayDraft(id: string, patch: { text?: string; status?: DraftOut['status'] } | null, clientId: string): void {
  const draftEdits = { ...st().draftEdits };
  if (patch === null) delete draftEdits[id];
  else draftEdits[id] = { ...draftEdits[id], ...patch, clientId };
  set({ draftEdits });
  notifyDataChanged();
}

/** «Изменить»: the person's own text, at once and offline too; «Отменить» puts the text before back. */
export async function editDraftText(id: string, text: string): Promise<void> {
  const now = shownDraft(id);
  const next = text.trim();
  if (!now || !next || next === now.text) return;
  const before = now.text;
  const clientId = newId();
  overlayDraft(id, { text: next }, clientId);
  const rowId = await enqueue('kp.draft', { op: 'patch', id, clientId, text: next } satisfies DraftPayload);
  strip(t('draft.text_saved'), () =>
    void (async () => {
      const back = newId();
      overlayDraft(id, { text: before }, back);
      if (!(await dropIfWaiting(rowId))) await enqueue('kp.draft', { op: 'patch', id, clientId: back, text: before } satisfies DraftPayload);
    })(),
  );
}

/**
 * «Не надо»: the draft goes from the list at once with «Отменить». The server has no way back for a
 * discarded draft, so the DELETE waits until the strip is gone — «Отменить» before that drops it.
 */
export async function discardDraft(id: string): Promise<void> {
  if (!shownDraft(id)) return;
  const clientId = newId();
  overlayDraft(id, { status: 'discarded' }, clientId);
  let undone = false;
  strip(t('draft.discarded'), () => {
    undone = true;
    if (st().draftEdits[id]?.clientId === clientId) overlayDraft(id, null, clientId);
  });
  // Sent once the strip is no longer shown (its time is up or another change replaced it).
  const unsub = useUndo.subscribe((s) => {
    if (s.strip?.kind === 'custom' && s.strip.text === t('draft.discarded')) return;
    unsub();
    if (!undone) void enqueue('kp.draft', { op: 'delete', id, clientId } satisfies DraftPayload);
  });
}

export type DraftOpenResult = { result: 'opened' | 'offline' | 'waiting' | 'failed'; message?: string | null };

/**
 * [Открыть WhatsApp] / [Открыть почту] = the «Да»: `POST /pending-actions/{id}/confirm` →
 * `execute` → `wa.me/<номер>?text=` (the number typed here, never sent to the server) or the mail
 * app. The person presses ➤. Back here: «Отправили?».
 */
export async function openDraft(id: string, o: { phone: string; email: string }): Promise<DraftOpenResult> {
  if (!online()) return { result: 'offline' };
  if (st().draftEdits[id]) {
    // The text typed goes first: the confirmation is bound to what is shown.
    const engine = await getSyncEngine();
    await engine.run().catch(() => undefined);
    if (st().draftEdits[id]) return { result: useConnectivity.getState().online ? 'waiting' : 'offline' };
  }
  const d = shownDraft(id);
  if (!d?.pending_action_id) return { result: 'failed' };
  try {
    const out = await getApi().confirmPending(d.pending_action_id, newId());
    const ex = out.execute;
    if (!ex) return { result: 'failed' };
    const port = getSharePort();
    if (ex.kind === 'email' && port.mail) {
      const mail = await port.mail({ recipients: o.email.trim() ? [o.email.trim()] : [], subject: ex.subject ?? '', body: ex.text ?? d.text, attachments: [] });
      if (mail === 'unavailable') {
        const ok = port.openUrl ? await port.openUrl(`mailto:${encodeURIComponent(o.email.trim())}?subject=${encodeURIComponent(ex.subject ?? '')}&body=${encodeURIComponent(ex.text ?? d.text)}`) : false;
        if (!ok) return { result: 'failed' };
      }
    } else {
      const url = (ex.wa_url_template ?? `https://wa.me/{phone}?text=${encodeURIComponent(ex.text ?? d.text)}`).replace('{phone}', waNumber(o.phone) ?? '');
      const ok = port.openUrl ? await port.openUrl(url) : false;
      if (!ok) return { result: 'failed', message: t('send.wa_failed') };
    }
    set({ draftAsks: { ...st().draftAsks, [id]: { pendingId: d.pending_action_id, at: nowIso() } } });
    return { result: 'opened' };
  } catch (e) {
    if (e instanceof NetworkError) return { result: 'offline' };
    return { result: 'failed', message: errorText(e) };
  }
}

/** «Отправили?» [Да] (the draft is sent, no «Отменить»: it went outside the app) / [Нет] (nothing marked). */
export async function answerDraft(id: string, sent: boolean): Promise<void> {
  const ask = st().draftAsks[id];
  set({ draftAsks: without(st().draftAsks, id) });
  if (!ask) return;
  const clientId = newId();
  if (sent) overlayDraft(id, { status: 'sent' }, clientId);
  await enqueue('kp.draft', { op: 'result', id, clientId, pendingId: ask.pendingId, outcome: sent ? 'sent' : 'not_sent' } satisfies DraftPayload);
}

async function sendDraftRow(e: OutboxEntry): Promise<void> {
  const p = e.payload as DraftPayload;
  const api = getApi();
  const settle = () => {
    if (st().draftEdits[p.id]?.clientId === p.clientId) overlayDraft(p.id, null, p.clientId);
  };
  try {
    if (p.op === 'patch') {
      const out = await api.patchDraft(p.id, { text: p.text });
      if (out.draft) putDrafts([out.pending_action ? { ...out.draft, pending_action_id: out.pending_action.id } : out.draft]);
    } else if (p.op === 'delete') {
      const out = await api.deleteDraft(p.id);
      if (out.draft) putDrafts([out.draft]);
    } else {
      const out = await api.pendingResult(p.pendingId, { outcome: p.outcome, client_id: p.clientId });
      if (out.draft) putDrafts([out.draft]);
    }
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 409 || err.status === 410)) {
      settle();
      void refreshDrafts();
      return;
    }
    if (!isRetryable(err)) settle();
    throw err;
  }
  settle();
}

/**
 * A profile from /sync has no БИН/ИИН and IBAN (kp.md «Sync»: only their last 4 digits). The phone
 * keeps its own full values when they end with those digits; else they wait for the online read.
 */
function mergeSyncedProfile(synced: CompanyProfileOut): CompanyProfileOut {
  if (!synced.secrets_masked) return synced;
  const mine = st().profile;
  const keep = (value: string | null | undefined, hint: string | null | undefined) =>
    value && hint && value.replace(/\s+/g, '').endsWith(hint.replace(/\D+/g, '')) ? value : null;
  return {
    ...synced,
    bin_iin: keep(mine?.bin_iin, synced.bin_iin_hint),
    bank: { ...synced.bank, iban: keep(mine?.bank.iban, synced.iban_hint) },
  };
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
      case 'kp.revert':
        return sendRevert(e);
      case 'kp.sent':
        return sendSent(e);
      case 'kp.draft':
        return sendDraftRow(e);
      default:
        return sendStatus(e);
    }
  },
  /** /sync `documents` (rows of the card file; `price_list_items` too if the server ever sends them). */
  apply(x: { documents: DocumentOut[]; prices: PriceItemOut[]; profile?: CompanyProfileOut | null; drafts?: DraftOut[]; priceLists?: PriceListOut[] }): void {
    for (const d of x.documents) putDocument(d);
    applyPrices(x.prices);
    if (x.priceLists?.length) putPriceLists(x.priceLists);
    // A synced profile replaces the copy read online (typing still waiting stays on top: `profileEdit`).
    if (x.profile && x.profile.version >= (st().profile?.version ?? 0)) set({ profile: mergeSyncedProfile(x.profile) });
    if (x.drafts) putDrafts(x.drafts);
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
    } else if (entity === 'price_list') {
      dropPriceList(id);
    } else if (entity === 'company_profile') {
      // «Отменить» removed a profile a PUT created: the phone has none either (typing still waiting stays).
      set({ profile: null });
      notifyDataChanged();
    } else if (entity === 'draft') {
      set({ drafts: without(st().drafts, id), draftEdits: without(st().draftEdits, id), draftAsks: without(st().draftAsks, id) });
      notifyDataChanged();
    }
  },
};

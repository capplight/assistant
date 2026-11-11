import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type {
  CompanyProfileOut,
  DealStatus,
  PriceListOut,
  DocumentOut,
  DraftOut,
  KpDataOut,
  KpFileFormat,
  KpSendChannel,
  KpSentChannel,
  KpVersionOut,
  KpVersionsOut,
  PastPriceOut,
  PriceItemOut,
} from '@/api/types';
import { persistStorage } from '@/store/storage';

/**
 * Week 14: КП on the phone (3-engineering 3.6, 6.7; 2-design S16–S19, S28). What the server last
 * said (the company profile, «Мой прайс», the КП) and the person's own changes still on their way,
 * which win until their outbox row is answered. So the profile, the prices and every tap-edit of a
 * price or a quantity work at once, offline and in «Без ИИ». Reading a spec and the PDF need the server.
 */

/** The profile fields the person types (S19). */
export type ProfileFields = Pick<CompanyProfileOut, 'name' | 'legal_form' | 'bin_iin' | 'address' | 'vat_payer'> & {
  phone: string | null;
  email: string | null;
  iban: string | null;
  bik: string | null;
  bank_name: string | null;
  kbe: string | null;
  /** Week 15 (the father's КП): the signer block, the licence line, where «Исх. №» goes on. */
  signer_name: string | null;
  signer_title: string | null;
  license_number: string | null;
  /** ISO `YYYY-MM-DD` (typed as «15.01.2020»). */
  license_date: string | null;
  license_category: string | null;
  /** The next outgoing number, as text («118»). */
  outgoing_next: string | null;
};

/** The phone's field → the server's key in `review_fields` (kp/profile.py: `bank.iban`, `contacts.phone`). */
export const REVIEW_KEY: Record<string, string> = {
  iban: 'bank.iban',
  bik: 'bank.bik',
  bank_name: 'bank.bank',
  kbe: 'bank.kbe',
  phone: 'contacts.phone',
  email: 'contacts.email',
};
export const reviewKey = (k: string) => REVIEW_KEY[k] ?? k;

export type ProfileImageRole = 'logo' | 'signature' | 'stamp';

/** A logo / signature / stamp picked on this phone: shown at once, uploaded when it can be. */
export type ProfileImage = { uri: string; mime: string; state: 'waiting' | 'sent' };

/** A spec on its way to a КП: the records (photo, PDF, text, voice) wait for their server ids, then POST /documents/kp. */
export type KpJob = {
  /** The `client_id` of POST /documents/kp. */
  id: string;
  recordIds: string[];
  /** `waiting`: records not on the server yet, or no internet · `reading`: KP_EXTRACT runs · `done` · `failed`. */
  state: 'waiting' | 'reading' | 'done' | 'failed';
  documentId: string | null;
  message: string | null;
  createdAt: string;
};

/** A tap-edit not confirmed yet: the data as shown, and the outbox rows still on their way. */
export type DocEdit = { data: KpDataOut; rows: string[] };

/**
 * Week 15: the last change made by a phrase («скидка 5% на кабель»), for the box «Изменил: …
 * [Что изменилось] [Отменить]» on S17. Gone once anything else changes the КП.
 */
export type PhraseChange = {
  text: string;
  /** The server's «Итого: 1 240 000 → 1 218 500 ₸» (or «Изменил КП»). */
  changeText: string;
  beforeN: number;
  n: number;
  actionId: string | null;
  changedPaths: string[];
  at: string;
};

/** Week 15: «Отправили?» [Да] on this phone, until the server has it. */
export type SentEdit = { n: number; channel: KpSentChannel; clientId: string; at: string };

/** Week 15: the S18 form of a КП, kept on the phone (the number never goes to the server, R-16). */
export type PendingSend = { n: number; channel: KpSentChannel; pendingId: string | null; at: string };

export type SendDraft = { text: string | null; phone: string; email: string; channel: KpSendChannel; format: KpFileFormat };

type State = {
  profile: CompanyProfileOut | null;
  /** Fields typed and not answered yet, with the `client_id` of the newest. */
  profileEdit: { fields: Partial<ProfileFields>; verified: string[]; clientId: string } | null;
  images: Partial<Record<ProfileImageRole, ProfileImage>>;
  /** By server id, or `local:<client_id>` until the server answers. */
  prices: Record<string, PriceItemOut>;
  /** Week 15: the price lists (/sync `price_lists`), by id. */
  priceLists: Record<string, PriceListOut>;
  /** Prices of past КП not in the list (S28 «Из прошлых КП»). */
  pastPrices: PastPriceOut[];
  priceAliases: Record<string, string>;
  pricesUpdatedAt: string | null;
  /** КП by server id. */
  docs: Record<string, DocumentOut>;
  /** The current version of each КП the phone opened (GET /documents/{id}); /sync brings rows only. */
  versions: Record<string, KpVersionOut>;
  /** S19 first: the server said the profile is not enough for a КП. */
  needsProfile: boolean;
  docEdits: Record<string, DocEdit>;
  /** A step on the status bar set by the person and not answered yet. */
  statusEdits: Record<string, { status: DealStatus; clientId: string }>;
  jobs: Record<string, KpJob>;
  /** Week 15: versions the phone has seen, by `<doc id>#<n>` (a version never changes once made). */
  oldVersions: Record<string, KpVersionOut>;
  /** Week 15: GET /documents/{id}/versions, by КП. */
  history: Record<string, KpVersionsOut>;
  phraseChanges: Record<string, PhraseChange>;
  sentEdits: Record<string, SentEdit>;
  sendDrafts: Record<string, SendDraft>;
  /** The file opened for sending and not answered «Отправили?» yet: its version and the server's pending send. */
  pendingSends: Record<string, PendingSend>;
  /** F-15: message drafts by server id (POST /drafts, /sync `drafts`). */
  drafts: Record<string, DraftOut>;
  /** A draft changed here and not answered yet (text typed, «Не надо», «Отправили? — Да»). */
  draftEdits: Record<string, { text?: string; status?: DraftOut['status']; clientId: string }>;
  /** A draft opened in WhatsApp / mail and not answered «Отправили?» yet. */
  draftAsks: Record<string, { pendingId: string; at: string }>;
  set: (p: Partial<Omit<State, 'set' | 'reset'>>) => void;
  reset: () => void;
};

const initial = {
  profile: null,
  profileEdit: null,
  images: {},
  prices: {},
  priceLists: {},
  pastPrices: [],
  priceAliases: {},
  pricesUpdatedAt: null,
  docs: {},
  versions: {},
  needsProfile: false,
  docEdits: {},
  statusEdits: {},
  jobs: {},
  oldVersions: {},
  history: {},
  phraseChanges: {},
  sentEdits: {},
  sendDrafts: {},
  pendingSends: {},
  drafts: {},
  draftEdits: {},
  draftAsks: {},
};

export const useKp = create<State>()(
  persist(
    (set) => ({
      ...initial,
      set: (p) => set(p),
      reset: () => set(initial),
    }),
    { name: 'kp.v1', storage: persistStorage, version: 1, partialize: ({ set: _s, reset: _r, ...rest }) => rest },
  ),
);

export const kpState = () => useKp.getState();

export const LOCAL_PRICE = 'local:';

const EMPTY_FIELDS: ProfileFields = {
  name: null,
  legal_form: null,
  bin_iin: null,
  address: null,
  phone: null,
  email: null,
  vat_payer: null,
  iban: null,
  bik: null,
  bank_name: null,
  kbe: null,
  signer_name: null,
  signer_title: null,
  license_number: null,
  license_date: null,
  license_category: null,
  outgoing_next: null,
};

/** The profile as the person sees it: their typing on top of the server's copy. */
export function shownProfile(s: Pick<State, 'profile' | 'profileEdit'>): ProfileFields & { review_fields: string[] } {
  const p = s.profile;
  const base: ProfileFields = p
    ? {
        name: p.name,
        legal_form: p.legal_form,
        bin_iin: p.bin_iin,
        address: p.address,
        phone: p.contacts.phone,
        email: p.contacts.email,
        vat_payer: p.vat_payer,
        iban: p.bank.iban,
        bik: p.bank.bik,
        bank_name: p.bank.bank,
        kbe: p.bank.kbe,
        signer_name: p.signer?.name ?? null,
        signer_title: p.signer?.title ?? null,
        license_number: p.license?.number ?? null,
        license_date: p.license?.date ?? null,
        license_category: p.license?.category ?? null,
        outgoing_next: p.outgoing?.next ? String(p.outgoing.next) : null,
      }
    : EMPTY_FIELDS;
  const edit = s.profileEdit;
  const touched = new Set(Object.keys(edit?.fields ?? {}).map(reviewKey));
  const review = (p?.review_fields ?? []).filter((k) => !edit?.verified.includes(k) && !touched.has(k));
  return { ...base, ...edit?.fields, review_fields: review };
}

/** A profile is enough for a КП: a name and a БИН/ИИН. */
export const profileReady = (f: Pick<ProfileFields, 'name' | 'bin_iin'>) => !!f.name?.trim() && !!f.bin_iin?.trim();

/** The КП data as shown: a tap-edit on its way wins over the server's version. */
export function shownData(docId: string, s: Pick<State, 'versions' | 'docEdits'>): KpDataOut | null {
  return s.docEdits[docId]?.data ?? s.versions[docId]?.data ?? null;
}

/** «Мой прайс» as shown, by name. */
export function shownPrices(prices: Record<string, PriceItemOut>): PriceItemOut[] {
  return Object.values(prices)
    .filter((p) => !p.deleted_at)
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export const versionKey = (docId: string, n: number) => `${docId}#${n}`;

/** A version the phone holds: the current one, or one seen before (versions are frozen once made). */
export function cachedVersion(docId: string, n: number, s: Pick<State, 'versions' | 'oldVersions'> = kpState()): KpVersionOut | null {
  const cur = s.versions[docId];
  if (cur && cur.n === n) return cur;
  return s.oldVersions[versionKey(docId, n)] ?? null;
}

/** The version sent to the client, as the phone knows it («Отправили?» [Да] here wins until the server has it). */
export function sentVersion(doc: Pick<DocumentOut, 'id' | 'sent_version_n'>, s: Pick<State, 'sentEdits'> = kpState()): number | null {
  const mine = s.sentEdits[doc.id]?.n ?? null;
  if (mine === null) return doc.sent_version_n;
  return doc.sent_version_n === null ? mine : Math.max(mine, doc.sent_version_n);
}

/** A draft as the person sees it: their change on its way on top of the server's copy. */
export function shownDraft(id: string, s: Pick<State, 'drafts' | 'draftEdits'> = kpState()): DraftOut | null {
  const d = s.drafts[id];
  if (!d) return null;
  const e = s.draftEdits[id];
  return e ? { ...d, ...(e.text !== undefined ? { text: e.text, review_fields: [] } : {}), ...(e.status ? { status: e.status } : {}) } : d;
}

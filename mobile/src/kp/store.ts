import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { CompanyProfileOut, DealStatus, DocumentOut, KpDataOut, KpVersionOut, PastPriceOut, PriceItemOut } from '@/api/types';
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

type State = {
  profile: CompanyProfileOut | null;
  /** Fields typed and not answered yet, with the `client_id` of the newest. */
  profileEdit: { fields: Partial<ProfileFields>; verified: string[]; clientId: string } | null;
  images: Partial<Record<ProfileImageRole, ProfileImage>>;
  /** By server id, or `local:<client_id>` until the server answers. */
  prices: Record<string, PriceItemOut>;
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
  set: (p: Partial<Omit<State, 'set' | 'reset'>>) => void;
  reset: () => void;
};

const initial = {
  profile: null,
  profileEdit: null,
  images: {},
  prices: {},
  pastPrices: [],
  priceAliases: {},
  pricesUpdatedAt: null,
  docs: {},
  versions: {},
  needsProfile: false,
  docEdits: {},
  statusEdits: {},
  jobs: {},
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

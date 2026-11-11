/**
 * Week 15 (founder 2026-11-11, R-16): the client's WhatsApp number from the phone's contacts, on
 * S18 and on a draft. The app explains in plain words before the system asks; denied → the number
 * is typed by hand as before. Only the one number the person picks is used and kept (in the S18
 * draft on this phone); the contact book is never read as a whole, stored or sent to the server.
 * Behind a small port, loaded lazily (`expo-contacts` needs a development build), so Jest never
 * touches a native module.
 */

export type ContactsAccess = 'granted' | 'denied' | 'undetermined';

/** The picked contact: its name and phone numbers only. */
export type PickedContact = { name: string | null; phones: { label: string | null; number: string }[] };

export type ContactsPort = {
  access(): Promise<ContactsAccess>;
  /** The system question; true when allowed. */
  ask(): Promise<boolean>;
  /** The system picker of one contact; null when the person closed it. */
  pick(): Promise<PickedContact | null>;
};

const nativeContacts: ContactsPort = {
  async access() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const C = require('expo-contacts') as typeof import('expo-contacts');
    const p = await C.getPermissionsAsync();
    return p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied';
  },
  async ask() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const C = require('expo-contacts') as typeof import('expo-contacts');
    return (await C.requestPermissionsAsync()).granted;
  },
  async pick() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const C = require('expo-contacts') as typeof import('expo-contacts');
    const c = await C.Contact.presentPicker();
    if (!c) return null;
    const [name, phones] = await Promise.all([c.getFullName().catch(() => null), c.getPhones()]);
    return {
      name: name || null,
      phones: phones.flatMap((p) => (p.number ? [{ label: p.label ?? null, number: p.number }] : [])),
    };
  },
};

let override: ContactsPort | null = null;

export const getContactsPort = (): ContactsPort => override ?? nativeContacts;

export function setContactsPortForTests(p: ContactsPort | null): void {
  override = p;
}

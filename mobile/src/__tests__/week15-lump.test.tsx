import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { kpFullOut } from '@/api/endpoints';
import { putFull } from '@/kp/service';
import { useKp } from '@/kp/store';
import { useUndo } from '@/store/undo';
import { happyServer } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle } from '@/testing/helpers';

/**
 * Week 15, the founder's father's КП (structure only; every value here is synthetic): lump-sum lines
 * «№ | Наименование | Объём | Стоимость, ₸», «Объём» free text, one amount, no VAT, «ИТОГО без
 * НДС»; quantity × price lines keep working. S19: signer, licence, outgoing number. Fake server only.
 */

const iso = () => new Date().toISOString();

const row = (extra: Record<string, unknown> = {}) => ({
  id: 'doc-l',
  item_id: 'srv-kp-l',
  kind: 'kp',
  title: 'КП № 7 · ТОО «Пример»',
  number: '7',
  date: '2026-11-11',
  client: { name: 'ТОО «Пример»' },
  currency: 'KZT',
  total: '1500000.00',
  missing_prices: 1,
  lines: 2,
  status: 'draft',
  deal_status: 'draft',
  current_version_n: 1,
  sent_version_n: null,
  ai_generated: true,
  version: 1,
  seq: 5,
  created_at: iso(),
  ...extra,
});

const version = () => ({
  n: 1,
  author: 'initial',
  created_at: iso(),
  data: { number: '7', date: '2026-11-11', currency: 'KZT', vat: { mode: 'none' }, discount_total_pct: '0', subject: 'на монтаж систем', outgoing: { number: '2026-12-1', date: '2026-11-11' }, terms: { validity_days: 60, conditions: ['Работы в рабочие дни'] } },
  client: { name: 'ТОО «Пример»', bin: null, contact: null, review: [] },
  items: [
    { id: 'i1', kind: 'lump', name: 'Монтаж систем', volume: '1 здание', qty: '1', unit_price: '1500000.00', discount_pct: '0', price_source: 'manual', price_label: '', review_fields: [], amount: '1500000.00' },
    { id: 'i2', kind: 'lump', name: 'Технический надзор', volume: 'на срок работ (40 дней)', qty: '1', unit_price: null, discount_pct: '0', price_source: 'missing', price_label: 'укажите цену', review_fields: [], amount: null },
  ],
  totals: { calc_version: 'kp-calc.v2', lines_sum: '1500000.00', discount_total: '0.00', amount: '1500000.00', net: '1500000.00', vat: '0.00', total: '1500000.00', vat_mode: 'none', vat_rate: null, rounding: 'on_total', priced: 1, missing: 1, complete: false },
  missing_required: ['total', 'amount_words'],
  ai_generated: true,
});

const text = (id: string) => {
  const c = screen.getByTestId(id).props.children;
  return Array.isArray(c) ? c.join('') : String(c);
};

describe('lump-sum lines (kp-calc.v2)', () => {
  it('decoders keep `kind`, «Объём» as text, the subject, «Исх. №» and «Условия»', () => {
    const v = kpFullOut({ document: row(), version: version() }).version!;
    expect(v.data.items.map((i) => [i.kind, i.volume])).toEqual([
      ['lump', '1 здание'],
      ['lump', 'на срок работ (40 дней)'],
    ]);
    expect(v.data).toMatchObject({ subject: 'на монтаж систем', outgoing: { number: '2026-12-1' }, conditions: ['Работы в рабочие дни'] });
    expect(kpFullOut({ document: row(), version: { ...version(), items: [{ id: 'x', name: 'Кабель', qty: '2', unit_price: '10' }] } }).version!.data.items[0]!.kind).toBe('qty');
  });

  it('S17 offline: «Объём» shown as text; the amount typed on the keys; «Итого без НДС» by code at once; a new lump line; «Отменить» drops it', async () => {
    const outbox = resetApp();
    finishOnboarding('full');
    putFull(kpFullOut({ document: row(), version: version(), needs_profile: false }));
    await renderRouter(APP_DIR, { initialUrl: '/kp/doc-l' });
    await settle(() => screen.queryByTestId('kp-line-1-price') !== null);
    expect(text('kp-line-0-volume')).toBe('Объём: 1 здание');
    expect(text('kp-line-0-calc')).toBe('Стоимость: 1 500 000 ₸');
    expect(text('kp-line-1-calc')).toBe('Стоимость: укажите');
    expect(screen.queryByTestId('kp-line-0-qty')).toBeNull(); // a lump sum has no quantity
    expect(screen.getByTestId('kp-line-1-price').props.accessibilityLabel).toBe('Изменить стоимость: Технический надзор');

    await fireEvent.press(screen.getByTestId('kp-line-1-price'));
    await settle(() => screen.queryByTestId('kp-edit') !== null);
    for (const k of ['2', '5', '0', '0', '0', '0']) await fireEvent.press(screen.getByTestId(`kp-edit-keys-${k}`));
    await fireEvent.press(screen.getByTestId('kp-edit-save'));
    await settle(() => outbox.all().some((r) => r.kind === 'kp.patch'));
    expect(text('kp-total')).toBe('Итого: 1 750 000 ₸');
    expect(screen.getByTestId('kp-sum-total').props.accessibilityLabel).toBe('Итого без НДС: 1 750 000 ₸');
    expect(outbox.all().find((r) => r.kind === 'kp.patch')!.payload).toMatchObject({ ops: [{ path: '/items/i2/unit_price', value: '250000.00' }] });

    await fireEvent.press(screen.getByTestId('kp-line-0-volume-edit'));
    await settle(() => screen.queryByTestId('kp-volume-input') !== null);
    await fireEvent.changeText(screen.getByTestId('kp-volume-input'), '2 здания');
    await fireEvent.press(screen.getByTestId('kp-volume-save'));
    await settle(() => outbox.all().filter((r) => r.kind === 'kp.patch').length === 2);
    expect(text('kp-line-0-volume')).toBe('Объём: 2 здания');
    expect(text('kp-total')).toBe('Итого: 1 750 000 ₸'); // text, never multiplied

    await fireEvent.press(screen.getByTestId('kp-add-line'));
    await settle(() => screen.queryByTestId('kp-add') !== null);
    expect(screen.getByTestId('kp-add-kind-lump').props.accessibilityState).toMatchObject({ checked: true });
    await fireEvent.changeText(screen.getByTestId('kp-add-name'), 'Пусконаладка');
    await fireEvent.changeText(screen.getByTestId('kp-add-volume'), '1 объект');
    await fireEvent.changeText(screen.getByTestId('kp-add-price'), '300 000');
    await fireEvent.press(screen.getByTestId('kp-add-save'));
    await settle(() => outbox.all().filter((r) => r.kind === 'kp.patch').length === 3);
    expect(text('kp-total')).toBe('Итого: 2 050 000 ₸');
    const add = outbox.all().filter((r) => r.kind === 'kp.patch')[2]!;
    expect(add.payload).toMatchObject({ ops: [{ op: 'add', path: '/items/-', value: { kind: 'lump', name: 'Пусконаладка', volume: '1 объект', unit_price: '300000.00' } }] });
    expect(screen.getByTestId('kp-line-2-price').props.accessibilityState).toMatchObject({ disabled: true }); // waits for the server's id

    const st = useUndo.getState().strip;
    if (st?.kind === 'custom') st.onUndo();
    await settle(() => screen.queryByTestId('kp-line-2') === null);
    expect(text('kp-total')).toBe('Итого: 1 750 000 ₸');
    expect((await outbox.get(add.id))!.status).toBe('failed'); // dropped, never sent
    expect(screen.getAllByText(/ИИ/)).toHaveLength(1);
  });

  it('a quantity × price line can still be added next to lump sums', async () => {
    const outbox = resetApp();
    finishOnboarding('no_ai');
    putFull(kpFullOut({ document: row(), version: version(), needs_profile: false }));
    await renderRouter(APP_DIR, { initialUrl: '/kp/doc-l' });
    await settle(() => screen.queryByTestId('kp-add-line') !== null);
    await fireEvent.press(screen.getByTestId('kp-add-line'));
    await settle(() => screen.queryByTestId('kp-add') !== null);
    await fireEvent.press(screen.getByTestId('kp-add-kind-qty'));
    await fireEvent.changeText(screen.getByTestId('kp-add-name'), 'Кабель');
    await fireEvent.changeText(screen.getByTestId('kp-add-qty'), '100');
    await fireEvent.changeText(screen.getByTestId('kp-add-unit'), 'м');
    await fireEvent.changeText(screen.getByTestId('kp-add-price'), '450');
    await fireEvent.press(screen.getByTestId('kp-add-save'));
    await settle(() => screen.queryByTestId('kp-line-2') !== null);
    expect(text('kp-line-2-calc')).toBe('100 м × 450 ₸ = 45 000 ₸');
    expect(useKp.getState().docEdits['doc-l']!.data.items[2]).toMatchObject({ kind: 'qty', qty: '100', unit_price: '450.00' });
    expect(outbox.all().filter((r) => r.kind === 'kp.patch')).toHaveLength(1); // a hand edit works in «Без ИИ» too
  });

  it('«Ввести цены подряд» names a lump line by its «Объём»', async () => {
    resetApp();
    finishOnboarding('full');
    putFull(kpFullOut({ document: row(), version: version(), needs_profile: false }));
    await renderRouter(APP_DIR, { initialUrl: '/kp/prices?doc=doc-l' });
    await settle(() => screen.queryByTestId('kp-fast-item') !== null);
    expect(text('kp-fast-item')).toBe('Технический надзор, на срок работ (40 дней)');
  });
});

describe('lump sums never go into «Мой прайс» (founder 2026-11-11)', () => {
  it('S17: no «Сохранить в прайс» for a lump amount, but still for a quantity × price line', async () => {
    const outbox = resetApp();
    finishOnboarding('full');
    const v = version();
    v.items.push({ id: 'i3', kind: 'qty', name: 'Кабель', volume: null, qty: '100', unit_price: null, discount_pct: '0', price_source: 'missing', price_label: 'укажите цену', review_fields: [], amount: null } as never);
    putFull(kpFullOut({ document: row(), version: v, needs_profile: false }));
    await renderRouter(APP_DIR, { initialUrl: '/kp/doc-l' });
    await settle(() => screen.queryByTestId('kp-line-1-price') !== null);
    await fireEvent.press(screen.getByTestId('kp-line-1-price'));
    await settle(() => screen.queryByTestId('kp-edit') !== null);
    expect(screen.queryByTestId('kp-edit-to-list')).toBeNull();
    for (const k of ['2', '5', '0', '0', '0', '0']) await fireEvent.press(screen.getByTestId(`kp-edit-keys-${k}`));
    await fireEvent.press(screen.getByTestId('kp-edit-save'));
    await settle(() => outbox.all().some((r) => r.kind === 'kp.patch'));
    expect(outbox.all().find((r) => r.kind === 'kp.patch')!.payload).not.toHaveProperty('savePrices');
    await fireEvent.press(screen.getByTestId('kp-line-2-price'));
    await settle(() => screen.queryByTestId('kp-edit-to-list') !== null);
  });

  it('«Ввести цены подряд»: no «Сохранить в прайс» on a lump line, savePrices never sent for it', async () => {
    const outbox = resetApp();
    finishOnboarding('full');
    putFull(kpFullOut({ document: row(), version: version(), needs_profile: false }));
    await renderRouter(APP_DIR, { initialUrl: '/kp/prices?doc=doc-l' });
    await settle(() => screen.queryByTestId('kp-fast-item') !== null);
    expect(screen.queryByTestId('kp-fast-to-list')).toBeNull();
    for (const k of ['2', '5', '0', '0', '0', '0']) await fireEvent.press(screen.getByTestId(`kp-fast-keys-${k}`));
    await fireEvent.press(screen.getByTestId('kp-fast-next'));
    await settle(() => outbox.all().some((r) => r.kind === 'kp.patch'));
    expect(outbox.all().find((r) => r.kind === 'kp.patch')!.payload).not.toHaveProperty('savePrices');
  });
});

describe('S19: signer, licence, outgoing number', () => {
  it('typed offline at once; online they go whole (`signer`, `license` with an ISO date, `outgoing.next`)', async () => {
    const s = happyServer();
    const bodies: Record<string, unknown>[] = [];
    s.on('GET /company-profile', () => ({ status: 200, body: { profile: { name: 'ТОО «Пример»', bin_iin: '000000000000', version: 2, complete: true, bank: {}, contacts: {}, signer: { name: 'Петров П. П.', title: 'Директор' }, license: {}, outgoing: { year: 2026, next: 12 } } } }))
      .on('PUT /company-profile', (c) => {
        bodies.push(c.body as Record<string, unknown>);
        return { status: 200, body: { profile: { name: 'ТОО «Пример»', bin_iin: '000000000000', version: 2 + bodies.length, complete: true, bank: {}, contacts: {}, signer: (c.body as { signer?: unknown }).signer ?? { name: 'Петров П. П.', title: 'Директор' }, license: (c.body as { license?: unknown }).license ?? useKp.getState().profile?.license ?? {}, outgoing: { year: 2026, next: 12 } }, action: null, repeated: false } };
      });
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    useKp.getState().set({
      profile: { name: 'ТОО «Пример»', legal_form: 'too', bin_iin: '000000000000', address: null, bank: { iban: null, bik: null, bank: null, kbe: null }, contacts: { phone: null, email: null, website: null }, vat_payer: false, logo_file_id: null, signature_file_id: null, stamp_file_id: null, review_fields: [], version: 2, complete: true, updated_at: null, signer: { name: 'Петров П. П.', title: 'Директор' }, license: { number: null, date: null, category: null }, outgoing: { year: 2026, next: 12 } },
    });
    await renderRouter(APP_DIR, { initialUrl: '/company' });
    await settle(() => screen.queryByTestId('company-signer_name') !== null && screen.getByTestId('company-signer_name').props.value === 'Петров П. П.');
    expect(screen.getByTestId('company-outgoing_next').props.value).toBe('12');
    await fireEvent.changeText(screen.getByTestId('company-license_number'), '00001');
    await fireEvent(screen.getByTestId('company-license_number'), 'endEditing');
    await settle(() => bodies.length === 1);
    expect(bodies[0]).toMatchObject({ license: { number: '00001', date: null, category: null } });
    await fireEvent.changeText(screen.getByTestId('company-license_date'), '15.01.2020');
    await fireEvent(screen.getByTestId('company-license_date'), 'endEditing');
    await settle(() => bodies.length === 2);
    expect(bodies[1]).toMatchObject({ license: { number: '00001', date: '2020-01-15' } });
    expect(screen.getByTestId('company-license_date').props.value).toBe('15.01.2020');
    await fireEvent.changeText(screen.getByTestId('company-signer_title'), 'Генеральный директор');
    await fireEvent(screen.getByTestId('company-signer_title'), 'endEditing');
    await settle(() => bodies.length === 3);
    expect(bodies[2]).toMatchObject({ signer: { name: 'Петров П. П.', title: 'Генеральный директор' } });
    expect(bodies[2]).not.toHaveProperty('signer_title');
  });
});

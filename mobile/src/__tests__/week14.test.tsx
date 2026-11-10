import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { Dimensions } from 'react-native';

import { documentOut, kpFullOut } from '@/api/endpoints';
import type { KpFullOut } from '@/api/types';
import { resolveView } from '@/components/page/registry';
import { putFull } from '@/kp/service';
import { setSharePortForTests } from '@/kp/share';
import { useKp } from '@/kp/store';
import { usePages } from '@/store/pages';
import { useUndo } from '@/store/undo';
import { happyServer, type FakeServer } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle } from '@/testing/helpers';

/**
 * Week 14: КП (docs/api/kp.md and routes/documents.py, kp.py as of 2026-11-10). Synthetic data
 * only (no real ТЗ, prices or requisites). Fake server only: nothing here ran against the real
 * server or on a phone (camera, share sheet, file download untested on a device).
 */

const iso = () => new Date().toISOString();

function row(extra: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    client_id: 'c-doc-1',
    item_id: 'srv-kp-1',
    kind: 'kp',
    title: 'КП № 14 · ТОО «Тест»',
    number: 'КП-2026-014',
    date: '2026-11-10',
    client: { name: 'ТОО «Тест»' },
    currency: 'KZT',
    total: '341000.00',
    vat_mode: 'included',
    missing_prices: 1,
    lines: 3,
    status: 'draft',
    deal_status: 'draft',
    deal_status_text: 'Черновик',
    current_version_n: 1,
    sent_version_n: null,
    progress: { state: 'done', done: 3, total: 3 },
    error: null,
    ai_generated: true,
    version: 1,
    seq: 10,
    created_at: iso(),
    updated_at: iso(),
    deleted_at: null,
    ...extra,
  };
}

/** The example of kp.md: two priced lines (one «та ли позиция?»), one with no price. */
function version(n = 1, i3Price: string | null = null) {
  const priced = i3Price !== null;
  const i3 = priced ? (Number(i3Price) * 4).toFixed(2) : null;
  const total = (225000 + 116000 + (priced ? Number(i3) : 0)).toFixed(2);
  return {
    n,
    author: n === 1 ? 'initial' : 'tap_edit',
    created_at: iso(),
    calc_version: 'kp-calc.v1',
    vat_rate: '16.00',
    vat_mode: 'included',
    changed_paths: priced ? ['/items/i3/unit_price', '/totals/total'] : [],
    data: { number: 'КП-2026-014', date: '2026-11-10', currency: 'KZT', vat: { mode: 'included' }, discount_total_pct: '0', terms: { validity_days: 10 } },
    client: { name: 'ТОО «Тест»', bin: '140540012345', contact: 'Ерлан', review: ['client.bin'] },
    items: [
      { id: 'i1', name: 'Кабель ВВГнг 3х2,5', unit: 'м', qty: '500', unit_price: '450.00', discount_pct: '0', price_source: 'price_list:pl#p1', price_review: false, matched_name: null, review_fields: [], price_label: 'из прайса «Прайс 2026»', amount: '225000.00' },
      { id: 'i2', name: 'Автомат 16А', unit: 'шт', qty: '40', unit_price: '2900.00', discount_pct: '0', price_source: 'price_list:pl#p2', price_review: true, matched_name: 'Автомат ВА47-29 16А', review_fields: ['qty'], price_label: 'из прайса: «Автомат ВА47-29 16А» — та ли позиция?', amount: '116000.00' },
      { id: 'i3', name: 'Щит ЩРН-24', unit: 'шт', qty: '4', unit_price: priced ? `${i3Price}.00` : null, discount_pct: '0', price_source: priced ? 'manual' : 'missing', price_review: false, matched_name: null, review_fields: [], price_label: priced ? '' : 'укажите цену', amount: i3 },
    ],
    totals: {
      calc_version: 'kp-calc.v1',
      lines_sum: total,
      discount_total: '0.00',
      amount: total,
      net: '0',
      vat: '0',
      total,
      vat_mode: 'included',
      vat_rate: '16.00',
      rounding: 'on_total',
      priced: priced ? 3 : 2,
      missing: priced ? 0 : 1,
      complete: priced,
    },
    valid_until: '2026-11-20',
    price_summary: { price_list: 2, past_kp: 0, manual: priced ? 1 : 0, missing: priced ? 0 : 1 },
    missing_required: priced ? [] : ['total', 'amount_words'],
    sent_at: null,
    ai_generated: true,
  };
}

const full = (v = version(), extra: Record<string, unknown> = {}) => ({ document: row(), version: v, needs_profile: false, ...extra });

const text = (id: string) => {
  const c = screen.getByTestId(id).props.children;
  return Array.isArray(c) ? c.join('') : String(c);
};
const stripText = () => {
  const st = useUndo.getState().strip;
  return st?.kind === 'custom' ? st.text : null;
};
const undo = () => {
  const st = useUndo.getState().strip;
  if (st?.kind === 'custom') st.onUndo();
};

function server(): FakeServer {
  const s = happyServer();
  s.on('GET /documents', () => ({ status: 200, body: { documents: [row()], next_before: null } }))
    .on('GET /documents/doc-1', () => ({ status: 200, body: full() }))
    .on('GET /company-profile', () => ({ status: 200, body: { profile: { name: null, bin_iin: null, version: 0, complete: false, bank: {}, contacts: {} } } }))
    .on('GET /price-lists/items', () => ({ status: 200, body: { items: [], next_offset: null } }))
    .on('GET /price-lists/history', () => ({ status: 200, body: { items: [] } }))
    .on('GET /page-templates', () => ({ status: 200, body: { templates: [] } }))
    .on('GET /collections', () => ({ status: 200, body: { collections: [] } }))
    .on('GET /duplicates/groups', () => ({ status: 200, body: { groups: [] } }));
  return s;
}

const docsPage = () => usePages.getState().addPage('documents') ?? usePages.getState().pages.find((p) => p.templateKey === 'documents')!;

afterEach(() => {
  setSharePortForTests(null);
  Dimensions.set({ window: { width: 390, height: 844, scale: 3, fontScale: 1 }, screen: { width: 390, height: 844, scale: 3, fontScale: 1 } });
});

describe('week 14 contract', () => {
  it('decoders follow kp.md: money stays text, every line keeps its price_source and label', () => {
    const out: KpFullOut = kpFullOut(full());
    expect(out.document).toMatchObject({ id: 'doc-1', item_id: 'srv-kp-1', deal_status: 'draft', total: '341000.00', missing_prices: 1, client_name: 'ТОО «Тест»' });
    const v = out.version!;
    expect(v.data.vat).toEqual({ mode: 'included', rate: '16.00', rounding: 'on_total' });
    expect(v.data.client.review).toEqual(['client.bin']);
    expect(v.data.items.map((i) => [i.price_source, i.unit_price, i.price_label])).toEqual([
      ['price_list:pl#p1', '450.00', 'из прайса «Прайс 2026»'],
      ['price_list:pl#p2', '2900.00', 'из прайса: «Автомат ВА47-29 16А» — та ли позиция?'],
      ['missing', null, 'укажите цену'],
    ]);
    expect(v.totals).toMatchObject({ total: '341000.00', missing: 1, complete: false });
    expect(documentOut({ id: 'x', deal_status: 'nonsense' })!.deal_status).toBe('draft');
  });

  it('«Документы и КП» plugs into PageFrame as the card file; «Простой список» stays', () => {
    resetApp();
    const p = docsPage();
    expect(resolveView(p).key).toBe('documents:builtin:kp');
    expect(resolveView({ ...p, layout: 'list' }).key).toBe('documents:list');
  });
});

describe('the card file', () => {
  it('a КП card: sum, mini-sheet, status strip; «Клиент принял?» [Да] offline at once with «Отменить»; no «ИИ» on the page', async () => {
    resetApp();
    finishOnboarding('full');
    const page = docsPage();
    putFull(kpFullOut(full(version(1, '18500'), { document: row({ total: '415000.00', missing_prices: 0 }) })));
    await renderRouter(APP_DIR, { initialUrl: `/page/${page.id}` });
    await settle(() => screen.queryByTestId('docs-kp-doc-1') !== null);
    expect(screen.getByTestId('page-view-documents:builtin:kp')).toBeTruthy();
    expect(screen.getByTestId('docs-new-kp')).toBeTruthy();
    expect(screen.getByTestId('docs-kp-doc-1-open').props.accessibilityLabel).toBe('КП № 14. 415 000 ₸. 10 нояб. Статус: Черновик');
    expect(screen.getByTestId('docs-kp-doc-1-status-draft-on')).toBeTruthy();
    expect(screen.queryByText(/ИИ/)).toBeNull();
    await fireEvent.press(screen.getByTestId('docs-kp-doc-1-status'));
    await settle(() => screen.queryByTestId('kp-status-sheet') !== null);
    await fireEvent.press(screen.getByTestId('kp-status-yes'));
    await settle(() => screen.queryByTestId('docs-kp-doc-1-status-accepted-on') !== null);
    expect(stripText()).toBe('Отметил: клиент принял');
    undo();
    await settle(() => screen.queryByTestId('docs-kp-doc-1-status-accepted-on') === null);
    expect(useKp.getState().statusEdits['doc-1']?.status).toBe('draft');
  });

  it('online: the step goes as POST /documents/{id}/status {deal_status}', async () => {
    const s = server();
    s.on('POST /documents/doc-1/status', (c) => ({ status: 200, body: { document: row({ deal_status: (c.body as { deal_status: string }).deal_status, seq: 20 }), action: null, repeated: false } }));
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    const page = docsPage();
    putFull(kpFullOut(full()));
    await renderRouter(APP_DIR, { initialUrl: `/page/${page.id}` });
    await settle(() => screen.queryByTestId('docs-kp-doc-1-status') !== null);
    await fireEvent.press(screen.getByTestId('docs-kp-doc-1-status'));
    await settle(() => screen.queryByTestId('kp-status-seen') !== null);
    await fireEvent.press(screen.getByTestId('kp-status-seen'));
    await settle(() => s.callsTo('POST /documents/doc-1/status').length === 1);
    expect(s.callsTo('POST /documents/doc-1/status')[0]!.body).toMatchObject({ deal_status: 'seen' });
    await settle(() => useKp.getState().docs['doc-1']!.deal_status === 'seen' && !useKp.getState().statusEdits['doc-1']);
  });

  it('«Без ИИ»: «Новое КП — нужен помощник» explains; the company and the price list stay open', async () => {
    resetApp();
    finishOnboarding('no_ai');
    const page = docsPage();
    await renderRouter(APP_DIR, { initialUrl: `/page/${page.id}` });
    await settle(() => screen.queryByTestId('docs-new-kp') !== null);
    expect(screen.getByText('Новое КП — нужен помощник')).toBeTruthy();
    expect(screen.getByTestId('docs-empty')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('docs-new-kp'));
    await settle(() => screen.queryByTestId('kp-no-ai') !== null);
    expect(screen.getByTestId('kp-no-ai-company')).toBeTruthy();
    expect(screen.getByTestId('kp-no-ai-prices')).toBeTruthy();
  });
});

describe('S17: preview and tap-edits', () => {
  it('offline: every price shows where it came from; a missing price is asked, typed on the keys, counted by code at once, with «Отменить»; the PDF says it needs the internet', async () => {
    const outbox = resetApp();
    finishOnboarding('full');
    putFull(kpFullOut(full()));
    await renderRouter(APP_DIR, { initialUrl: '/kp/doc-1' });
    await settle(() => screen.queryByTestId('kp-screen') !== null);
    expect(text('kp-total')).toBe('Итого: 341 000 ₸ с НДС');
    expect(text('kp-line-0-source')).toBe('из прайса «Прайс 2026»');
    expect(text('kp-line-1-source')).toBe('⚠ из прайса: «Автомат ВА47-29 16А» — та ли позиция?');
    expect(text('kp-line-2-source')).toBe('укажите цену');
    expect(screen.getByTestId('kp-line-1-check')).toBeTruthy(); // qty to check
    expect(text('kp-missing-count')).toBe('Нет цены: 1. Итог ещё не полный');
    expect(screen.getAllByText('Подготовил помощник (ИИ) по вашим записям — проверьте')).toHaveLength(1);

    await fireEvent.press(screen.getByTestId('kp-line-2-price'));
    await settle(() => screen.queryByTestId('kp-edit') !== null);
    for (const k of ['1', '8', '5', '0', '0']) await fireEvent.press(screen.getByTestId(`kp-edit-keys-${k}`));
    expect(text('kp-edit-display-text')).toBe('18 500 ₸');
    await fireEvent.press(screen.getByTestId('kp-edit-save'));
    await settle(() => outbox.all().some((r) => r.kind === 'kp.patch'));
    // 341 000 + 4 × 18 500 = 415 000, VAT 16% inside = 57 241,38 (by code, before the server answers).
    expect(text('kp-total')).toBe('Итого: 415 000 ₸ с НДС');
    expect(screen.getByTestId('kp-vat').props.accessibilityLabel).toBe('В том числе НДС 16%: 57 241,38 ₸');
    expect(text('kp-line-2-source')).toBe('вы указали');
    expect(text('kp-line-2-calc')).toBe('4 шт × 18 500 ₸ = 74 000 ₸');
    expect(screen.queryByTestId('kp-missing-count')).toBeNull();
    const row0 = outbox.all().find((r) => r.kind === 'kp.patch')!;
    expect(row0.payload).toMatchObject({ docId: 'doc-1', ops: [{ op: 'replace', path: '/items/i3/unit_price', value: '18500.00' }] });
    expect(stripText()).toBe('Цена: Щит ЩРН-24');

    await fireEvent.press(screen.getByTestId('kp-pdf'));
    await settle(() => screen.queryByTestId('kp-pdf-result') !== null);
    expect(text('kp-pdf-result')).toMatch(/нужен интернет/);

    undo();
    await settle(() => text('kp-total') === 'Итого: 341 000 ₸ с НДС');
    expect(text('kp-line-2-source')).toBe('укажите цену');
    expect((await outbox.get(row0.id))!.status).toBe('failed'); // dropped, never sent
  });

  it('online: the tap-edit goes with base_version and save_prices, the server version replaces the phone count; «Получить PDF» downloads with the session and opens the share sheet', async () => {
    const s = server();
    s.on('POST /documents/doc-1/patch', () => ({ status: 200, body: { ...full(version(2, '18500'), { document: row({ current_version_n: 2, total: '415000.00', missing_prices: 0, seq: 11 }) }), action: null, change_text: 'Итого: 341 000 → 415 000 ₸', price_offers: [], repeated: false } }))
      .on('POST /documents/doc-1/render', () => ({ status: 200, body: { file: { id: 'f1', mime: 'application/pdf', url: '/v1/documents/doc-1/files/f1', name: 'КП_ТОО_Тест_v2.pdf' }, version_n: 2, total: '415000.00', document: row({ status: 'ready', current_version_n: 2, seq: 12 }) } }));
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    const shared: { url: string; name: string; headers?: Record<string, string>; mime?: string }[] = [];
    setSharePortForTests({
      download: async (url, name, headers) => {
        shared.push({ url, name, headers });
        return `file:///cache/kp/${name}`;
      },
      share: async (uri, mime) => {
        shared.push({ url: uri, name: 'share', mime });
      },
    });
    putFull(kpFullOut(full()));
    await renderRouter(APP_DIR, { initialUrl: '/kp/doc-1' });
    await settle(() => screen.queryByTestId('kp-line-2-price') !== null);
    await fireEvent.press(screen.getByTestId('kp-line-2-price'));
    await settle(() => screen.queryByTestId('kp-edit') !== null);
    for (const k of ['1', '8', '5', '0', '0']) await fireEvent.press(screen.getByTestId(`kp-edit-keys-${k}`));
    await fireEvent.press(screen.getByTestId('kp-edit-save'));
    await settle(() => s.callsTo('POST /documents/doc-1/patch').length === 1);
    expect(s.callsTo('POST /documents/doc-1/patch')[0]!.body).toMatchObject({ base_version: 1, save_prices: true, ops: [{ path: '/items/i3/unit_price', value: '18500.00' }] });
    await settle(() => useKp.getState().versions['doc-1']?.n === 2 && !useKp.getState().docEdits['doc-1']);
    expect(text('kp-total')).toBe('Итого: 415 000 ₸ с НДС');

    await fireEvent.press(screen.getByTestId('kp-pdf'));
    await settle(() => shared.length === 2);
    expect(shared[0]).toMatchObject({ url: 'http://api.test/v1/documents/doc-1/files/f1', name: 'КП_ТОО_Тест_v2.pdf' });
    expect(shared[0]!.headers?.Authorization).toMatch(/^Bearer /);
    expect(shared[1]).toMatchObject({ url: 'file:///cache/kp/КП_ТОО_Тест_v2.pdf', mime: 'application/pdf' });
    await settle(() => screen.queryByTestId('kp-pdf-result') !== null);
    expect(text('kp-pdf-result')).toBe('PDF готов');
  });

  it('«Ввести цены подряд»: the lines with no price one after another, «Сохранить в прайс ☑» on', async () => {
    const outbox = resetApp();
    finishOnboarding('full');
    putFull(kpFullOut(full()));
    await renderRouter(APP_DIR, { initialUrl: '/kp/prices?doc=doc-1' });
    await settle(() => screen.queryByTestId('kp-fast-item') !== null);
    expect(text('kp-fast-progress')).toBe('1 из 1 без цены');
    expect(text('kp-fast-item')).toBe('Щит ЩРН-24, 4 шт');
    expect(screen.getByTestId('kp-fast-to-list').props.accessibilityState).toMatchObject({ checked: true });
    for (const k of ['1', '8', '5', '0', '0']) await fireEvent.press(screen.getByTestId(`kp-fast-keys-${k}`));
    await fireEvent.press(screen.getByTestId('kp-fast-next'));
    await settle(() => outbox.all().some((r) => r.kind === 'kp.patch'));
    expect(outbox.all().find((r) => r.kind === 'kp.patch')!.payload).toMatchObject({ savePrices: true, ops: [{ path: '/items/i3/unit_price', value: '18500.00' }] });
    expect(text('kp-fast-progress')).toBe('Все цены указаны');
  });
});

describe('S16: a КП from a spec', () => {
  it('typed spec → a record at once → POST /documents/kp → «Читаю ТЗ…» → «Что я понял» with the prices by source → [Сделать КП] opens S17', async () => {
    const s = server();
    let reads = 0;
    s.on('POST /documents/kp', (c) => ({ status: 202, body: { document: row({ client_id: (c.body as { client_id: string }).client_id, status: 'extracting', current_version_n: null, progress: { state: 'reading', done: 0, total: 3 } }), version: null, needs_profile: true, repeated: false } }))
      .on('GET /documents/doc-1', () => {
        reads++;
        return { status: 200, body: reads < 2 ? { document: row({ status: 'extracting', current_version_n: null }), version: null, needs_profile: true } : { ...full(), needs_profile: true } };
      });
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    useKp.getState().set({ profile: { name: 'ИП Тест', legal_form: 'ip', bin_iin: '000000000000', address: null, bank: { iban: null, bik: null, bank: null, kbe: null }, contacts: { phone: null, email: null, website: null }, vat_payer: true, logo_file_id: null, signature_file_id: null, stamp_file_id: null, review_fields: [], version: 1, complete: true, updated_at: null } });
    await renderRouter(APP_DIR, { initialUrl: '/kp/new' });
    await settle(() => screen.queryByTestId('kp-new-type') !== null);
    await fireEvent.press(screen.getByTestId('kp-new-type'));
    await fireEvent.changeText(screen.getByTestId('kp-new-text'), 'Кабель 500 м, автомат 16А 40 шт, щит 4 шт');
    await fireEvent.press(screen.getByTestId('kp-new-text-save'));
    await settle(() => s.callsTo('POST /documents/kp').length === 1);
    const body = s.callsTo('POST /documents/kp')[0]!.body as { item_ids: string[] };
    expect(body.item_ids).toHaveLength(1);
    expect(body.item_ids[0]).toMatch(/^srv-/);
    await settle(() => screen.queryByTestId('kp-new-make') !== null, 1000);
    expect(screen.getByText('2 — из прайса')).toBeTruthy();
    expect(text('kp-new-missing')).toBe('1 — нет цены');
    expect(screen.getByTestId('kp-new-bin-check')).toBeTruthy();
    expect(screen.getByTestId('kp-new-fast')).toBeTruthy();
    expect(screen.getByTestId('kp-new-needs-profile')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('kp-new-make'));
    await settle(() => screen.queryByTestId('kp-screen') !== null);
  });

  it('offline: the spec is kept and the person is told it will be read when online', async () => {
    resetApp();
    finishOnboarding('full');
    docsPage();
    useKp.getState().set({ profileEdit: { fields: { name: 'ИП Тест', bin_iin: '000000000000' }, verified: [], clientId: 'x' } });
    await renderRouter(APP_DIR, { initialUrl: '/kp/new' });
    await settle(() => screen.queryByTestId('kp-new-type') !== null);
    await fireEvent.press(screen.getByTestId('kp-new-type'));
    await fireEvent.changeText(screen.getByTestId('kp-new-text'), 'Розетка 10 шт');
    await fireEvent.press(screen.getByTestId('kp-new-text-save'));
    await settle(() => screen.queryByTestId('kp-new-job') !== null);
    expect(text('kp-new-job')).toBe('ТЗ сохранено. Прочитаю, когда появится интернет');
  });

  it('the first time without the company: «Сначала — ваша компания» → S19', async () => {
    resetApp();
    finishOnboarding('full');
    await renderRouter(APP_DIR, { initialUrl: '/kp/new' });
    await settle(() => screen.queryByTestId('kp-new-company') !== null);
    await fireEvent.press(screen.getByTestId('kp-new-company'));
    await settle(() => screen.queryByTestId('company-screen') !== null);
  });
});

describe('S19 «Моя компания» and S28 «Мой прайс» work offline', () => {
  it('a field typed offline is shown at once with «Отменить»; online the bank goes whole and «Верно» clears «проверьте»', async () => {
    const outbox = resetApp();
    finishOnboarding('full');
    useKp.getState().set({ profile: { name: 'ИП Тест', legal_form: 'ip', bin_iin: '000000000000', address: null, bank: { iban: 'KZ000000000000000001', bik: 'TESTKZKA', bank: 'Тест-Банк', kbe: '19' }, contacts: { phone: null, email: null, website: null }, vat_payer: false, logo_file_id: null, signature_file_id: null, stamp_file_id: null, review_fields: ['bin_iin'], version: 2, complete: true, updated_at: null } });
    await renderRouter(APP_DIR, { initialUrl: '/company' });
    await settle(() => screen.queryByTestId('company-kbe') !== null);
    expect(screen.getByTestId('company-images-kept')).toBeTruthy();
    expect(screen.getByTestId('company-bin_iin-check')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('company-kbe'), '17');
    await fireEvent(screen.getByTestId('company-kbe'), 'endEditing');
    await settle(() => outbox.all().some((r) => r.kind === 'kp.profile'));
    expect(screen.getByTestId('company-kbe').props.value).toBe('17');
    expect(stripText()).toBe('Сохранил');
    await fireEvent.press(screen.getByTestId('company-bin_iin-verify'));
    await settle(() => screen.queryByTestId('company-bin_iin-check') === null);
    expect(outbox.all().filter((r) => r.kind === 'kp.profile')).toHaveLength(2);
  });

  it('the profile body: the bank object whole, `review_fields` without the confirmed one', async () => {
    const s = server();
    const bodies: unknown[] = [];
    s.on('PUT /company-profile', (c) => {
      bodies.push(c.body);
      return { status: 200, body: { profile: { name: 'ИП Тест', bin_iin: '000000000000', version: 3 + bodies.length, complete: true, bank: { iban: 'KZ000000000000000001', bik: 'TESTKZKA', bank: 'Тест-Банк', kbe: '17' }, contacts: {}, review_fields: [] }, action: null, repeated: false } };
    });
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    useKp.getState().set({ profile: { name: 'ИП Тест', legal_form: 'ip', bin_iin: '000000000000', address: null, bank: { iban: 'KZ000000000000000001', bik: 'TESTKZKA', bank: 'Тест-Банк', kbe: '19' }, contacts: { phone: null, email: null, website: null }, vat_payer: false, logo_file_id: null, signature_file_id: null, stamp_file_id: null, review_fields: ['bin_iin', 'bank.iban'], version: 2, complete: true, updated_at: null } });
    s.on('GET /company-profile', () => ({ status: 200, body: { profile: useKp.getState().profile && { ...useKp.getState().profile, bank: { iban: 'KZ000000000000000001', bik: 'TESTKZKA', bank: 'Тест-Банк', kbe: '19' } } } }));
    await renderRouter(APP_DIR, { initialUrl: '/company' });
    await settle(() => screen.queryByTestId('company-kbe') !== null);
    await fireEvent.changeText(screen.getByTestId('company-kbe'), '17');
    await fireEvent(screen.getByTestId('company-kbe'), 'endEditing');
    await settle(() => bodies.length === 1);
    expect(bodies[0]).toMatchObject({ base_version: 2, bank: { iban: 'KZ000000000000000001', bik: 'TESTKZKA', bank: 'Тест-Банк', kbe: '17' } });
    expect(bodies[0]).not.toHaveProperty('kbe');
  });

  it('«Мой прайс» offline: «Добавить цену» → in the list at once, «Отменить» takes it out; nothing is sent', async () => {
    const outbox = resetApp();
    finishOnboarding('no_ai');
    await renderRouter(APP_DIR, { initialUrl: '/price-list' });
    await settle(() => screen.queryByTestId('prices-add') !== null);
    expect(screen.getByTestId('prices-empty')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('prices-add'));
    await settle(() => screen.queryByTestId('price-add') !== null);
    await fireEvent.changeText(screen.getByTestId('price-add-name'), 'Розетка двойная');
    await fireEvent.changeText(screen.getByTestId('price-add-unit'), 'шт');
    await fireEvent.changeText(screen.getByTestId('price-add-price'), '1 200');
    await fireEvent.press(screen.getByTestId('price-add-save'));
    await fireEvent.press(screen.getByTestId('price-add-close'));
    await settle(() => screen.queryByTestId('price-Розетка двойная') !== null);
    expect(screen.getByTestId('price-Розетка двойная').props.accessibilityLabel).toMatch(/^Розетка двойная\. 1 200 ₸ за шт\./);
    expect(stripText()).toBe('Добавил в прайс: 1');
    await settle(() => outbox.all().some((r) => r.kind === 'kp.prices'));
    undo();
    await settle(() => screen.queryByTestId('price-Розетка двойная') === null);
  });
});

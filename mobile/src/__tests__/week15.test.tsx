import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { kpEditOut, kpFullOut, kpSendOut, kpVersionsOut, messageDraftOut, sendExecuteOut } from '@/api/endpoints';
import { describeChange, kpSink, putFull } from '@/kp/service';
import { setContactsPortForTests, type ContactsAccess, type PickedContact } from '@/kp/contacts';
import { setSharePortForTests, type MailDraft } from '@/kp/share';
import { useKp } from '@/kp/store';
import { useUndo } from '@/store/undo';
import { happyServer, type FakeServer } from '@/testing/fakeServer';
import { getSyncEngine } from '@/services';
import { APP_DIR, finishOnboarding, resetApp, settle } from '@/testing/helpers';

/**
 * Week 15: phrase edits, versions, DOCX, sending (S18), drafts (docs/api/kp.md «Week 15»,
 * routes/documents.py, drafts.py, duplicates.py as of 2026-11-11). Synthetic data only. Fake
 * server only: nothing here ran against the real server or on a phone (share sheet, mail app,
 * WhatsApp untested on a device).
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
    missing_prices: 0,
    lines: 2,
    status: 'draft',
    deal_status: 'draft',
    current_version_n: 1,
    sent_version_n: null,
    sent_at: null,
    progress: { state: 'done', done: 2, total: 2 },
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

/** Two priced lines; `discount` makes the second one cheaper (as a phrase edit would). */
function version(n = 1, o: { discount?: string; delivery?: boolean } = {}) {
  const i2 = o.discount ? '110200.00' : '116000.00';
  const lines = [
    { id: 'i1', name: 'Кабель ВВГнг 3х2,5', unit: 'м', qty: '500', unit_price: '450.00', discount_pct: '0', price_source: 'price_list:pl#p1', price_review: false, review_fields: [], price_label: 'из прайса', amount: '225000.00' },
    { id: 'i2', name: 'Автомат 16А', unit: 'шт', qty: '40', unit_price: '2900.00', discount_pct: o.discount ?? '0', price_source: 'price_list:pl#p2', price_review: false, review_fields: [], price_label: 'из прайса', amount: i2 },
  ];
  if (o.delivery) lines.push({ id: 'i3', name: 'Доставка', unit: 'рейс', qty: '1', unit_price: '15000.00', discount_pct: '0', price_source: 'manual', price_review: false, review_fields: [], price_label: '', amount: '15000.00' });
  const total = (225000 + Number(i2) + (o.delivery ? 15000 : 0)).toFixed(2);
  return {
    n,
    author: n === 1 ? 'initial' : 'agent_request',
    request_text: n === 1 ? null : 'скидка 5% на автомат',
    created_at: iso(),
    vat_rate: '16.00',
    vat_mode: 'included',
    changed_paths: o.discount ? ['/items/i2/discount_pct', '/totals/total'] : [],
    data: { number: 'КП-2026-014', date: '2026-11-10', currency: 'KZT', vat: { mode: 'included' }, discount_total_pct: '0', terms: { validity_days: 10 } },
    client: { name: 'ТОО «Тест»', bin: '000000000000', contact: 'Ерлан', review: [] },
    items: lines,
    totals: { lines_sum: total, discount_total: '0.00', amount: total, net: '0', vat: '0', total, vat_rate: '16.00', rounding: 'on_total', priced: lines.length, missing: 0, complete: true },
    missing_required: [],
    sent_at: null,
    frozen: false,
    ai_generated: true,
  };
}

const full = (v = version(), extra: Record<string, unknown> = {}) => ({ document: row(), version: v, needs_profile: false, ...extra });

const text = (id: string) => {
  const c = screen.getByTestId(id).props.children;
  return Array.isArray(c) ? c.join('') : String(c);
};

type Shared = { download: { url: string; name: string; headers?: Record<string, string> }[]; shared: { uri: string; mime: string }[]; mails: MailDraft[]; urls: string[] };

function sharePort(o: { mail?: 'sent' | 'unavailable' } = {}): Shared {
  const log: Shared = { download: [], shared: [], mails: [], urls: [] };
  setSharePortForTests({
    download: async (url, name, headers) => {
      log.download.push({ url, name, headers });
      return `file:///cache/kp/${name}`;
    },
    share: async (uri, mime) => {
      log.shared.push({ uri, mime });
    },
    mail: async (d) => {
      log.mails.push(d);
      return o.mail ?? 'sent';
    },
    openUrl: async (url) => {
      log.urls.push(url);
      return true;
    },
  });
  return log;
}

function server(): FakeServer {
  return happyServer()
    .on('GET /documents/doc-1', () => ({ status: 200, body: full() }))
    .on('GET /documents', () => ({ status: 200, body: { documents: [row()], next_before: null } }))
    .on('GET /page-templates', () => ({ status: 200, body: { templates: [] } }))
    .on('GET /collections', () => ({ status: 200, body: { collections: [] } }))
    .on('GET /duplicates/groups', () => ({ status: 200, body: { groups: [] } }));
}

afterEach(() => {
  setSharePortForTests(null);
  setContactsPortForTests(null);
});

/** A fake contact book: what the picker returns, and every question the system was asked. */
function contacts(access: ContactsAccess, picked: PickedContact | null, allow = true) {
  const log = { asked: 0, picked: 0 };
  setContactsPortForTests({
    access: async () => access,
    ask: async () => {
      log.asked++;
      return allow;
    },
    pick: async () => {
      log.picked++;
      return picked;
    },
  });
  return log;
}

describe('week 15 contract', () => {
  it('decoders follow kp.md: edit status, versions, send, execute, draft', () => {
    expect(kpEditOut({ ...full(), status: 'refused', message: 'Не могу посчитать это сам', refused: [{ path: '/items/i1/unit_price', reason: 'number_not_said' }] })).toMatchObject({
      status: 'refused',
      message: 'Не могу посчитать это сам',
      refused: [{ reason: 'number_not_said' }],
    });
    const vs = kpVersionsOut({ versions: [{ n: 1, author: 'initial', total: '1.00', frozen: true, sent_at: iso() }, { n: 2, author: 'agent_request', request_text: 'скидка 5%', current: true }], sent_version_n: 1 });
    expect(vs.versions.map((v) => [v.n, v.frozen, v.current])).toEqual([
      [2, false, true],
      [1, true, false],
    ]);
    const send = kpSendOut({
      pending_action: { id: 'pa-1', kind: 'send_whatsapp_file', status: 'proposed', preview: {} },
      file: { url: '/v1/documents/doc-1/files/f1', name: 'КП_v1.pdf', mime: 'application/pdf' },
      version_n: 1,
      resend: { sent_version_n: 1, sent_at: iso(), text: 'Клиент видел v1. Отправить новую?' },
    });
    expect(send).toMatchObject({ version_n: 1, file: { name: 'КП_v1.pdf' }, resend: { sent_version_n: 1 } });
    expect(sendExecuteOut({ kind: 'email', file: null, text: 'Добрый день', subject: 'КП', wa_url_template: 'https://wa.me/{phone}?text=x' })).toMatchObject({ kind: 'email', subject: 'КП' });
    expect(sendExecuteOut({ kind: 'nonsense' })).toBeNull();
    expect(messageDraftOut({ id: 'd1', text: 'Текст', channel: 'email', status: 'draft' })).toMatchObject({ channel: 'email', status: 'draft', ai_generated: true });
  });

  it('«Что изменилось» says the change line by line from the two versions, counting nothing', () => {
    const before = kpFullOut(full()).version!.data;
    const after = kpFullOut(full(version(2, { discount: '5', delivery: true }))).version!.data;
    expect(describeChange(before, after).map((r) => r.text)).toEqual(['Автомат 16А: скидка 0% → 5%', 'Добавил: Доставка, 1 рейс × 15 000 ₸']);
  });

  it('a profile from /sync without БИН/IBAN keeps the phone’s full values when the last digits agree', () => {
    resetApp();
    useKp.getState().set({
      profile: { name: 'ИП Тест', legal_form: 'ip', bin_iin: '000000009013', address: null, bank: { iban: 'KZ000000000000000100', bik: null, bank: null, kbe: null }, contacts: { phone: null, email: null, website: null }, vat_payer: false, logo_file_id: null, signature_file_id: null, stamp_file_id: null, review_fields: [], version: 1, complete: true, updated_at: null },
    });
    kpSink.apply({
      documents: [],
      prices: [],
      profile: { name: 'ИП Тест 2', legal_form: 'ip', bin_iin: null, address: null, bank: { iban: null, bik: null, bank: null, kbe: null }, contacts: { phone: null, email: null, website: null }, vat_payer: false, logo_file_id: null, signature_file_id: null, stamp_file_id: null, review_fields: [], version: 2, complete: true, updated_at: null, secrets_masked: true, bin_iin_hint: '…9013', iban_hint: '…0999' },
    });
    const p = useKp.getState().profile!;
    expect(p.name).toBe('ИП Тест 2');
    expect(p.bin_iin).toBe('000000009013');
    expect(p.bank.iban).toBeNull(); // another account now: read online
  });
});

describe('S17: a change by a phrase', () => {
  it('online: applied at once, lit, «Изменил: … Итого …», «Что изменилось», «Отменить» = the action undo', async () => {
    const s = server();
    s.on('POST /documents/doc-1/edit', () => ({
      status: 200,
      body: { ...full(version(2, { discount: '5' }), { document: row({ current_version_n: 2, total: '335200.00', seq: 11 }) }), status: 'applied', action: { id: 'act-1', kind: 'edit_kp', summary: { ru: 'Изменил КП' }, undoable: true }, change_text: 'Итого: 341 000 → 335 200 ₸', price_offers: [], message: null, refused: [], repeated: false },
    })).on('POST /actions/act-1/undo', () => ({ status: 200, body: { action: { id: 'act-1', kind: 'edit_kp', summary: { ru: 'Изменил КП' } }, undo: null, partial: false, page_patches: [] } }));
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    putFull(kpFullOut(full()));
    await renderRouter(APP_DIR, { initialUrl: '/kp/doc-1' });
    await settle(() => screen.queryByTestId('kp-phrase-input') !== null);
    await fireEvent.changeText(screen.getByTestId('kp-phrase-input'), 'скидка 5% на автомат');
    await fireEvent.press(screen.getByTestId('kp-phrase-send'));
    await settle(() => screen.queryByTestId('kp-change') !== null);
    expect(s.callsTo('POST /documents/doc-1/edit')[0]!.body).toMatchObject({ base_version: 1, text: 'скидка 5% на автомат' });
    expect(text('kp-change-text')).toBe('Изменил: скидка 5% на автомат. Итого: 341 000 → 335 200 ₸');
    expect(text('kp-total')).toBe('Итого: 335 200 ₸ с НДС');
    expect(screen.getByTestId('kp-line-1').props.style.backgroundColor).toBeDefined(); // lit for 600 ms
    await fireEvent.press(screen.getByTestId('kp-change-what'));
    expect(text('kp-change-row-disc-i2')).toBe('• Автомат 16А: скидка 0% → 5%');
    await fireEvent.press(screen.getByTestId('kp-change-undo'));
    await settle(() => s.callsTo('POST /actions/act-1/undo').length === 1);
    await settle(() => screen.queryByTestId('kp-change') === null);
  });

  it('nothing changed: the server’s words, the phrase stays in the field', async () => {
    const s = server();
    s.on('POST /documents/doc-1/edit', () => ({ status: 200, body: { ...full(), status: 'refused', action: null, message: 'Не могу посчитать это сам — скажите число', refused: [{ path: '/items/i1/unit_price', reason: 'number_not_said' }] } }));
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    putFull(kpFullOut(full()));
    await renderRouter(APP_DIR, { initialUrl: '/kp/doc-1' });
    await settle(() => screen.queryByTestId('kp-phrase-input') !== null);
    await fireEvent.changeText(screen.getByTestId('kp-phrase-input'), 'подними цену кабеля на 10%');
    await fireEvent.press(screen.getByTestId('kp-phrase-send'));
    await settle(() => screen.queryByTestId('kp-phrase-note') !== null);
    expect(text('kp-phrase-note')).toBe('Не могу посчитать это сам — скажите число');
    expect(screen.getByTestId('kp-phrase-input').props.value).toBe('подними цену кабеля на 10%');
    expect(useKp.getState().versions['doc-1']!.n).toBe(1);
  });

  it('offline: the phrase is not queued, the person is told; «Без ИИ»: no phrase line, hand edits stay', async () => {
    const outbox = resetApp();
    finishOnboarding('full');
    putFull(kpFullOut(full()));
    await renderRouter(APP_DIR, { initialUrl: '/kp/doc-1' });
    await settle(() => screen.queryByTestId('kp-phrase-input') !== null);
    await fireEvent.changeText(screen.getByTestId('kp-phrase-input'), 'убери доставку');
    await fireEvent.press(screen.getByTestId('kp-phrase-send'));
    await settle(() => screen.queryByTestId('kp-phrase-note') !== null);
    expect(text('kp-phrase-note')).toMatch(/только с интернетом/);
    expect(outbox.all().filter((r) => r.kind.startsWith('kp.'))).toHaveLength(0);
  });

  it('«Без ИИ»: the line says the assistant is off; the price keys still work', async () => {
    resetApp();
    finishOnboarding('no_ai');
    putFull(kpFullOut(full()));
    await renderRouter(APP_DIR, { initialUrl: '/kp/doc-1' });
    await settle(() => screen.queryByTestId('kp-phrase-no-ai') !== null);
    expect(screen.queryByTestId('kp-phrase-input')).toBeNull();
    expect(screen.getByTestId('kp-line-0-price')).toBeTruthy();
    expect(screen.getAllByText(/ИИ/)).toHaveLength(1); // the single label of the КП
  });
});

describe('versions', () => {
  it('the list marks the sent one; a version opens read only; «Вернуть эту» offline (held) at once with «Отменить»', async () => {
    const outbox = resetApp();
    finishOnboarding('full');
    putFull(kpFullOut(full()));
    putFull(kpFullOut(full(version(2, { discount: '5' }), { document: row({ current_version_n: 2, sent_version_n: 1, total: '335200.00', seq: 12 }) })));
    await renderRouter(APP_DIR, { initialUrl: '/kp/versions?doc=doc-1' });
    await settle(() => screen.queryByTestId('kp-v-1') !== null);
    expect(screen.getByTestId('kp-versions-offline')).toBeTruthy();
    expect(screen.getByTestId('kp-v-2').props.accessibilityLabel).toMatch(/^Версия 2 · сейчас\./);
    expect(screen.getByTestId('kp-v-1').props.accessibilityLabel).toMatch(/^Версия 1 · отправлено/);
    await fireEvent.press(screen.getByTestId('kp-v-1'));
    await settle(() => screen.queryByTestId('kp-version-revert') !== null);
    expect(screen.getByTestId('kp-version-frozen')).toBeTruthy();
    expect(text('kp-version-total')).toBe('Итого: 341 000 ₸ с НДС');
    await fireEvent.press(screen.getByTestId('kp-version-revert'));
    await settle(() => screen.queryByTestId('kp-screen') !== null);
    expect(text('kp-total')).toBe('Итого: 341 000 ₸ с НДС');
    const r = outbox.all().find((x) => x.kind === 'kp.revert')!;
    expect(r.payload).toMatchObject({ docId: 'doc-1', n: 1 });
    const st = useUndo.getState().strip;
    expect(st?.kind === 'custom' && st.text).toBe('Вернул версию 1');
    if (st?.kind === 'custom') st.onUndo();
    await settle(() => text('kp-total') === 'Итого: 335 200 ₸ с НДС');
    expect((await outbox.get(r.id))!.status).toBe('failed'); // dropped, never sent
  });

  it('«Сделать в Word» is on S17 itself: render?format=docx, the file into «Поделиться»', async () => {
    const s = server();
    s.on('POST /documents/doc-1/render', (c) => ({
      status: 200,
      body: { file: { id: 'f2', url: '/v1/documents/doc-1/files/f2', name: `КП_v1.${c.query.format}`, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, version_n: 1, total: '341000.00', document: row() },
    }));
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    const log = sharePort();
    putFull(kpFullOut(full()));
    await renderRouter(APP_DIR, { initialUrl: '/kp/doc-1' });
    await settle(() => screen.queryByTestId('kp-docx') !== null);
    await fireEvent.press(screen.getByTestId('kp-docx'));
    await settle(() => log.shared.length === 1);
    expect(s.callsTo('POST /documents/doc-1/render')[0]!.query).toMatchObject({ format: 'docx' });
    expect(log.shared[0]!.mime).toMatch(/wordprocessingml/);
    await settle(() => screen.queryByTestId('kp-pdf-result') !== null);
    expect(text('kp-pdf-result')).toBe('Файл Word готов');
  });
});

describe('S18: confirmation, «Открыть WhatsApp», «Отправили?»', () => {
  function sendServer() {
    const s = server();
    s.on('POST /documents/doc-1/send', (c) => ({
      status: 200,
      body: {
        pending_action: { id: 'pa-1', kind: 'send_whatsapp_file', status: 'proposed', preview: {} },
        file: { url: '/v1/documents/doc-1/files/f1', name: `КП_ТОО_Тест_v1.${(c.body as { format: string }).format}`, mime: 'application/pdf' },
        version_n: 1,
        resend: null,
        message: (c.body as { message: string }).message,
        hint: null,
        document: row(),
        repeated: false,
      },
    }))
      .on('POST /pending-actions/pa-1/confirm', () => ({
        status: 200,
        body: { pending_action: { id: 'pa-1', status: 'confirmed', kind: 'send_whatsapp_file' }, action: null, execute: { kind: 'share_file', file: { url: '/v1/documents/doc-1/files/f1', name: 'КП_ТОО_Тест_v1.pdf', mime: 'application/pdf' }, text: 'x', subject: 'КП', wa_url_template: 'https://wa.me/{phone}?text=x', hint: null } },
      }))
      .on('POST /documents/doc-1/versions/1/sent', () => ({ status: 200, body: { ...full(), document: row({ sent_version_n: 1, status: 'sent', deal_status: 'sent', sent_at: iso(), seq: 30 }), action: { id: 'act-s', kind: 'send_external', undoable: false } } }))
      .on('POST /pending-actions/pa-1/result', () => ({ status: 200, body: { pending_action: { id: 'pa-1', status: 'cancelled_by_user' }, action: null } }));
    return s;
  }

  it('the screen shows the file, the server’s sum, to whom, the text; [Открыть WhatsApp] → send + confirm → the file with the session → the sheet; [Да] marks v1 sent', async () => {
    const s = sendServer();
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    const log = sharePort();
    putFull(kpFullOut(full()));
    await renderRouter(APP_DIR, { initialUrl: '/kp/send?doc=doc-1' });
    await settle(() => screen.queryByTestId('kp-send-open') !== null);
    expect(text('kp-send-total')).toBe('Сумма: 341 000 ₸');
    expect(text('kp-send-client')).toBe('ТОО «Тест»');
    expect(screen.getByTestId('kp-send-text').props.value).toBe('Добрый день, Ерлан!\nНаправляю коммерческое предложение № 14 на сумму 341 000 ₸.');
    expect(screen.getByText('Откроется WhatsApp — выберите чат «Ерлан» и нажмите ➤')).toBeTruthy();
    expect(screen.queryByText(/ИИ/)).toBeNull();
    await fireEvent.press(screen.getByTestId('kp-send-open'));
    await settle(() => log.shared.length === 1);
    expect(s.callsTo('POST /documents/doc-1/send')[0]!.body).toMatchObject({ n: 1, channel: 'whatsapp', format: 'pdf', recipient_name: 'Ерлан' });
    expect(JSON.stringify(s.callsTo('POST /documents/doc-1/send')[0]!.body)).not.toMatch(/\+7|phone/);
    expect(s.callsTo('POST /pending-actions/pa-1/confirm')).toHaveLength(1);
    expect(log.download[0]!.headers?.Authorization).toMatch(/^Bearer /);
    await settle(() => screen.queryByTestId('kp-send-did') !== null);
    await fireEvent.press(screen.getByTestId('kp-send-did-yes'));
    await settle(() => s.callsTo('POST /documents/doc-1/versions/1/sent').length === 1);
    expect(s.callsTo('POST /documents/doc-1/versions/1/sent')[0]!.body).toMatchObject({ channel: 'whatsapp_share', pending_action_id: 'pa-1' });
    expect(screen.getByText('Отправлено, отменить нельзя')).toBeTruthy();
    await settle(() => useKp.getState().docs['doc-1']!.sent_version_n === 1);
  });

  it('[Нет]: nothing is marked; the pending send is closed as not_sent', async () => {
    const s = sendServer();
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    sharePort();
    putFull(kpFullOut(full()));
    await renderRouter(APP_DIR, { initialUrl: '/kp/send?doc=doc-1' });
    await settle(() => screen.queryByTestId('kp-send-open') !== null);
    await fireEvent.press(screen.getByTestId('kp-send-open'));
    await settle(() => screen.queryByTestId('kp-send-did') !== null);
    await fireEvent.press(screen.getByTestId('kp-send-did-no'));
    await settle(() => s.callsTo('POST /pending-actions/pa-1/result').length === 1);
    expect(s.callsTo('POST /pending-actions/pa-1/result')[0]!.body).toMatchObject({ outcome: 'not_sent' });
    expect(s.callsTo('POST /documents/doc-1/versions/1/sent')).toHaveLength(0);
    expect(useKp.getState().sentEdits['doc-1']).toBeUndefined();
  });

  it('mail: the mail app with the file attached; Word when chosen', async () => {
    const s = sendServer();
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    const log = sharePort();
    putFull(kpFullOut(full()));
    await renderRouter(APP_DIR, { initialUrl: '/kp/send?doc=doc-1' });
    await settle(() => screen.queryByTestId('kp-send-channel-email') !== null);
    await fireEvent.press(screen.getByTestId('kp-send-channel-email'));
    await fireEvent.press(screen.getByTestId('kp-send-format-docx'));
    await fireEvent.changeText(screen.getByTestId('kp-send-email'), 'client@example.test');
    expect(screen.getByTestId('kp-send-open').props.accessibilityLabel).toBe('Открыть почту');
    await fireEvent.press(screen.getByTestId('kp-send-open'));
    await settle(() => log.mails.length === 1);
    expect(s.callsTo('POST /documents/doc-1/send')[0]!.body).toMatchObject({ channel: 'email', format: 'docx' });
    expect(log.mails[0]).toMatchObject({ recipients: ['client@example.test'], attachments: ['file:///cache/kp/КП_ТОО_Тест_v1.pdf'] });
  });

  it('after an edit of a sent КП: «Клиент видел v1. Отправить новую?»; offline the file says it needs the internet, the text alone opens wa.me with the typed number', async () => {
    resetApp();
    finishOnboarding('full');
    const log = sharePort();
    putFull(kpFullOut(full(version(2, { discount: '5' }), { document: row({ current_version_n: 2, sent_version_n: 1 }) })));
    await renderRouter(APP_DIR, { initialUrl: '/kp/send?doc=doc-1' });
    await settle(() => screen.queryByTestId('kp-send-saw') !== null);
    expect(screen.getByText('Клиент видел v1. Отправить новую?')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('kp-send-open'));
    await settle(() => screen.queryByTestId('kp-send-problem') !== null);
    expect(text('kp-send-problem')).toMatch(/нужен интернет/);
    await fireEvent.changeText(screen.getByTestId('kp-send-phone'), '8 701 000 00 00');
    await fireEvent.press(screen.getByTestId('kp-send-text-only'));
    await settle(() => log.urls.length === 1);
    expect(log.urls[0]).toMatch(/^https:\/\/wa\.me\/77010000000\?text=%D0%94/);
    expect(useKp.getState().sendDrafts['doc-1']!.phone).toBe('8 701 000 00 00'); // kept on this phone only
  });
});

describe('drafts (F-15)', () => {
  it('«Написать клиенту» → POST /drafts with the КП → the draft with the «ИИ» label → [Открыть WhatsApp] → wa.me → «Отправили?» [Да]', async () => {
    const draft = { id: 'dr-1', client_id: 'x', channel: 'whatsapp', recipient_name: 'Ерлан', subject: null, text: 'Добрый день, Ерлан! КП будет в пятницу.', request_text: 'что КП будет в пятницу', document_id: 'doc-1', status: 'draft', review_fields: [], pending_action_id: 'pa-d', ai_generated: true, sent_at: null, version: 1, seq: 40 };
    const s = server();
    s.on('POST /drafts', () => ({ status: 201, body: { draft, pending_action: { id: 'pa-d', kind: 'send_whatsapp_text', status: 'proposed', preview: {} }, labels: {}, repeated: false } }))
      .on('POST /pending-actions/pa-d/confirm', () => ({ status: 200, body: { pending_action: { id: 'pa-d', status: 'confirmed' }, action: null, execute: { kind: 'whatsapp_text', file: null, text: draft.text, subject: null, wa_url_template: 'https://wa.me/{phone}?text=%D0%94', hint: null } } }))
      .on('POST /pending-actions/pa-d/result', () => ({ status: 200, body: { pending_action: { id: 'pa-d', status: 'executed' }, action: { id: 'a', kind: 'send_external' }, draft: { ...draft, status: 'sent', seq: 41 } } }));
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    const log = sharePort();
    putFull(kpFullOut(full()));
    await renderRouter(APP_DIR, { initialUrl: '/draft/new?doc=doc-1' });
    await settle(() => screen.queryByTestId('draft-new-request') !== null);
    await fireEvent.changeText(screen.getByTestId('draft-new-request'), 'что КП будет в пятницу');
    await fireEvent.press(screen.getByTestId('draft-new-make'));
    await settle(() => screen.queryByTestId('draft-screen') !== null);
    expect(s.callsTo('POST /drafts')[0]!.body).toMatchObject({ request: 'что КП будет в пятницу', channel: 'whatsapp', document_id: 'doc-1', recipient_name: 'Ерлан' });
    expect(screen.getAllByText('Подготовил помощник (ИИ) по вашим записям — проверьте')).toHaveLength(1);
    await fireEvent.changeText(screen.getByTestId('draft-phone'), '+7 701 000 00 00');
    await fireEvent.press(screen.getByTestId('draft-open'));
    await settle(() => log.urls.length === 1);
    expect(log.urls[0]).toBe('https://wa.me/77010000000?text=%D0%94');
    await settle(() => screen.queryByTestId('draft-did') !== null);
    await fireEvent.press(screen.getByTestId('draft-did-yes'));
    await settle(() => s.callsTo('POST /pending-actions/pa-d/result').length === 1);
    expect(s.callsTo('POST /pending-actions/pa-d/result')[0]!.body).toMatchObject({ outcome: 'sent' });
    await settle(() => useKp.getState().drafts['dr-1']!.status === 'sent');
  });

  it('«Изменить» offline: the text at once, «Отменить» puts it back; «Не надо» waits for the strip', async () => {
    const outbox = resetApp();
    finishOnboarding('full');
    kpSink.apply({ documents: [], prices: [], drafts: [{ id: 'dr-2', client_id: null, channel: 'whatsapp', recipient_name: 'Ерлан', subject: null, text: 'Старый текст', request_text: null, document_id: null, status: 'draft', review_fields: ['text'], pending_action_id: 'pa-2', ai_generated: true, sent_at: null, version: 1, seq: 5, created_at: null, updated_at: null, deleted_at: null }] });
    await renderRouter(APP_DIR, { initialUrl: '/draft/dr-2' });
    await settle(() => screen.queryByTestId('draft-text') !== null);
    expect(screen.getByTestId('draft-check')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('draft-text'), 'Новый текст');
    await fireEvent(screen.getByTestId('draft-text'), 'endEditing');
    await settle(() => outbox.all().some((r) => r.kind === 'kp.draft'));
    expect(screen.getByTestId('draft-text').props.value).toBe('Новый текст');
    const st = useUndo.getState().strip;
    if (st?.kind === 'custom') st.onUndo();
    await settle(() => screen.getByTestId('draft-text').props.value === 'Старый текст');
    await fireEvent.press(screen.getByTestId('draft-discard'));
    await settle(() => screen.queryByTestId('draft-gone') !== null);
    expect(outbox.all().some((r) => r.kind === 'kp.draft' && (r.payload as { op: string }).op === 'delete')).toBe(false);
    const st2 = useUndo.getState().strip;
    if (st2?.kind === 'custom') st2.onUndo();
    await settle(() => screen.queryByTestId('draft-text') !== null);
  });
});

describe('the client’s number from the contacts (founder 2026-11-11)', () => {
  const two: PickedContact = { name: 'Ерлан Тестов', phones: [{ label: 'work', number: '+7 727 000 00 00' }, { label: 'mobile', number: '+7 701 000 00 00' }] };

  it('S18: our words first, then the system’s question; two numbers → the person picks one; only that number is kept, nothing reaches the server', async () => {
    const s = server();
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    const log = contacts('undetermined', two);
    putFull(kpFullOut(full()));
    await renderRouter(APP_DIR, { initialUrl: '/kp/send?doc=doc-1' });
    await settle(() => screen.queryByTestId('kp-send-phone-contacts') !== null);
    await fireEvent.press(screen.getByTestId('kp-send-phone-contacts'));
    await settle(() => screen.queryByTestId('kp-send-phone-contacts-explain') !== null);
    expect(log.asked).toBe(0); // nothing asked before the explanation
    expect(screen.getByText(/возьму только его номер/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('kp-send-phone-contacts-allow'));
    await settle(() => screen.queryByTestId('kp-send-phone-contacts-choose') !== null);
    expect(log).toEqual({ asked: 1, picked: 1 });
    await fireEvent.press(screen.getByTestId('kp-send-phone-contacts-phone-1'));
    await settle(() => screen.getByTestId('kp-send-phone').props.value === '+7 701 000 00 00');
    expect(text('kp-send-phone-picked')).toBe('Выбран: Ерлан Тестов');
    expect(useKp.getState().sendDrafts['doc-1']).toMatchObject({ phone: '+7 701 000 00 00' });
    expect(JSON.stringify(useKp.getState())).not.toMatch(/727 000|Тестов/); // the other number and the contact are not kept
    expect(JSON.stringify(s.calls)).not.toMatch(/701 000|727 000|Тестов/);
  });

  it('declined in our sheet: the system is never asked; denied by the system: typing still works', async () => {
    resetApp();
    finishOnboarding('full');
    const log = contacts('undetermined', two);
    putFull(kpFullOut(full()));
    await renderRouter(APP_DIR, { initialUrl: '/kp/send?doc=doc-1' });
    await settle(() => screen.queryByTestId('kp-send-phone-contacts') !== null);
    await fireEvent.press(screen.getByTestId('kp-send-phone-contacts'));
    await settle(() => screen.queryByTestId('kp-send-phone-contacts-type') !== null);
    await fireEvent.press(screen.getByTestId('kp-send-phone-contacts-type'));
    await settle(() => screen.queryByTestId('kp-send-phone-contacts-note') !== null);
    expect(log.asked).toBe(0);
    expect(text('kp-send-phone-contacts-note')).toBe('Хорошо. Номер можно ввести вручную.');

    contacts('denied', two);
    await fireEvent.press(screen.getByTestId('kp-send-phone-contacts'));
    await settle(() => screen.queryByTestId('kp-send-phone-contacts-settings') !== null);
    await fireEvent.changeText(screen.getByTestId('kp-send-phone'), '8 701 000 00 00');
    expect(useKp.getState().sendDrafts['doc-1']!.phone).toBe('8 701 000 00 00');
  });

  it('a draft: one number picked straight away when access is given', async () => {
    resetApp();
    finishOnboarding('full');
    contacts('granted', { name: 'Ерлан', phones: [{ label: null, number: '+7 701 000 00 00' }] });
    kpSink.apply({ documents: [], prices: [], drafts: [{ id: 'dr-3', client_id: null, channel: 'whatsapp', recipient_name: 'Ерлан', subject: null, text: 'Текст', request_text: null, document_id: null, status: 'draft', review_fields: [], pending_action_id: 'pa-3', ai_generated: true, sent_at: null, version: 1, seq: 5, created_at: null, updated_at: null, deleted_at: null }] });
    await renderRouter(APP_DIR, { initialUrl: '/draft/dr-3' });
    await settle(() => screen.queryByTestId('draft-phone-contacts') !== null);
    await fireEvent.press(screen.getByTestId('draft-phone-contacts'));
    await settle(() => screen.getByTestId('draft-phone').props.value === '+7 701 000 00 00');
    expect(screen.queryByTestId('draft-phone-contacts-explain')).toBeNull();
  });
});

describe('/sync, week 15 (kp.md «Sync»)', () => {
  it('the profile row without secrets (a list), price lists, drafts; tombstones company_profile / price_list / draft', async () => {
    let round = 0;
    const s = happyServer();
    const profileRow = { name: 'ТОО «Пример»', legal_form: 'too', bin_iin: null, bin_iin_hint: '…0000', bank: { iban: null, iban_hint: '…0001', bik: 'TESTKZKA', bank: 'Тест-Банк', kbe: '17' }, contacts: {}, version: 4, complete: true, secrets_masked: true, seq: 50 };
    const list = { id: 'pl-1', title: 'Прайс 2026', source: 'upload', reader: 'table', active: true, items: 1, review_count: 0, deleted_at: null, seq: 51 };
    const item = { id: 'p-1', price_list_id: 'pl-1', name: 'Кабель', unit: 'м', price: '450.00', currency: 'KZT', review_fields: [], seq: 52 };
    const draft = { id: 'dr-9', channel: 'whatsapp', recipient_name: 'Ерлан', text: 'Текст', status: 'draft', pending_action_id: 'pa-9', ai_generated: true, seq: 53 };
    s.on('GET /sync', () => {
      round++;
      const body =
        round === 1
          ? { items: [], company_profile: [profileRow], price_lists: [list], price_list_items: [item], drafts: [draft], tombstones: [], next_since: 53, has_more: false }
          : { items: [], tombstones: [{ entity: 'price_list', id: 'pl-1', seq: 60 }, { entity: 'draft', id: 'dr-9', seq: 61 }, { entity: 'company_profile', id: 'cp-1', seq: 62 }], next_since: 62, has_more: false };
      return { status: 200, body };
    });
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    useKp.getState().set({
      profile: { name: 'ТОО «Пример»', legal_form: 'too', bin_iin: '123456780000', address: null, bank: { iban: 'KZ000000000000000001', bik: null, bank: null, kbe: null }, contacts: { phone: null, email: null, website: null }, vat_payer: true, logo_file_id: null, signature_file_id: null, stamp_file_id: null, review_fields: [], version: 3, complete: true, updated_at: null },
    });
    const engine = await getSyncEngine();
    await engine.run();
    await settle(() => useKp.getState().profile?.version === 4);
    const p = useKp.getState().profile!;
    expect([p.bin_iin, p.bank.iban, p.bank.kbe]).toEqual(['123456780000', 'KZ000000000000000001', '17']); // the full values stay on this phone
    expect(useKp.getState().priceLists['pl-1']).toMatchObject({ title: 'Прайс 2026', items: 1 });
    expect(useKp.getState().prices['p-1']).toMatchObject({ name: 'Кабель', price: '450.00' });
    expect(useKp.getState().drafts['dr-9']).toMatchObject({ status: 'draft' });
    await engine.run();
    await settle(() => !useKp.getState().priceLists['pl-1']);
    expect(useKp.getState().prices['p-1']).toBeUndefined();
    expect(useKp.getState().drafts['dr-9']).toBeUndefined();
    expect(useKp.getState().profile).toBeNull();
  });
});

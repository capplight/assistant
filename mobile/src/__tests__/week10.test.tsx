import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { ackLate, takeBackLateDone } from '@/alarms/service';
import { useAlarms } from '@/alarms/store';
import {
  actionOut,
  cleanupPreview,
  collectionOut,
  decodeChatEvent,
  duplicateGroupOut,
  fireOut,
  importOut,
  pendingActionOut,
  reminderOut,
} from '@/api/endpoints';
import { answerNotice } from '@/components/answerText';
import type { InMemoryOutboxRepository } from '@/db';
import { liveCleanup, visibleGroups } from '@/dedup/service';
import { setFilePickerForTests } from '@/dedup/pickFile';
import { useDedup } from '@/dedup/store';
import i18n from '@/i18n';
import { placesLocally } from '@/pages/contents';
import { normalizeText } from '@/records/capture';
import { getCapture, getRecordActions, getSyncEngine } from '@/services';
import type { ChatMessage } from '@/store/assistant';
import { usePages } from '@/store/pages';
import { useUndo } from '@/store/undo';
import { isImportant } from '@/tasks/actions';
import { useTasks } from '@/tasks/store';
import { happyServer, itemOut, linkOut, type FakeServer } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle, testPages, testRecords } from '@/testing/helpers';

/**
 * Week 10 (3-engineering §11.2: «Уже было · Отменить», «Объединить?», stacks on «Заметки», the
 * import summary) and the week 9 follow-up (the explicit event → action link of
 * /reminders/events, the held engine for «Отменить» of a late «Сделано»). Shapes as in the
 * backend's routes/duplicates.py, collections.py, imports.py of 2026-11-09.
 * Fake server only: nothing here ran against the real server or on a phone.
 */

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const t = i18n.t.bind(i18n);

function action(id: string, summary: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'merge_group',
    scope: 'internal',
    initiated_by: 'user',
    summary: { ru: summary, kk: null },
    page: null,
    changes: [],
    changed_item_ids: [],
    created_page_id: null,
    undoable: true,
    undoable_until: iso(Date.now() + 30 * 86_400_000),
    undone_at: null,
    undo_of: null,
    message_id: null,
    seq: 10,
    created_at: iso(Date.now()),
    ...extra,
  };
}

/** As dedup/service.py `groups_dicts`. */
function group(id: string, members: [string, string][], extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'near',
    status: 'suggested',
    origin: 'cleanup',
    keep_item_id: `srv-${members[0]![0]}`,
    keep_rule: 'most_complete',
    member_count: members.length,
    members: members.map(([m, text], i) => ({
      item_id: `srv-${m}`,
      role: i === 0 ? 'keep' : 'merge',
      score: 0.9,
      title: null,
      preview: text,
      kind: 'note',
      source: 'typed',
      occurred_at: iso(Date.now() - (i + 1) * 86_400_000),
      words: 3,
      visible: true,
    })),
    action_id: null,
    seq: 5,
    created_at: iso(Date.now()),
    decided_at: null,
    ...extra,
  };
}

const PENDING = {
  id: 'pa1',
  kind: 'cleanup_batch',
  status: 'proposed',
  preview: { copies: 36, records_before: 37, records_after: 1, groups: 1 },
  expires_at: iso(Date.now() + 24 * 60 * MIN),
  message_id: null,
  action_id: null,
  seq: 3,
  created_at: iso(Date.now()),
  decided_at: null,
};

function server(): FakeServer {
  const s = happyServer();
  s.on('POST /actions/*/undo', (c) => ({
    status: 200,
    body: { action: { ...action(c.path.split('/')[2]!, 'x'), undoable: false, undone_at: iso(Date.now()) }, undo: null, partial: false, repeated: false, message_ru: null, page_patches: [] },
  }))
    .on('GET /actions', () => ({ status: 200, body: { actions: [], has_more: false } }))
    .on('GET /today', () => ({ status: 200, body: { sections: [], today: { reminders: [], tasks: [], shopping: null }, missed: [], done_for_you: { actions: [], count_today: 0 }, proposals: [], tip: null, empty: false } }))
    .on('GET /collections', () => ({ status: 200, body: { collections: [] } }))
    .on('GET /duplicates/groups', () => ({ status: 200, body: { groups: [] } }))
    .on('POST /duplicates/cleanup/plan', () => ({ status: 200, body: { pending_action: null, exact: null, exact_groups: [], near_groups: [], near_total: 0 } }));
  return s;
}

async function online(s: FakeServer): Promise<InMemoryOutboxRepository> {
  const outbox = resetApp({ fetch: s.fetch });
  finishOnboarding('full');
  await (await getSyncEngine()).run();
  return outbox;
}

async function sync(outbox: InMemoryOutboxRepository) {
  const e = await getSyncEngine();
  await e.whenIdle();
  for (const r of outbox.all()) if (r.status === 'pending') await outbox.markRetry(r.id, 'test', 0);
  await e.run();
}

describe('contract decoding (duplicates.md, stacks.md, import.md as in the routes)', () => {
  it('a group, the cleanup preview, a stack, an import, an action linked to its event', () => {
    const g = duplicateGroupOut(group('g1', [['a', 'Код домофона 4512'], ['b', 'код домофона 4512!']]))!;
    expect(g).toMatchObject({ id: 'g1', kind: 'near', status: 'suggested', keep_item_id: 'srv-a', member_count: 2 });
    expect(g.members.map((m) => [m.role, m.snippet])).toEqual([
      ['keep', 'Код домофона 4512'],
      ['merge', 'код домофона 4512!'],
    ]);
    expect(cleanupPreview(pendingActionOut(PENDING))).toEqual({ before: 37, after: 1, removed: 36, groups: 1 });
    expect(liveCleanup(pendingActionOut({ ...PENDING, expires_at: iso(Date.now() - 1) }))).toBeNull();
    const c = collectionOut({ id: 'c1', title: 'Ремонт', icon: 'home', page_id: 'srv-notes', group_key: 'Ремонт', item_count: 4, seq: 2 })!;
    expect(c).toMatchObject({ page_id: 'srv-notes', item_count: 4, before_after: null });
    const imp = importOut({ id: 'i1', status: 'done', total: 40, processed: 40, created: 30, skipped_dups: 4, seen_before: 6, skipped_media: { video: 3, sticker: 0 }, failed: 0, action_id: 'ai1', seq: 9 })!;
    expect(imp).toMatchObject({ created_count: 30, skipped_dups: 4, seen_before: 6, skipped_media: { video: 3 }, action_id: 'ai1' });
    expect(actionOut(action('a1', 'Сделано', { event_client_id: 'ev-1' }))?.event_client_id).toBe('ev-1');
  });

  it('a deletion asked from the line is a question with «Нет» in focus, never «Да»', () => {
    const e = decodeChatEvent({
      event: 'confirm',
      data: JSON.stringify({
        proposal: {
          reply_id: 'r1',
          kind: 'delete',
          question: 'Удалить 3 записи? Вернуть можно 30 дней',
          options: [
            { id: 'yes', label: 'Да, удалить', kind: 'delete' },
            { id: 'no', label: 'Нет', kind: 'no' },
          ],
          default: 'yes',
        },
      }),
      id: '3',
    });
    expect(e?.type).toBe('proposal');
    if (e?.type !== 'proposal') return;
    expect(e.proposal.kind).toBe('delete');
    expect(e.proposal.options[0]!.kind).toBe('yes');
    expect(e.proposal.default).toBe('no');
  });

  it('the phone\'s hash basis is the server\'s (records/textnorm.hash_basis)', () => {
    expect(normalizeText('  Купи, ХЛЕБ!!\n\n2 шт.  ')).toBe('купи хлеб 2 шт');
    expect(normalizeText('Қазақша — сөз')).toBe('қазақша сөз');
    expect(normalizeText('👍 !!')).toBe('');
  });

  it('«Только важное»: the assistant\'s own changes, external, deletions, merges, imports', () => {
    expect(isImportant(actionOut(action('a', 'x', { kind: 'screen_reorder_items' }))!)).toBe(false);
    expect(isImportant(actionOut(action('a', 'x', { kind: 'screen_reorder_items', initiated_by: 'agent' }))!)).toBe(true);
    expect(isImportant(actionOut(action('a', 'x', { kind: 'delete_item' }))!)).toBe(true);
    expect(isImportant(actionOut(action('a', 'x', { kind: 'user_edit', scope: 'external' }))!)).toBe(true);
  });

  it('a change whose stream dropped is «может, уже сделал», not «не сделано»', () => {
    const m = { id: 'm', role: 'assistant', text: '', status: 'interrupted', notice: 'maybe_done' } as unknown as ChatMessage;
    expect(answerNotice(m, t)).toBe(t('answer.maybe_done'));
  });
});

describe('«Заметки» shows notes only (founder, 2026-11-09)', () => {
  it('a text or voice note yes; a photo, a task\'s record or a row saved on «Покупки» no', async () => {
    resetApp();
    finishOnboarding('full');
    usePages.getState().addPage('shopping');
    const notes = usePages.getState().pages.find((p) => p.templateKey === 'notes')!;
    const shop = usePages.getState().pages.find((p) => p.templateKey === 'shopping')!;
    const rec = (id: string, kind: string, extra: Record<string, unknown> = {}) =>
      ({ id, serverId: `srv-${id}`, kind, pageId: null, ...extra }) as never;
    expect(placesLocally(notes, rec('n', 'note'))).toBe(true);
    expect(placesLocally(notes, rec('v', 'voice'))).toBe(true);
    expect(placesLocally(notes, rec('p', 'image'))).toBe(false);
    expect(placesLocally(notes, rec('s', 'note', { pageId: shop.id }))).toBe(false);
    expect(placesLocally(shop, rec('s', 'note', { pageId: shop.id }))).toBe(true);
    useTasks.setState({ tasks: { t1: { id: 't1', item_id: 'srv-t', list_key: 'shopping' } as never } });
    expect(placesLocally(notes, rec('t', 'note'))).toBe(false);
  });
});

describe('«Уже было · Отменить» found on the phone (offline, «Без ИИ» too)', () => {
  it('the same text again is hidden at once with the strip; «Отменить» shows it; the server\'s merge is not news twice', async () => {
    const s = server();
    const outbox = resetApp({ fetch: s.fetch });
    finishOnboarding('no_ai');
    s.offline = true;
    const capture = await getCapture();
    const first = await capture.saveText({ text: 'Код домофона 4512', source: 'typed' });
    await capture.saveText({ text: 'код домофона: 4512!', source: 'typed' });
    const visible = await testRecords.list();
    expect(visible.map((r) => r.id)).toEqual([first.id]);
    const strip = useUndo.getState().strip;
    expect(strip?.kind).toBe('merged');
    // «Отменить» while nothing went: shown again here, the unmerge waits for the record to be on the server.
    if (strip?.kind === 'merged') await (await getRecordActions()).unmerge(strip.recordId);
    expect((await testRecords.list()).length).toBe(2);
    // The server merges it too (same hash) and then undoes it: no second strip.
    s.offline = false;
    s.on('POST /items', (c) => {
      const b = c.body as { client_id: string; text: string };
      const dup = b.client_id !== first.id;
      const it = itemOut(b.client_id, dup ? 3 : 2, { text: b.text, ...(dup ? { hidden_reason: 'duplicate_merged', canonical_id: `srv-${first.id}` } : {}) });
      return {
        status: 201,
        body: { item: it, created: true, auto_merged: dup, duplicate: dup ? { canonical_id: `srv-${first.id}`, canonical_created_at: iso(Date.now()), undo_path: '' } : null },
      };
    }).on('POST /items/*/unmerge', (c) => ({ status: 200, body: itemOut(c.path.split('/')[2]!.replace(/^srv-/, ''), 4, { text: 'код домофона: 4512!' }) }));
    useUndo.setState({ strip: null });
    await act(async () => {
      await sync(outbox);
      await sync(outbox);
    });
    expect(s.callsTo('POST /items')).toHaveLength(2);
    expect(s.calls.filter((c) => /\/unmerge$/.test(c.path))).toHaveLength(1);
    expect(useUndo.getState().strip).toBeNull();
    expect((await testRecords.list()).length).toBe(2);
  });
});

describe('S26 «Повторы»', () => {
  it('[Объединить] is the «Да» of one group, with the record the person chose to keep; «Отменить» undoes it', async () => {
    const s = server();
    s.on('GET /duplicates/groups', () => ({ status: 200, body: { groups: [group('g1', [['a', 'Плитка 24 м²'], ['b', 'плитка 24 м2'], ['c', 'Плитка, 24 м²']])] } }))
      .on('POST /duplicates/groups/*/merge', () => ({
        status: 200,
        body: { group: { ...group('g1', [['a', 'x']]), status: 'merged', seq: 9 }, action: action('am1', 'Объединил 3 записи'), repeated: false },
      }));
    await online(s);
    await renderRouter(APP_DIR, { initialUrl: '/duplicates' });
    await settle(() => screen.queryByTestId('dup-group-g1') !== null);
    expect(screen.getByTestId('dup-found')).toHaveTextContent('Групп: 1. Лишних записей: 2');
    expect(screen.getByTestId('dup-keep-g1')).toHaveTextContent('Плитка 24 м²');
    await fireEvent.press(screen.getByTestId('dup-keep-this-srv-c'));
    expect(screen.getByTestId('dup-keep-g1')).toHaveTextContent('Плитка, 24 м²');
    await fireEvent.press(screen.getByTestId('dup-merge-g1'));
    await settle(() => s.callsTo('POST /duplicates/groups/g1/merge').length === 1 && screen.queryByTestId('dup-group-g1') === null);
    expect(s.callsTo('POST /duplicates/groups/g1/merge')[0]!.body).toMatchObject({ keep_item_id: 'srv-c' });
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent('Объединил 3 записи');
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => s.callsTo('POST /actions/am1/undo').length === 1);
  });

  it('[Это разные] merges nothing; offline nothing changes and the person is told', async () => {
    const s = server();
    s.on('GET /duplicates/groups', () => ({ status: 200, body: { groups: [group('g2', [['a', 'Встреча 12-го'], ['b', 'Встреча 13-го']])] } }))
      .on('POST /duplicates/groups/*/dismiss', () => ({ status: 200, body: { group: { ...group('g2', [['a', 'x']]), status: 'dismissed', seq: 9 } } }));
    await online(s);
    await renderRouter(APP_DIR, { initialUrl: '/duplicates' });
    await settle(() => screen.queryByTestId('dup-group-g2') !== null);
    s.offline = true;
    await fireEvent.press(screen.getByTestId('dup-different-g2'));
    await settle(() => screen.queryByTestId('dup-group-g2') !== null && s.calls.at(-1)?.path !== '/duplicates/groups/g2/dismiss');
    expect(screen.getByTestId('dup-group-g2')).toBeTruthy();
    s.offline = false;
    await fireEvent.press(screen.getByTestId('dup-different-g2'));
    await settle(() => screen.queryByTestId('dup-group-g2') === null);
    expect(s.callsTo('POST /duplicates/groups/g2/merge')).toHaveLength(0);
  });

  it('«Убрать повторы: 37 → 1?» — one «Да» for the batch, one «Отменить»; [Нет] changes nothing', async () => {
    const s = server();
    s.on('POST /duplicates/cleanup/plan', () => ({ status: 200, body: { pending_action: PENDING, exact: PENDING.preview, exact_groups: [], near_groups: [], near_total: 0 } }))
      .on('POST /pending-actions/*/confirm', () => ({ status: 200, body: { pending_action: { ...PENDING, status: 'executed' }, action: action('ac1', 'Убрал 36 повторов · 37 → 1', { kind: 'cleanup_batch' }), repeated: false } }));
    await online(s);
    await renderRouter(APP_DIR, { initialUrl: '/duplicates' });
    await settle(() => screen.queryByTestId('dup-batch') !== null);
    expect(screen.getByTestId('dup-batch-title')).toHaveTextContent('Убрать повторы: 37 → 1?');
    expect(s.callsTo('POST /pending-actions/pa1/confirm')).toHaveLength(0); // nothing by itself
    await fireEvent.press(screen.getByTestId('dup-batch-yes'));
    await settle(() => screen.queryByTestId('dup-batch') === null);
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent('Убрал 36 повторов · 37 → 1');
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => s.callsTo('POST /actions/ac1/undo').length === 1);
  });
});

describe('stacks as groups on «Заметки», S11', () => {
  it('a stack card with its count; S11 lists its rows; «Убрать из стопки» and «Разобрать стопку» with «Отменить»', async () => {
    const s = server();
    const stack = { id: 'c1', title: 'Ремонт', title_kk: null, icon: 'home', page_id: 'srv-notes', group_key: 'Ремонт', item_count: 2, kind: 'smart', created_by: 'agent', seq: 4, updated_at: iso(Date.now()) };
    s.on('GET /collections', () => ({ status: 200, body: { collections: [stack] } }))
      .on('DELETE /collections/*/items/*', () => ({ status: 200, body: { collection: { ...stack, item_count: 1, seq: 5 }, action: action('as1', 'Убрал из стопки «Ремонт»', { kind: 'stack_remove' }) } }))
      .on('DELETE /collections/*', () => ({ status: 200, body: { collection: { ...stack, seq: 6 }, action: action('as2', 'Разобрал стопку «Ремонт»', { kind: 'delete_stack' }) } }));
    await online(s);
    usePages.setState({ pages: usePages.getState().pages.map((p) => (p.templateKey === 'notes' ? { ...p, serverId: 'srv-notes', syncState: 'synced' as const } : p)) });
    for (const p of usePages.getState().pages) await testPages.insertLocal(p);
    for (const [i, id] of ['r1', 'r2', 'r3'].entries()) {
      await testRecords.applyRemote(itemOut(id, 50 + i, { text: `Плитка ${i}`, status: 'ready' }));
      await testPages.applyLink(linkOut('srv-notes', `srv-${id}`, 60 + i, { group_key: i < 2 ? 'Ремонт' : null }));
    }
    const notes = usePages.getState().pages.find((p) => p.templateKey === 'notes')!;
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes.id}` });
    await settle(() => screen.queryByTestId('stack-c1') !== null);
    expect(screen.getByTestId('stack-c1')).toHaveTextContent(/Ремонт.*2/);
    await fireEvent.press(screen.getByTestId('stack-c1'));
    await settle(() => screen.queryByTestId('stack-screen') !== null);
    expect(screen.getByTestId('stack-count')).toHaveTextContent('Записей: 2');
    await fireEvent.press(screen.getByTestId('stack-remove-r1'));
    await settle(() => s.callsTo('DELETE /collections/c1/items/srv-r1').length === 1);
    await settle(() => screen.queryByTestId('undo-strip-text') !== null);
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent('Убрал из стопки «Ремонт»');
    await fireEvent.press(screen.getByTestId('stack-take-apart'));
    await settle(() => s.callsTo('DELETE /collections/c1').length === 1);
    await settle(() => screen.queryByTestId('stack-c1') === null);
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => s.callsTo('POST /actions/as2/undo').length === 1);
  });
});

describe('S21 Telegram import from the export file', () => {
  it('consent once → file → upload → import → progress → summary; the cleanup as one «Да»', async () => {
    const s = server();
    let polls = 0;
    const imp = (extra: Record<string, unknown>) => ({ id: 'imp1', client_id: null, source: 'telegram_export_file', status: 'running', total: 1200, processed: 0, created: 0, skipped_dups: 0, seen_before: 0, skipped_media: {}, failed: 0, action_id: null, seq: 1, ...extra });
    s.on('GET /consents', () => ({ status: 200, body: { active: [], history: [], ai_enabled: true, app_enabled: true } }))
      .on('GET /consents/text', () => ({
        status: 200,
        body: { kind: 'telegram_import', version: 'tg-import-1', locale: 'ru', text: 'Я переношу в приложение текст из моего «Избранного».', text_hash: 'h1', providers: [] },
      }))
      .on('POST /imports/telegram/file', () => ({ status: 202, body: { import: imp({}), created: true } }))
      .on('GET /imports/*', () => {
        polls++;
        return {
          status: 200,
          body: { import: polls < 2 ? imp({ processed: 120, seq: 2 }) : imp({ status: 'done', processed: 1200, created: 1000, skipped_dups: 150, seen_before: 50, skipped_media: { video: 34 }, action_id: 'aimp', seq: 3 }) },
        };
      })
      .on('POST /duplicates/cleanup/plan', () => ({ status: 200, body: { pending_action: { ...PENDING, preview: { copies: 214, records_before: 1200, records_after: 986, groups: 90 } }, near_groups: [], near_total: 0 } }))
      .on('POST /pending-actions/*/confirm', () => ({ status: 200, body: { pending_action: null, action: action('ac2', 'Убрал 214 повторов', { kind: 'cleanup_batch' }) } }));
    const outbox = await online(s);
    setFilePickerForTests(async () => ({ uri: 'file:///cache/result.json', name: 'result.json', mime: 'application/json', size: 1000 }));
    await renderRouter(APP_DIR, { initialUrl: '/import' });
    await settle(() => screen.queryByTestId('import-pick') !== null);
    await fireEvent.press(screen.getByTestId('import-pick'));
    await settle(() => screen.queryByTestId('import-consent-text') !== null);
    expect(screen.getByTestId('import-consent-text')).toHaveTextContent(/«Избранного»/);
    await fireEvent.press(screen.getByTestId('import-consent-yes'));
    await settle(() => s.callsTo('POST /consents').some((c) => (c.body as { screen: string }).screen === 'import'));
    expect(s.callsTo('POST /consents').at(-1)!.body).toMatchObject({ screen: 'import', consents: [{ kind: 'telegram_import', version: 'tg-import-1', text_hash: 'h1' }] });
    await act(async () => {
      await sync(outbox);
    });
    await settle(() => s.callsTo('POST /imports/telegram/file').length === 1);
    // The same upload path as any file: POST /uploads → PUT → complete, then the import with that id.
    expect(s.callsTo('POST /imports/telegram/file')[0]!.body).toMatchObject({ upload_id: expect.stringMatching(/^up-/) });
    await settle(() => screen.queryByTestId('import-progress') !== null);
    await settle(() => screen.queryByTestId('import-summary') !== null);
    expect(screen.getByTestId('import-created')).toHaveTextContent('Перенёс заметок: 1000');
    expect(screen.getByTestId('import-seen')).toHaveTextContent(/Уже были у вас: 200/);
    expect(screen.getByTestId('import-media-video')).toHaveTextContent('Видео (34) не перенёс — только подписи');
    await settle(() => screen.queryByTestId('import-cleanup') !== null);
    expect(screen.getByTestId('import-cleanup')).toHaveTextContent(/Повторов: 214 — убрать\?/);
    expect(s.callsTo('POST /pending-actions/pa1/confirm')).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('import-cleanup-yes'));
    await settle(() => s.callsTo('POST /pending-actions/pa1/confirm').length === 1);
    await fireEvent.press(screen.getByTestId('import-undo'));
    await settle(() => s.callsTo('POST /actions/aimp/undo').length === 1);
    // A second file: the consent is not asked again.
    await fireEvent.press(screen.getByTestId('import-again'));
    await settle(() => screen.queryByTestId('import-pick') !== null);
    await fireEvent.press(screen.getByTestId('import-pick'));
    await settle(() => outbox.all().filter((r) => r.kind === 'import.telegram').length === 2);
    expect(s.callsTo('GET /consents')).toHaveLength(1);
    expect(screen.queryByTestId('import-consent-text')).toBeNull();
  });

  it('a file that is not an export is refused on the phone; a refused import says why', async () => {
    const s = server();
    s.on('GET /consents', () => ({ status: 200, body: { active: [{ kind: 'telegram_import' }], history: [], ai_enabled: true, app_enabled: true } }))
      .on('POST /imports/telegram/file', () => ({ status: 422, body: { code: 'import_bad_file', message_ru: '', message_kk: '' } }));
    const outbox = await online(s);
    let name = 'photo.jpg';
    setFilePickerForTests(async () => ({ uri: `file:///cache/${name}`, name, mime: null, size: 10 }));
    await renderRouter(APP_DIR, { initialUrl: '/import' });
    await settle(() => screen.queryByTestId('import-pick') !== null);
    await fireEvent.press(screen.getByTestId('import-pick'));
    await settle(() => s.callsTo('GET /consents').length === 1);
    expect(outbox.all().some((r) => r.kind === 'import.telegram')).toBe(false);
    name = 'export.zip';
    await fireEvent.press(screen.getByTestId('import-pick'));
    await settle(() => outbox.all().some((r) => r.kind === 'import.telegram'));
    await act(async () => {
      await sync(outbox);
    });
    await settle(() => screen.queryByTestId('import-failed') !== null);
    expect(screen.getByTestId('import-failed')).toHaveTextContent(/Это не файл экспорта Telegram/);
  });
});

describe('week 9 follow-up: a late «Сделано» and its action', () => {
  const setupMissed = () => {
    const due = Date.now() - 60 * MIN;
    const r = reminderOut({ id: 'r9', title: 'Свет', due_at: iso(due), kind: 'normal', status: 'scheduled', level: 'alarm', version: 1 })!;
    const f = fireOut({ id: 'f9', reminder_id: 'r9', key: 'r9:k:0:0', occurrence_at: iso(due), fire_at: iso(due), offset_min: 0, snooze_n: 0, state: 'missed' })!;
    useAlarms.setState({ reminders: { r9: r }, fires: { [f.key]: f } });
    return f;
  };

  it('the action is found by `event_client_id`, not by the reminder: another action of the same reminder is left alone', async () => {
    const s = server();
    const outbox = await online(s);
    const f = setupMissed();
    s.on('POST /reminders/events', (c) => {
      const ev = (c.body as { events: { client_id: string }[] }).events[0]!;
      return {
        status: 200,
        body: {
          results: [{ client_id: ev.client_id, status: 'applied' }],
          fires: [],
          actions: [
            action('other', 'Перенёс «Свет»', { kind: 'edit_reminder', changes: [{ item_id: null, reminder_id: 'r9', kind: 'reminder', text: 'Свет' }] }),
            action('mine', 'Сделано: Свет', { kind: 'edit_reminder', event_client_id: ev.client_id, changes: [{ item_id: null, reminder_id: 'r9', kind: 'reminder', text: 'Свет' }] }),
          ],
        },
      };
    });
    const late = (await ackLate(f.key))!;
    await act(async () => {
      await sync(outbox);
    });
    const row = await outbox.get(late.outboxId!);
    expect((row?.payload as { actionIds: Record<string, string> }).actionIds).toEqual({ [late.eventClientId]: 'mine' });
    const back = await takeBackLateDone(f.key, late, await getSyncEngine());
    expect(back).toEqual({ local: false, actionId: 'mine' });
  });

  it('«Отменить» while the event is on its way: the engine waits for that call, then the event\'s own action is undone', async () => {
    const s = server();
    const outbox = await online(s);
    const f = setupMissed();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let answer: unknown = null;
    s.on('POST /reminders/events', (c) => {
      const ev = (c.body as { events: { client_id: string }[] }).events[0]!;
      answer = { results: [{ client_id: ev.client_id, status: 'applied' }], fires: [], actions: [action('late1', 'Сделано: Свет', { kind: 'edit_reminder', event_client_id: ev.client_id })] };
      return { status: 200, body: answer };
    });
    // The events call takes a while: «Отменить» is pressed in the middle of it.
    const engine = await getSyncEngine();
    const realEvents = engine['d'].api.reminderEvents.bind(engine['d'].api);
    engine['d'].api.reminderEvents = async (events) => {
      const out = await realEvents(events);
      await gate;
      return out;
    };
    const late = (await ackLate(f.key))!;
    for (const r of outbox.all()) if (r.status === 'pending') await outbox.markRetry(r.id, 'test', 0);
    const running = engine.run();
    await settle(() => answer !== null);
    const taking = takeBackLateDone(f.key, late, engine);
    let settled = false;
    void taking.then(() => (settled = true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(settled).toBe(false); // held: no drop of a row that is being sent
    release();
    await running;
    expect(await taking).toEqual({ local: false, actionId: 'late1' });
    expect((await outbox.get(late.outboxId!))?.status).toBe('sent');
  });

  it('still in the outbox: dropped, nothing is sent, the row is missed again', async () => {
    const s = server();
    const outbox = resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    s.offline = true;
    const f = setupMissed();
    const late = (await ackLate(f.key))!;
    const back = await takeBackLateDone(f.key, late, await getSyncEngine());
    expect(back.local).toBe(true);
    expect((await outbox.get(late.outboxId!))?.status).toBe('failed');
    expect(useAlarms.getState().local[f.key]?.ackedAt).toBeUndefined();
  });
});

describe('the strip of an S26 merge lists nothing hidden by itself', () => {
  it('groups decided here leave at once; decided on the server they leave the store', () => {
    resetApp();
    const g = duplicateGroupOut(group('g9', [['a', 'x'], ['b', 'x2']]))!;
    useDedup.setState({ groups: { g9: g }, decided: [] });
    expect(visibleGroups(useDedup.getState().groups, ['g9'])).toHaveLength(0);
    expect(visibleGroups(useDedup.getState().groups, [])).toHaveLength(1);
  });
});

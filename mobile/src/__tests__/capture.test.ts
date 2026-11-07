import { InMemoryOutboxRepository } from '@/db/outbox';
import { InMemoryRecordsRepository } from '@/db/records';
import { Capture, kindForMime, normalizeText } from '@/records/capture';
import { saveSharedContent, toFileUri } from '@/share/handler';
import type { ItemPayload } from '@/sync/engine';
import { fakeFiles } from '@/testing/helpers';
import { formatTimer, levelFromMetering, VoiceSession, type FragmentRecorder } from '@/voice/session';

function setup() {
  const outbox = new InMemoryOutboxRepository();
  const records = new InMemoryRecordsRepository();
  const onSaved = jest.fn();
  const capture = new Capture({ outbox, records, files: fakeFiles, onSaved });
  const payloads = async () => (await outbox.listPending()).map((e) => e.payload as ItemPayload);
  return { outbox, records, capture, onSaved, payloads };
}

describe('share handler', () => {
  it('text → note record + outbox item (source share), kicks sync', async () => {
    const { capture, records, payloads, onSaved } = setup();
    const saved = await saveSharedContent(capture, {
      type: 'text',
      text: '  Позвонить в ЦОН  ',
      webUrl: null,
      files: null,
    });
    expect(saved).toHaveLength(1);
    expect((await records.list())[0]).toMatchObject({
      kind: 'note',
      source: 'share',
      text: 'Позвонить в ЦОН',
      status: 'queued',
    });
    expect((await payloads())[0]).toMatchObject({ kind: 'note', source: 'share', text: 'Позвонить в ЦОН' });
    expect(onSaved).toHaveBeenCalled();
  });

  it('a bare link → link item with url', async () => {
    const { capture, payloads } = setup();
    await saveSharedContent(capture, {
      type: 'weburl',
      text: 'https://kaspi.kz/shop/p/1',
      webUrl: 'https://kaspi.kz/shop/p/1',
    });
    expect((await payloads())[0]).toMatchObject({ kind: 'link', url: 'https://kaspi.kz/shop/p/1' });
    expect((await payloads())[0]?.text).toBeUndefined();
  });

  it('several files (image, PDF, Word, Excel, audio) → one record each; shared text kept as the note', async () => {
    const { capture, records, payloads } = setup();
    const files = [
      { path: '/data/share/receipt.jpg', mimeType: 'image/jpeg', fileName: 'receipt.jpg', size: 1 },
      { path: 'file:///tmp/ТЗ.pdf', mimeType: 'application/pdf', fileName: 'ТЗ.pdf', size: 2 },
      {
        path: '/x/kp.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileName: 'kp.docx',
        size: 3,
      },
      {
        path: '/x/price.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileName: 'price.xlsx',
        size: 4,
      },
      { path: '/x/voice.ogg', mimeType: 'audio/ogg', fileName: 'voice.ogg', size: 5 },
    ];
    const saved = await saveSharedContent(capture, { type: 'file', text: 'от Армана', files });
    expect(saved.map((r) => r.kind)).toEqual(['image', 'pdf', 'docx', 'xlsx', 'voice']);
    const p = await payloads();
    expect(p.every((x) => x.source === 'share' && x.text === 'от Армана' && x.file?.sha256.length === 64)).toBe(true);
    expect(p[1]?.file).toMatchObject({ mime: 'application/pdf', name: 'ТЗ.pdf' });
    expect(p[1]?.file?.uri).toMatch(/^file:\/\/\/doc\/records\//); // copied into app storage
    expect(await records.list()).toHaveLength(5);
  });

  it('nothing usable → nothing saved', async () => {
    const { capture, outbox } = setup();
    expect(await saveSharedContent(capture, { type: null, text: '  ', files: [] })).toEqual([]);
    expect(await outbox.countPending()).toBe(0);
  });

  it('helpers: path → file URI, MIME → kind, text normalization', () => {
    expect(toFileUri('/data/a.jpg')).toBe('file:///data/a.jpg');
    expect(toFileUri('content://media/1')).toBe('content://media/1');
    expect(kindForMime('application/octet-stream', 'scan.PDF')).toBe('pdf');
    expect(kindForMime('application/zip')).toBe('file_other');
    expect(normalizeText('  Купить\n\nХЛЕБ  ')).toBe('купить хлеб');
  });
});

describe('voice fragments', () => {
  function fakeRecorder() {
    let n = 0;
    const calls: string[] = [];
    const rec: FragmentRecorder = {
      begin: async () => {
        n++;
        calls.push(`begin${n}`);
      },
      end: async () => {
        calls.push(`end${n}`);
        return `file:///rec/${n}.m4a`;
      },
    };
    return { rec, calls };
  }

  it('rotates to a new fragment every 3 min and keeps all fragments in order', async () => {
    let t = 0;
    const { rec, calls } = fakeRecorder();
    const s = new VoiceSession(rec, { now: () => t });
    await s.start();
    t = 60_000;
    expect(await s.tick()).toBe('recording');
    t = 180_000;
    expect(await s.tick()).toBe('rotated');
    t = 200_000;
    expect(s.elapsedMs()).toBe(200_000);
    const fragments = await s.finish();
    expect(fragments).toEqual([
      { uri: 'file:///rec/1.m4a', durationMs: 180_000 },
      { uri: 'file:///rec/2.m4a', durationMs: 20_000 },
    ]);
    expect(calls).toEqual(['begin1', 'end1', 'begin2', 'end2']);
  });

  it('stops at the 10-min limit; cancel keeps nothing', async () => {
    let t = 0;
    const { rec } = fakeRecorder();
    const s = new VoiceSession(rec, { now: () => t });
    await s.start();
    for (let m = 3; m <= 9; m += 3) {
      t = m * 60_000;
      expect(await s.tick()).toBe('rotated');
    }
    t = 10 * 60_000;
    expect(await s.tick()).toBe('limit');
    const fr = await s.finish();
    expect(fr.map((f) => f.durationMs)).toEqual([180_000, 180_000, 180_000, 60_000]);

    const c = new VoiceSession(fakeRecorder().rec, { now: () => t });
    await c.start();
    t += 5_000;
    await c.cancel();
    expect(await c.finish()).toEqual([]);
  });

  it('«Готово» pressed while the recorder is still starting: waits, stops it, keeps the fragment', async () => {
    const { rec, calls } = fakeRecorder();
    const s = new VoiceSession(rec, { now: () => 0 });
    const started = s.start();
    const done = s.finish();
    await started;
    expect(await done).toEqual([{ uri: 'file:///rec/1.m4a', durationMs: 0 }]);
    expect(calls).toEqual(['begin1', 'end1']);
  });

  it('level ring and timer', () => {
    expect(levelFromMetering(-160)).toBe(0);
    expect(levelFromMetering(-30)).toBe(0.5);
    expect(levelFromMetering(0)).toBe(1);
    expect(levelFromMetering(undefined)).toBe(0);
    expect(formatTimer(12_400)).toBe('0:12');
    expect(formatTimer(600_000)).toBe('10:00');
  });

  it('a recording = one local record; each fragment = upload + item linked by recording_id', async () => {
    const { capture, records, payloads } = setup();
    const rec = await capture.saveVoice({
      fragments: [
        { uri: 'file:///rec/1.m4a', durationMs: 180_000 },
        { uri: 'file:///rec/2.m4a', durationMs: 5_000 },
      ],
      pageId: 'p1',
    });
    expect(rec).toMatchObject({ kind: 'voice', source: 'mic', status: 'queued' });
    expect(rec?.files).toHaveLength(2);
    expect(await records.list()).toHaveLength(1);
    const p = await payloads();
    expect(p.map((x) => x.sourceMeta)).toEqual([
      { recording_id: rec?.id, fragment: 0, fragments: 2, duration_ms: 180_000, total_duration_ms: 185_000 },
      { recording_id: rec?.id, fragment: 1, fragments: 2, duration_ms: 5_000, total_duration_ms: 185_000 },
    ]);
    expect(p[0]?.clientId).toBe(rec?.id);
    expect(p[1]?.clientId).not.toBe(rec?.id);
    expect(p.every((x) => x.kind === 'voice' && x.file?.mime === 'audio/mp4')).toBe(true);
  });
});

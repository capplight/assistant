import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { CheckBadge } from '@/components/kp/KpParts';
import { Screen } from '@/components/Screen';
import { VoiceListening } from '@/components/VoiceListening';
import { getMedia, type PickedMedia } from '@/expenses/media';
import { assistantOn, dropJob, pumpJobs, startKp } from '@/kp/service';
import { profileReady, shownProfile, useKp } from '@/kp/store';
import { kpView, vatText } from '@/kp/view';
import { getCapture } from '@/services';
import { useConnectivity } from '@/store/connectivity';
import { usePages } from '@/store/pages';
import { useToast } from '@/store/toast';
import { MAX_FONT_SCALE, useTheme } from '@/theme';
import { useVoiceRecorder } from '@/voice/useVoiceRecorder';

const POLL_MS = 2000;
const FIRST_ITEMS = 3;

/**
 * S16 «Новое КП, шаг 1: Что я понял» (week 14). First time without the company: «Сначала — ваша
 * компания» → S19 (or «Позже»). The spec — a photo, a PDF, typed text or the voice — is saved as a
 * record at once (offline too, on «Документы и КП»); the server reads it (KP_EXTRACT) when it can:
 * offline the person is told «Прочитаю, когда появится интернет». Then: the client, what is needed,
 * where the prices come from (from the price list · from past КП · no price), the VAT, [Сделать КП].
 */
export default function NewKpScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ job?: string }>();
  const [jobId, setJobId] = useState<string | null>(params.job ?? null);
  const job = useKp((s) => (jobId ? s.jobs[jobId] : undefined));
  const doc = useKp((s) => (job?.documentId ? s.docs[job.documentId] : undefined));
  const version = useKp((s) => (job?.documentId ? s.versions[job.documentId] : undefined));
  const needsProfile = useKp((s) => s.needsProfile);
  const savedProfile = useKp((s) => s.profile);
  const profileEdit = useKp((s) => s.profileEdit);
  const profile = shownProfile({ profile: savedProfile, profileEdit });
  const online = useConnectivity((s) => s.online);
  const docsPage = usePages((s) => s.pages.find((p) => p.templateKey === 'documents'));
  const [companyLater, setCompanyLater] = useState(false);
  const [mode, setMode] = useState<'pick' | 'text' | 'camera_ask'>('pick');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  // While open, the job is driven every 2 s (records on the server → POST /documents/kp → done).
  const live = job && (job.state === 'waiting' || job.state === 'reading');
  useEffect(() => {
    if (!live) return;
    void pumpJobs();
    const timer = setInterval(() => void pumpJobs(), POLL_MS);
    return () => clearInterval(timer);
  }, [live]);

  const begin = useCallback(
    (recordId: string) => {
      const j = startKp([recordId]);
      setJobId(j.id);
      router.setParams({ job: j.id });
    },
    [],
  );

  const saveFile = async (m: PickedMedia | null, source: 'camera' | 'files') => {
    if (!m) return;
    const capture = await getCapture();
    const rec = await capture.saveFile({ uri: m.uri, mime: m.mime, name: m.name, source, pageId: docsPage?.id });
    begin(rec.id);
  };

  const pick = async (k: 'camera' | 'photo' | 'pdf') => {
    setBusy(true);
    try {
      const media = getMedia();
      if (k === 'camera') {
        if ((await media.cameraPermission()) !== 'granted') {
          setMode('camera_ask');
          return;
        }
        await saveFile(await media.takePhoto(), 'camera');
      } else if (k === 'photo') await saveFile(await media.pickPhoto(), 'files');
      else await saveFile(await media.pickPdf(), 'files');
    } catch (e) {
      console.warn('kp spec pick failed', e);
      useToast.getState().show(t('exp.pick_failed'), 4000);
    } finally {
      setBusy(false);
    }
  };

  const voice = useVoiceRecorder(async (fragments) => {
    const capture = await getCapture();
    const rec = await capture.saveVoice({ fragments, pageId: docsPage?.id });
    if (rec) begin(rec.id);
  });

  const saveText = async () => {
    const s = text.trim();
    if (!s) return;
    const capture = await getCapture();
    const rec = await capture.saveText({ text: s, source: 'typed', pageId: docsPage?.id });
    begin(rec.id);
  };

  const header = (
    <View style={styles.row}>
      <Button testID="kp-new-close" label={`‹ ${t('kp.back')}`} variant="text" minHeight={theme.size.minTouch} onPress={close} />
      <AppText variant="meta" style={{ marginLeft: 'auto' }}>
        {t('kp.step', { n: 1 })}
      </AppText>
    </View>
  );

  let body;
  if (!assistantOn()) {
    body = (
      <>
        <AppText variant="title1" accessibilityRole="header">
          {t('kp.no_ai_title')}
        </AppText>
        <AppText testID="kp-new-no-ai">{t('kp.no_ai_body')}</AppText>
        <Button testID="kp-new-company" label={t('kp.my_company')} variant="outline" onPress={() => router.replace('/company')} />
        <Button testID="kp-new-prices" label={t('kp.my_prices')} variant="outline" onPress={() => router.replace('/price-list')} />
      </>
    );
  } else if (job) {
    if (job.state === 'done' && doc && version) {
      const data = version.data;
      const v = kpView(data, version, false);
      const items = all ? data.items : data.items.slice(0, FIRST_ITEMS);
      body = (
        <>
          <AppText variant="title1" accessibilityRole="header">
            {t('kp.understood')}
          </AppText>
          {job.message ? (
            <AppText testID="kp-new-partial" color="warnText">
              {job.message}
            </AppText>
          ) : null}
          <View style={{ gap: theme.space[1] }}>
            <AppText testID="kp-new-client">{`${t('kp.client')}: ${data.client.name ?? t('kp.client_none')}`}</AppText>
            {data.client.bin ? <AppText variant="number">{`${t('kp.client_bin')}: ${data.client.bin}`}</AppText> : null}
            {data.client.review.includes('client.bin') ? <CheckBadge testID="kp-new-bin-check" /> : null}
          </View>
          <AppText variant="section" accessibilityRole="header">
            {t('kp.items_title', { count: data.items.length })}
          </AppText>
          {items.map((it, i) => (
            <View key={it.id} testID={`kp-new-item-${i}`} style={{ gap: theme.space[1] }}>
              <AppText>{`${i + 1}. ${it.name}${it.qty ? ` — ${it.qty.replace('.', ',')} ${it.unit ?? ''}` : ''}`.trim()}</AppText>
              {it.review_fields.length > 0 ? <CheckBadge /> : null}
            </View>
          ))}
          {data.items.length > FIRST_ITEMS ? (
            <Button
              testID="kp-new-all"
              label={all ? t('kp.items_less') : t('kp.items_more', { count: data.items.length })}
              variant="text"
              minHeight={theme.size.minTouch}
              onPress={() => setAll((a) => !a)}
            />
          ) : null}
          <AppText variant="section" accessibilityRole="header">
            {t('kp.prices_title')}
          </AppText>
          <View testID="kp-new-prices-sum" style={{ gap: theme.space[1] }}>
            {v.counts.price_list > 0 ? <AppText>{t('kp.prices_from_list', { count: v.counts.price_list })}</AppText> : null}
            {v.counts.past_kp > 0 ? <AppText>{t('kp.prices_from_past', { count: v.counts.past_kp })}</AppText> : null}
            {v.counts.manual > 0 ? <AppText>{t('kp.prices_manual', { count: v.counts.manual })}</AppText> : null}
            {v.counts.missing > 0 ? (
              <AppText testID="kp-new-missing" color="warnText">
                {t('kp.prices_missing', { count: v.counts.missing })}
              </AppText>
            ) : null}
          </View>
          {v.counts.missing > 0 ? (
            <Button testID="kp-new-fast" label={t('kp.fast_input')} variant="outline" onPress={() => router.push({ pathname: '/kp/prices', params: { doc: doc.id } })} />
          ) : null}
          <AppText>{t('kp.vat_line', { mode: vatText(data.vat.mode, v.vatRate, t) })}</AppText>
          {needsProfile ? (
            <View testID="kp-new-needs-profile" style={{ gap: theme.space[2] }}>
              <AppText color="warnText">{t('kp.company_first_body')}</AppText>
              <Button testID="kp-new-company-now" label={t('kp.company_fill')} variant="outline" onPress={() => router.push('/company')} />
            </View>
          ) : null}
          <Button
            testID="kp-new-make"
            label={t('kp.make')}
            onPress={() => {
              dropJob(job.id);
              router.replace({ pathname: '/kp/[id]', params: { id: doc.id } });
            }}
          />
          {doc.ai_generated ? <AppText variant="meta">{t('ai.label')}</AppText> : null}
        </>
      );
    } else if (job.state === 'failed') {
      body = (
        <>
          <AppText testID="kp-new-failed" variant="title2" color="warnText" accessibilityLiveRegion="polite">
            {job.message ?? t('kp.job_failed')}
          </AppText>
          <Button
            testID="kp-new-retry"
            label={t('kp.job_retry')}
            onPress={() => {
              dropJob(job.id);
              setJobId(null);
              router.setParams({ job: undefined });
            }}
          />
          <Button
            testID="kp-new-remove"
            label={t('kp.job_remove')}
            variant="outline"
            onPress={() => {
              dropJob(job.id);
              close();
            }}
          />
        </>
      );
    } else {
      const p = doc?.progress;
      body = (
        <>
          <AppText testID="kp-new-job" variant="title2" accessibilityLiveRegion="polite">
            {job.state === 'reading'
              ? p && p.total > 0
                ? t('kp.job_progress', { done: p.done, total: p.total })
                : t('kp.job_reading')
              : t('kp.job_waiting')}
          </AppText>
          <Button testID="kp-new-leave" label={t('kp.back')} variant="outline" onPress={close} />
        </>
      );
    }
  } else if (!profileReady(profile) && !(savedProfile?.secrets_masked && savedProfile.complete) && !companyLater) {
    body = (
      <>
        <AppText variant="title1" accessibilityRole="header">
          {t('kp.company_first_title')}
        </AppText>
        <AppText>{t('kp.company_first_body')}</AppText>
        <Button testID="kp-new-company" label={t('kp.company_fill')} onPress={() => router.push('/company')} />
        <Button testID="kp-new-company-later" label={t('kp.later')} variant="outline" onPress={() => setCompanyLater(true)} />
      </>
    );
  } else if (voice.status === 'listening') {
    body = (
      <>
        <AppText variant="title2">{t('kp.voice_listening')}</AppText>
        <VoiceListening elapsedMs={voice.elapsedMs} level={voice.level} continuing={voice.continuing} kkBeta={false} onDone={() => void voice.finish()} onCancel={() => void voice.cancel()} />
      </>
    );
  } else if (mode === 'text') {
    body = (
      <>
        <AppText variant="title2" accessibilityRole="header">
          {t('kp.text_label')}
        </AppText>
        <TextInput
          testID="kp-new-text"
          accessibilityLabel={t('kp.text_label')}
          value={text}
          onChangeText={setText}
          placeholder={t('kp.text_placeholder')}
          placeholderTextColor={theme.colors.ink2}
          multiline
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={[
            theme.type.body,
            { color: theme.colors.ink, minHeight: 160, borderWidth: 1, borderColor: theme.colors.lineStrong, borderRadius: theme.radius.input, padding: theme.space[3], textAlignVertical: 'top', backgroundColor: theme.colors.surface },
          ]}
        />
        <Button testID="kp-new-text-save" label={t('kp.text_save')} disabled={!text.trim()} onPress={() => void saveText()} />
        <Button testID="kp-new-text-cancel" label={t('kp.voice_cancel')} variant="text" onPress={() => setMode('pick')} />
      </>
    );
  } else if (mode === 'camera_ask') {
    body = (
      <>
        <AppText variant="title1" accessibilityRole="header">
          {t('exp.camera_title')}
        </AppText>
        <AppText testID="kp-new-camera-why">{t('exp.camera_why')}</AppText>
        <Button
          testID="kp-new-camera-allow"
          label={t('exp.camera_allow')}
          onPress={() =>
            void (async () => {
              const p = await getMedia().requestCamera();
              if (p === 'granted') {
                setMode('pick');
                await saveFile(await getMedia().takePhoto(), 'camera');
              } else if (p === 'blocked') getMedia().openSettings();
            })()
          }
        />
        <Button testID="kp-new-camera-gallery" label={t('exp.from_gallery')} variant="outline" onPress={() => { setMode('pick'); void pick('photo'); }} />
      </>
    );
  } else {
    body = (
      <>
        <AppText variant="title1" accessibilityRole="header">
          {t('kp.source_title')}
        </AppText>
        {!online ? (
          <AppText testID="kp-new-offline" color="warnText">
            {t('kp.offline_note')}
          </AppText>
        ) : null}
        <Button testID="kp-new-camera" label={t('kp.source_camera')} disabled={busy} onPress={() => void pick('camera')} />
        <Button testID="kp-new-photo" label={t('kp.source_photo')} variant="outline" disabled={busy} onPress={() => void pick('photo')} />
        <Button testID="kp-new-pdf" label={t('kp.source_pdf')} variant="outline" disabled={busy} onPress={() => void pick('pdf')} />
        <Button testID="kp-new-type" label={t('kp.source_text')} variant="outline" disabled={busy} onPress={() => setMode('text')} />
        <Button testID="kp-new-voice" label={t('kp.source_voice')} variant="outline" disabled={busy} onPress={() => void voice.start()} />
        {voice.status === 'denied' ? (
          <AppText testID="kp-new-voice-denied" color="warnText">
            {t('kp.voice_denied')}
          </AppText>
        ) : null}
      </>
    );
  }

  return (
    <Screen testID="kp-new">
      <View style={{ gap: theme.space[4] }}>
        {header}
        {body}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});

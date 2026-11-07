import {
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { levelFromMetering, VoiceSession, type Fragment, type FragmentRecorder } from './session';

/** AAC-LC mono 16 kHz ~24 kbps (3-engineering §2.1). Stored in the document dir until uploaded. */
export const VOICE_RECORDING_OPTIONS: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 24_000,
  isMeteringEnabled: true,
  directory: 'document',
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.MEDIUM },
  web: { mimeType: 'audio/webm', bitsPerSecond: 24_000 },
};

const TICK_MS = 250;

export type VoiceStatus = 'idle' | 'listening' | 'denied';

/**
 * «Слушаю…» state machine over expo-audio. Mic permission is asked on the first press, not earlier
 * (3-engineering §6.14). `onFinished` receives all ≤3-min fragments in order.
 */
export function useVoiceRecorder(onFinished: (fragments: Fragment[]) => void | Promise<void>) {
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const state = useAudioRecorderState(recorder, TICK_MS);
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [continuing, setContinuing] = useState(false);
  const session = useRef<VoiceSession | null>(null);
  const finishedRef = useRef(onFinished);
  useEffect(() => {
    finishedRef.current = onFinished;
  }, [onFinished]);

  const adapter = useMemo<FragmentRecorder>(
    () => ({
      begin: async () => {
        await recorder.prepareToRecordAsync();
        recorder.record();
      },
      end: async () => {
        await recorder.stop();
        return recorder.uri;
      },
    }),
    [recorder],
  );

  const finish = useCallback(async () => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    const fragments = await s.finish();
    setStatus('idle');
    setElapsedMs(0);
    await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    if (fragments.length > 0) await finishedRef.current(fragments);
  }, []);

  const cancel = useCallback(async () => {
    const s = session.current;
    session.current = null;
    setStatus('idle');
    setElapsedMs(0);
    if (s) await s.cancel();
    await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
  }, []);

  const start = useCallback(async () => {
    if (session.current) return;
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setStatus('denied');
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    const s = new VoiceSession(adapter);
    session.current = s;
    setStatus('listening');
    setContinuing(false);
    await s.start();
  }, [adapter]);

  useEffect(() => {
    if (status !== 'listening') return;
    const timer = setInterval(() => {
      const s = session.current;
      if (!s) return;
      setElapsedMs(s.elapsedMs());
      void s.tick().then((r) => {
        if (r === 'rotated') setContinuing(true);
        if (r === 'limit') void finish();
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [status, finish]);

  useEffect(() => {
    if (!continuing) return;
    const timer = setTimeout(() => setContinuing(false), 4000);
    return () => clearTimeout(timer);
  }, [continuing]);

  // Stop the microphone if the line unmounts mid-recording; fragments recorded so far are kept.
  useEffect(() => () => void finish(), [finish]);

  return {
    status,
    elapsedMs,
    level: levelFromMetering(state.metering),
    /** «Продолжайте — я слушаю дальше» for a few seconds after a 3-min rotation. */
    continuing,
    start,
    finish,
    cancel,
    resetDenied: () => setStatus('idle'),
  };
}
